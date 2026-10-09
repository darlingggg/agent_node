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
      assert.ok(context.every((message) => !message.tool_calls && message.role !== 'tool'));
    }
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
