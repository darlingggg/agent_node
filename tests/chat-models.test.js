import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chat } from '../node/openai/chat.js';
import { client } from '../node/openai/client.js';
import { compressContext } from '../node/openai/context/context-compression.js';
import { createUsageTracker } from '../node/openai/context/usage.js';
import { functionMap } from '../node/openai/tools/tool-handlers.js';

test('动态模型及强度贯穿工具循环，并传回推理内容；无 effort 时不配置', async () => {
  const originalCreate = client.chat.completions.create;
  const originalTool = functionMap.get_file_list;
  try {
    for (const reasoningEffort of ['max', null]) {
      const requests = [];
      functionMap.get_file_list = async () => '工具结果';
      client.chat.completions.create = async (request) => {
        requests.push(request);
        return (async function* () {
          if (requests.length === 1)
            yield {
              choices: [
                {
                  delta: {
                    reasoning_content: '需要查看项目',
                    tool_calls: [
                      {
                        index: 0,
                        id: 'tool-1',
                        type: 'function',
                        function: { name: 'get_file_list', arguments: '{}' },
                      },
                    ],
                  },
                },
              ],
            };
          else yield { choices: [{ delta: { content: '完成' } }] };
        })();
      };
      const context = [{ role: 'system', content: 'test' }];
      const result = await chat('查看项目', () => {}, context, '', [], '', {
        modelConfig: { model: 'dynamic-model', reasoningEffort, contextLimit: 8192 },
      });
      assert.equal(requests.length, 2);
      for (const request of requests) {
        assert.equal(request.model, 'dynamic-model');
        if (reasoningEffort) assert.equal(request.reasoning_effort, reasoningEffort);
        else assert.equal(Object.hasOwn(request, 'reasoning_effort'), false);
      }
      assert.equal(
        requests[1].messages.find((message) => message.tool_calls)?.reasoning_content,
        '需要查看项目',
      );
      assert.equal(result.contextLimit, 8192);
      assert.equal(context.at(-1).content, '完成');
      assert.equal(context.find((item) => item.role === 'tool')?.content, '工具结果');
      assert.equal(context.find((item) => item.tool_calls)?.tool_calls[0].id, 'tool-1');
    }
  } finally {
    client.chat.completions.create = originalCreate;
    functionMap.get_file_list = originalTool;
  }
});

test('连续对话保留最近一次工具轮次，直到下一轮工具结果进入', async () => {
  const originalCreate = client.chat.completions.create;
  const originalTool = functionMap.get_file_list;
  const requests = [];
  try {
    functionMap.get_file_list = async (_args, runtime) => `结果-${runtime.toolCallId}`;
    client.chat.completions.create = async (request) => {
      requests.push(request);
      const id = ({ 1: 'first-a', 2: 'first-b', 5: 'third' })[requests.length];
      return (async function* () {
        if (id) {
          yield {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id,
                  type: 'function',
                  function: { name: 'get_file_list', arguments: '{}' },
                }],
              },
            }],
          };
        } else {
          yield { choices: [{ delta: { content: `回复-${requests.length}` } }] };
        }
      })();
    };

    const context = [{ role: 'system', content: 'test' }];
    const options = { modelConfig: { model: 'dynamic-model', contextLimit: 8192 } };
    const toolIds = () => context.filter((item) => item.role === 'tool').map((item) => item.tool_call_id);

    await chat('第一轮', () => {}, context, '', [], '', options);
    assert.deepEqual(toolIds(), ['first-a', 'first-b']);
    assert.deepEqual(
      requests[2].messages.filter((item) => item.role === 'tool').map((item) => item.tool_call_id),
      ['first-a', 'first-b'],
    );

    await chat('第二轮', () => {}, context, '', [], '', options);
    assert.deepEqual(toolIds(), ['first-a', 'first-b']);
    assert.deepEqual(
      requests[3].messages.filter((item) => item.role === 'tool').map((item) => item.tool_call_id),
      ['first-a', 'first-b'],
    );

    await chat('第三轮', () => {}, context, '', [], '', options);
    assert.deepEqual(
      requests[4].messages.filter((item) => item.role === 'tool').map((item) => item.tool_call_id),
      ['first-a', 'first-b'],
    );
    assert.deepEqual(
      requests[5].messages.filter((item) => item.role === 'tool').map((item) => item.tool_call_id),
      ['third'],
    );
    assert.deepEqual(toolIds(), ['third']);
    assert.deepEqual(
      context.filter((item) => item.tool_calls).flatMap((item) => item.tool_calls.map((call) => call.id)),
      ['third'],
    );

    await chat('第四轮', () => {}, context, '', [], '', options);
    assert.deepEqual(toolIds(), ['third']);
    assert.deepEqual(
      requests[6].messages.filter((item) => item.role === 'tool').map((item) => item.tool_call_id),
      ['third'],
    );
  } finally {
    client.chat.completions.create = originalCreate;
    functionMap.get_file_list = originalTool;
  }
});

test('工具调用中断后移除未配对调用，并保留上一轮结果', async () => {
  const originalCreate = client.chat.completions.create;
  const originalTool = functionMap.get_file_list;
  const controller = new AbortController();
  let requestCount = 0;
  try {
    functionMap.get_file_list = async (_args, runtime) => {
      if (runtime.toolCallId === 'interrupted') controller.abort();
      return `结果-${runtime.toolCallId}`;
    };
    client.chat.completions.create = async () => {
      requestCount += 1;
      const id = requestCount === 1 ? 'completed' : requestCount === 3 ? 'interrupted' : null;
      return (async function* () {
        if (id) {
          yield {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id,
                  type: 'function',
                  function: { name: 'get_file_list', arguments: '{}' },
                }],
              },
            }],
          };
        } else {
          yield { choices: [{ delta: { content: '完成' } }] };
        }
      })();
    };

    const context = [{ role: 'system', content: 'test' }];
    const modelConfig = { model: 'dynamic-model', contextLimit: 8192 };
    await chat('第一轮', () => {}, context, '', [], '', { modelConfig });
    await assert.rejects(
      chat('第二轮', () => {}, context, '', [], '', { modelConfig, signal: controller.signal }),
      { name: 'AbortError' },
    );
    assert.deepEqual(
      context.filter((item) => item.role === 'tool').map((item) => item.tool_call_id),
      ['completed'],
    );
    assert.deepEqual(
      context.filter((item) => item.tool_calls).flatMap((item) => item.tool_calls.map((call) => call.id)),
      ['completed'],
    );
  } finally {
    client.chat.completions.create = originalCreate;
    functionMap.get_file_list = originalTool;
  }
});

test('上下文压缩使用当前模型、强度和模型上下文上限', async () => {
  const original = client.chat.completions.create;
  try {
    let request;
    client.chat.completions.create = async (body) => {
      request = body;
      return { choices: [{ message: { content: '压缩摘要' } }] };
    };
    const context = [{ role: 'system', content: 'system' }];
    for (let index = 0; index < 8; index++) {
      context.push({
        role: 'user',
        content: Array.from({ length: 350 }, (_, word) => `${index}-${word}`).join(' '),
        _sessionId: index + 1,
      });
      context.push({ role: 'assistant', content: '已处理' });
    }
    const tracker = createUsageTracker(context);
    await compressContext(context, tracker, null, () => {}, {
      model: 'smaller-context-model',
      reasoningEffort: 'low',
      contextLimit: 4096,
    });
    assert.equal(request.model, 'smaller-context-model');
    assert.equal(request.reasoning_effort, 'low');
    assert.equal(tracker.compressed, true);
    assert.equal(context[1]._isSummary, true);
  } finally {
    client.chat.completions.create = original;
  }
});
