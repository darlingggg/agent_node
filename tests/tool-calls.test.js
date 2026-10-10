import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs/promises';
import express from 'express';
import jwt from 'jsonwebtoken';
import connection from '../Mysql/index.js';
import {
  createToolCallStore,
  mapToolRow,
  summarizeTools,
  toolResultStatus,
} from '../node/toolCalls.js';
import { chat } from '../node/openai/chat.js';
import { client } from '../node/openai/client.js';
import { functionMap } from '../node/openai/tools/tool-handlers.js';
import chatRouter from '../node/routes/front/chat.js';
import resCC from '../node/middleware/resCC.js';
import { getConversationMessages } from '../node/session/conversations.js';
import {
  cancelChatStream,
  getActiveStream,
  startChatStream,
  subscribeChatStream,
} from '../node/chatStream.js';
import {
  subscribeImageGenerationTask,
  waitForStoredImageGenerationTask,
} from '../node/imageGeneration.js';

after(() => connection.end());

test('失败 JSON 不当作成功；中断后的未完成记录校准终态', () => {
  assert.equal(
    toolResultStatus('{"success":false,"message":"写入失败"}'),
    'failed',
  );
  assert.equal(toolResultStatus('{"success":true}'), 'succeeded');
  const row = {
    tool_call_id: 'a',
    name: 'read',
    status: 'running',
    args_json: '{"path":"a.vue"}',
    started_at: new Date(),
  };
  assert.equal(mapToolRow(row, 'cancelled').status, 'cancelled');
  assert.equal(mapToolRow(row, 'failed').status, 'failed');
  assert.deepEqual(
    summarizeTools([{ status: 'failed' }, { status: 'succeeded' }]),
    { total: 2, running: 0, succeeded: 1, failed: 1, cancelled: 0 },
  );
});

test('已停止的生图等待直接退出，不查询或重新启动生成任务', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    waitForStoredImageGenerationTask({
      taskId: -1,
      account: 'test',
      signal: controller.signal,
    }),
    { name: 'AbortError' },
  );
});

test('模型轮次复用 provider ID 时，UI 记录仍独立，图片绑定 invocation ID', async () => {
  const originalCreate = client.chat.completions.create;
  const originalImage = functionMap.generate_image;
  let requests = 0;
  const events = [];
  try {
    functionMap.generate_image = async (_args, runtime) => {
      assert.equal(runtime.toolCallId, 'provider-reused');
      runtime.onEvent({
        event: 'image_task',
        data: { toolCallId: runtime.invocationId, taskId: requests },
      });
      return '{"success":true}';
    };
    client.chat.completions.create = async () => {
      requests += 1;
      return (async function* () {
        if (requests <= 2)
          yield {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'provider-reused',
                      type: 'function',
                      function: {
                        name: 'generate_image',
                        arguments: '{"prompt":"test"}',
                      },
                    },
                  ],
                },
              },
            ],
          };
        else yield { choices: [{ delta: { content: '完成' } }] };
      })();
    };
    await chat(
      '生成图片',
      (event) => events.push(event),
      [{ role: 'system', content: 'test' }],
      'C:/test',
      [],
      '',
      { modelConfig: { model: 'test', contextLimit: 8192 } },
    );
    const starts = events.filter((event) => event.event === 'tool_start');
    assert.equal(starts.length, 2);
    assert.notEqual(starts[0].data.toolCallId, starts[1].data.toolCallId);
    assert.deepEqual(
      events
        .filter((event) => event.event === 'image_task')
        .map((event) => event.data.toolCallId),
      starts.map((event) => event.data.toolCallId),
    );
  } finally {
    client.chat.completions.create = originalCreate;
    functionMap.generate_image = originalImage;
  }
});

test('同名工具并行乱序完成：开始参数、结果与调用 ID 精确对应', async () => {
  const originalCreate = client.chat.completions.create;
  const originalRead = functionMap.get_file_content;
  let requests = 0;
  const events = [];
  try {
    functionMap.get_file_content = async (args) => {
      if (args.path === 'a.vue')
        await new Promise((resolve) => setTimeout(resolve, 15));
      return JSON.stringify({
        success: args.path === 'a.vue',
        data: args.path,
        message: args.path === 'b.vue' ? '读取失败' : '完成',
      });
    };
    client.chat.completions.create = async () => {
      requests += 1;
      return (async function* () {
        if (requests === 1)
          yield {
            choices: [
              {
                delta: {
                  tool_calls: ['a', 'b'].map((name, index) => ({
                    index,
                    id: `call-${name}`,
                    type: 'function',
                    function: {
                      name: 'get_file_content',
                      arguments: JSON.stringify({
                        path: `${name}.vue`,
                        dirPath: '.',
                      }),
                    },
                  })),
                },
              },
            ],
          };
        else yield { choices: [{ delta: { content: '完成' } }] };
      })();
    };
    await chat(
      '读取文件',
      (event) => events.push(event),
      [{ role: 'system', content: 'test' }],
      'C:/test',
      [],
      '',
      { modelConfig: { model: 'test', contextLimit: 8192 } },
    );
    const starts = events.filter((event) => event.event === 'tool_start');
    const ends = events.filter((event) => event.event === 'tool_end');
    assert.deepEqual(
      starts.map((event) => event.data.args.path),
      ['a.vue', 'b.vue'],
    );
    assert.equal(new Set(starts.map((event) => event.data.toolCallId)).size, 2);
    assert.deepEqual(
      ends.map((event) => [
        event.data.toolCallId,
        event.data.result.data,
        event.data.status,
      ]),
      [
        [starts[1].data.toolCallId, 'b.vue', 'failed'],
        [starts[0].data.toolCallId, 'a.vue', 'succeeded'],
      ],
    );
    assert.ok(ends.every((event) => event.data.durationMs >= 0));
  } finally {
    client.chat.completions.create = originalCreate;
    functionMap.get_file_content = originalRead;
  }
});

test(
  '真实 MySQL 临时表与 HTTP：持久化、幂等、权限、历史摘要与详情',
  { skip: process.env.TOOL_CALLS_DB_TEST !== '1' },
  async () => {
    const db = await connection.getConnection();
    const originalQuery = connection.query;
    let server;
    try {
      // 连接独享的临时表遮蔽同名表，不修改实际项目数据或部署迁移。
      for (const table of [
        'users',
        'projects',
        'conversations',
        'sessions',
        'messages',
      ]) {
        const [[schema]] = await db.query(`SHOW CREATE TABLE ${table}`);
        await db.query(
          schema['Create Table'].replace(
            'CREATE TABLE',
            'CREATE TEMPORARY TABLE',
          ),
        );
      }
      const source = await fs.readFile(
        new URL('../Mysql/tool-calls.sql', import.meta.url),
        'utf8',
      );
      const sql = source
        .replace(/^--.*$/gm, '')
        .replace('CREATE TABLE', 'CREATE TEMPORARY TABLE');
      await db.query(sql);
      await db.query(sql);
      await db.query(
        'CREATE TEMPORARY TABLE ai_generated_images (id INT, account VARCHAR(50), assistant_session_id INT, status VARCHAR(20))',
      );
      await db.query(
        "INSERT INTO users (id,account,password,nickname,role,storage_key) VALUES (9998001,'tool-owner','test','测试用户','normal','tool-owner'),(9998002,'tool-other','test','其他用户','normal','tool-other')",
      );
      await db.query(
        "INSERT INTO projects(id,account,dir_path,title,`desc`) VALUES(9998001,'tool-owner','test','测试项目','')",
      );
      await db.query(
        "INSERT INTO conversations(id,account,project_id,title) VALUES(9998001,'tool-owner',9998001,'工具测试')",
      );
      await db.query(
        "INSERT INTO messages(id,content) VALUES(9998001,'开始。完成。')",
      );
      await db.query(
        "INSERT INTO sessions(id,message_id,project_id,conversation_id,account,title,role,status) VALUES(9998001,9998001,9998001,9998001,'tool-owner','工具测试','assistant','completed')",
      );
      const store = createToolCallStore(db);
      const base = {
        name: 'get_file_content',
        args: { path: 'a.vue' },
        sequence: 1,
        textOffset: 3,
        status: 'running',
        startedAt: '2026-10-10T08:00:00.123Z',
      };
      await store.save(9998001, { ...base, toolCallId: 'call-a' });
      await store.save(9998001, {
        ...base,
        sequence: 2,
        args: { path: 'b.vue' },
        toolCallId: 'call-b',
      });
      await store.save(9998001, {
        ...base,
        sequence: 2,
        args: { path: 'b.vue' },
        toolCallId: 'call-b',
        status: 'failed',
        result: { success: false },
        error: '读取失败',
        finishedAt: '2026-10-10T08:00:01.123Z',
        durationMs: 1000,
      });
      await store.save(9998001, {
        ...base,
        toolCallId: 'call-a',
        status: 'succeeded',
        result: { content: 'A 文件' },
        finishedAt: '2026-10-10T08:00:02.123Z',
        durationMs: 2000,
      });
      // 再消费同一终态不会新增记录。
      await store.save(9998001, {
        ...base,
        toolCallId: 'call-a',
        status: 'succeeded',
        result: { content: 'A 文件' },
      });
      const { tools } = await store.list(9998001, 'tool-owner');
      assert.deepEqual(
        tools.map((tool) => [tool.toolCallId, tool.args.path, tool.status]),
        [
          ['call-a', 'a.vue', 'succeeded'],
          ['call-b', 'b.vue', 'failed'],
        ],
      );
      assert.deepEqual(tools[0].result, { content: 'A 文件' });
      const summaries = await store.summaries([9998001], 'tool-owner');
      assert.equal(summaries.get(9998001).failed, 1);
      assert.equal((await store.summaries([9998001], 'tool-other')).size, 0);
      await assert.rejects(store.list(9998001, 'tool-other'), /无权/);
      connection.query = (...args) => db.query(...args);
      const history = await getConversationMessages(
        { conversationId: 9998001 },
        { account: 'tool-owner' },
      );
      assert.equal(history.list[0].tool_summary.total, 2);
      assert.equal(history.list[0].tool_summary.failed, 1);
      const app = express();
      app.use(express.json(), resCC, chatRouter);
      server = await new Promise((resolve) => {
        const value = app.listen(0, '127.0.0.1', () => resolve(value));
      });
      const url = `http://127.0.0.1:${server.address().port}/chat/messages/9998001/tools`;
      assert.equal((await fetch(url)).status, 401);
      const get = async (id) =>
        (
          await fetch(url, {
            headers: {
              Authorization: `Bearer ${jwt.sign({ id }, process.env.JWT_SECRET || 'agentNode_dev_secret')}`,
            },
          })
        ).json();
      const owner = await get(9998001);
      assert.equal(owner.status, 0);
      assert.equal(owner.data.summary.total, 2);
      assert.equal(owner.data.tools[0].args.path, 'a.vue');
      assert.equal((await get(9998002)).status, 1);
      await db.query("INSERT INTO messages(id,content) VALUES(9998002,'')");
      await db.query(
        "INSERT INTO sessions(id,message_id,project_id,conversation_id,account,title,role,status) VALUES(9998002,9998002,9998001,9998001,'tool-owner','工具测试','assistant','streaming')",
      );
      let finish;
      const gate = new Promise((resolve) => {
        finish = resolve;
      });
      const state = startChatStream({
        messageId: 9998002,
        sessionId: 9998002,
        run: async (send) => {
          send({ event: 'text', data: '先看。' });
          send({
            event: 'tool_start',
            data: { ...base, toolCallId: 'snapshot-call' },
          });
          await gate;
          send({
            event: 'tool_end',
            data: {
              toolCallId: 'snapshot-call',
              name: base.name,
              status: 'succeeded',
              result: { success: true },
              finishedAt: new Date().toISOString(),
            },
          });
          send({ event: 'text', data: '完成。' });
          return {};
        },
      });
      await new Promise((resolve) => setImmediate(resolve));
      const received = [];
      const response = {
        writableEnded: false,
        write(value) {
          received.push(JSON.parse(value.slice(6)));
        },
        on() {},
        end() {
          this.writableEnded = true;
        },
      };
      await subscribeChatStream({
        messageId: 9998002,
        account: 'tool-owner',
        res: response,
      });
      assert.equal(received[0].event, 'tool_snapshot');
      assert.equal(received[0].data.tools[0].textOffset, 3);
      assert.equal(received[1].data, '先看。');
      finish();
      await state.completion;
      assert.equal(getActiveStream(9998002), undefined);
      assert.equal(received.at(-1).event, 'done');
      assert.equal(
        (await store.list(9998002, 'tool-owner')).tools[0].status,
        'succeeded',
      );
      await db.query("INSERT INTO messages(id,content) VALUES(9998003,'')");
      await db.query(
        "INSERT INTO sessions(id,message_id,project_id,conversation_id,account,title,role,status) VALUES(9998003,9998003,9998001,9998001,'tool-owner','工具测试','assistant','streaming')",
      );
      const stopped = startChatStream({
        messageId: 9998003,
        sessionId: 9998003,
        run: async (send, signal) => {
          send({
            event: 'tool_start',
            data: { ...base, toolCallId: 'cancel-call' },
          });
          await new Promise((_, reject) =>
            signal.addEventListener(
              'abort',
              () => reject(new DOMException('停止', 'AbortError')),
              { once: true },
            ),
          );
        },
      });
      await new Promise((resolve) => setImmediate(resolve));
      await cancelChatStream({ messageId: 9998003, account: 'tool-owner' });
      await stopped.completion;
      assert.equal(
        (await store.list(9998003, 'tool-owner')).tools[0].status,
        'cancelled',
      );
      await db.query(
        "INSERT INTO ai_generated_images(id,account,assistant_session_id,status) VALUES(9998001,'tool-owner',9998001,'queued')",
      );
      const imageEvents = [];
      const imageResponse = {
        writableEnded: false,
        write(value) {
          imageEvents.push(JSON.parse(value.slice(6)));
        },
        end() {
          this.writableEnded = true;
        },
      };
      await subscribeImageGenerationTask({
        taskId: 9998001,
        account: 'tool-owner',
        observeOnly: true,
        res: imageResponse,
      });
      assert.equal(imageEvents.at(-1).event, 'observation_error');
      assert.equal(imageResponse.writableEnded, true);
      const [[imageRow]] = await db.query(
        'SELECT status FROM ai_generated_images WHERE id=9998001',
      );
      assert.equal(imageRow.status, 'queued');
    } finally {
      if (server) await new Promise((resolve) => server.close(resolve));
      connection.query = originalQuery;
      for (const table of [
        'message_tool_calls',
        'ai_generated_images',
        'users',
        'projects',
        'conversations',
        'sessions',
        'messages',
      ])
        await db.query(`DROP TEMPORARY TABLE IF EXISTS ${table}`);
      db.release();
    }
  },
);
