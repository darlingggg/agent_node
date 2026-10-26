import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import jwt from 'jsonwebtoken';
import connection from '../Mysql/index.js';
import resCC from '../node/middleware/resCC.js';
import frontRouter from '../node/routes/front.js';
import adminRouter from '../node/routes/admin.js';
import { client } from '../node/openai/client.js';
import { createStreamingAssistantSession, createUserChatSession } from '../node/session/records.js';
import { getConversationMessages, saveConversationModel } from '../node/session/conversations.js';
import { selectChatModel } from '../node/models/service.js';

test(
  '真实路由与隔离数据库：鉴权、模型同步、可用列表、会话选择与每轮配置保存',
  {
    skip: process.env.AI_MODELS_DB_TEST !== '1',
  },
  async () => {
    const db = await connection.getConnection();
    const originalQuery = connection.query;
    const originalGetConnection = connection.getConnection;
    const originalModelsList = client.models.list;
    let server;
    try {
      // 所有写入使用连接独享的临时表，测试结束自动销毁。
      for (const table of ['ai_models', 'users', 'conversations', 'sessions', 'messages']) {
        const [[schema]] = await db.query(`SHOW CREATE TABLE ${table}`);
        await db.query(schema['Create Table'].replace('CREATE TABLE', 'CREATE TEMPORARY TABLE'));
      }
      await db.query(
        `INSERT INTO users (id, account, password, nickname, role, storage_key)
       VALUES (9999001, 'model-test-admin', 'test-only', '测试管理员', 'admin', 'model-test-admin'),
              (9999002, 'model-test-user', 'test-only', '测试用户', 'normal', 'model-test-user')`,
      );
      connection.query = (...args) => db.query(...args);
      connection.getConnection = async () => ({
        query: (...args) => db.query(...args),
        beginTransaction: () => db.beginTransaction(),
        commit: () => db.commit(),
        rollback: () => db.rollback(),
        release() {},
      });
      client.models.list = async () => [
        {
          id: 'model-test-a',
          name: '模型 A',
          context_window: 8192,
          effort: { supported_levels: ['low', 'high'], default_level: 'high' },
        },
        { id: 'model-test-b', name: '模型 B', effort: null },
      ];
      const app = express();
      app.use(express.json(), resCC, frontRouter);
      app.use('/admin', adminRouter);
      server = await new Promise((resolve) => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
      });
      const base = `http://127.0.0.1:${server.address().port}`;
      const adminToken = jwt.sign(
        { id: 9999001 },
        process.env.JWT_SECRET || 'agentNode_dev_secret',
      );
      const userToken = jwt.sign({ id: 9999002 }, process.env.JWT_SECRET || 'agentNode_dev_secret');
      const request = (path, token, method = 'GET') =>
        fetch(base + path, {
          method,
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
      assert.equal((await request('/models')).status, 401);
      assert.equal((await request('/admin/models/sync', userToken, 'POST')).status, 403);
      const synced = await (await request('/admin/models/sync', adminToken, 'POST')).json();
      assert.equal(synced.status, 0);
      assert.equal(synced.data.synced, 2);
      const setDefault = (token, model) =>
        fetch(base + '/admin/models/default', {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model }),
        });
      assert.equal((await setDefault(userToken, 'model-test-b')).status, 403);
      assert.equal((await (await setDefault(adminToken, undefined)).json()).status, 1);
      assert.equal((await selectChatModel({})).model, 'model-test-a');
      const changedDefault = await (await setDefault(adminToken, 'model-test-b')).json();
      assert.equal(changedDefault.status, 0);
      assert.equal((await selectChatModel({})).model, 'model-test-b');
      const availability = (token, model, enabled) => fetch(base + '/admin/models/availability', {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, enabled }),
      });
      assert.equal((await availability(userToken, 'model-test-b', false)).status, 403);
      assert.equal((await availability(null, 'model-test-b', false)).status, 401);
      assert.equal((await (await availability(adminToken, 'unknown', false)).json()).status, 1);
      assert.equal((await (await availability(adminToken, 'model-test-b', 'false')).json()).status, 1);
      const disabledModel = await (await availability(adminToken, 'model-test-b', false)).json();
      assert.equal(disabledModel.status, 0);
      assert.equal(disabledModel.data.defaultModel, 'model-test-a');
      assert.deepEqual((await (await request('/models', userToken)).json()).data.map((model) => model.modelKey), ['model-test-a']);
      await request('/admin/models/sync', adminToken, 'POST');
      const persisted = (await (await request('/admin/models', adminToken)).json()).data.list.find((model) => model.modelKey === 'model-test-b');
      assert.equal(persisted.enabled, 0);
      assert.equal(persisted.manualDisabled, 1);
      assert.equal((await (await availability(adminToken, 'model-test-b', true)).json()).status, 0);
      await setDefault(adminToken, 'model-test-b');
      await assert.rejects(
        db.query("UPDATE ai_models SET is_default = 1 WHERE model_key = 'model-test-a'"),
        { code: 'ER_DUP_ENTRY' },
      );
      assert.equal((await (await setDefault(adminToken, 'unknown')).json()).status, 1);
      assert.equal((await selectChatModel({})).model, 'model-test-b');
      await db.query("UPDATE ai_models SET enabled = 0 WHERE model_key = 'model-test-b'");
      assert.equal((await (await setDefault(adminToken, 'model-test-b')).json()).status, 1);
      const available = await (await request('/models', userToken)).json();
      assert.deepEqual(
        available.data.map((model) => model.modelKey),
        ['model-test-a'],
      );
      assert.equal(available.data[0].effort.defaultLevel, 'high');
      assert.deepEqual(available.data[0].effort.supportedLevels, ['low', 'high']);
      const adminList = await (await request('/admin/models', adminToken)).json();
      assert.equal(adminList.data.list.length, 2);
      assert.ok(adminList.data.nextSyncAt);
      const user = { account: 'model-test-user' };
      const [inserted] = await db.query(
        'INSERT INTO conversations (account, project_id, title) VALUES (?, ?, ?)',
        [user.account, 9999001, '配置测试'],
      );
      const conversationId = inserted.insertId;
      await assert.rejects(selectChatModel({ model: 'model-test-b' }), /失效/);
      await assert.rejects(selectChatModel({ model: 'unknown' }), /不存在/);
      const config = await selectChatModel({ model: 'model-test-a', reasoningEffort: 'low' });
      await saveConversationModel(conversationId, config, user);
      await createUserChatSession(
        { title: '配置测试', projectId: 9999001, content: 'hello', conversationId, ...config },
        user,
      );
      await createStreamingAssistantSession(
        { title: '配置测试', projectId: 9999001, conversationId, ...config },
        user,
      );
      const saved = await getConversationMessages({ conversationId }, user);
      assert.equal(saved.conversation.model, 'model-test-a');
      assert.equal(saved.conversation.reasoning_effort, 'low');
      assert.equal((await selectChatModel({}, saved.conversation)).reasoningEffort, 'low');
      assert.equal((await selectChatModel({}, saved.conversation)).model, 'model-test-a');
      assert.ok(
        saved.list.every(
          (message) => message.model === 'model-test-a' && message.reasoning_effort === 'low',
        ),
      );
      const restored = await (
        await request(`/conversation/${conversationId}/messages`, userToken)
      ).json();
      assert.equal(restored.data.conversation.model, 'model-test-a');
      assert.equal(restored.data.conversation.reasoningEffort, 'low');
      await db.query("UPDATE ai_models SET enabled = 1 WHERE model_key = 'model-test-b'");
      const switched = await selectChatModel(
        { model: 'model-test-b', reasoningEffort: 'high' },
        saved.conversation,
      );
      await saveConversationModel(conversationId, switched, user);
      await createStreamingAssistantSession(
        { title: '配置测试', projectId: 9999001, conversationId, ...switched },
        user,
      );
      const updated = await getConversationMessages({ conversationId }, user);
      assert.equal(updated.conversation.model, 'model-test-b');
      assert.equal(updated.conversation.reasoning_effort, null);
      assert.equal(updated.list.at(-1).model, 'model-test-b');
      assert.equal(updated.list[0].model, 'model-test-a');
      await assert.rejects(
        saveConversationModel(conversationId, config, { account: 'wrong-owner' }),
        /无权/,
      );
    } finally {
      if (server) await new Promise((resolve) => server.close(resolve));
      connection.query = originalQuery;
      connection.getConnection = originalGetConnection;
      client.models.list = originalModelsList;
      db.release();
      await connection.end();
    }
  },
);
