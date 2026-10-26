import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import connection from '../Mysql/index.js';
import { modelRequestOptions, normalizeModel, resolveModelConfig } from '../node/models/config.js';
import { nextModelSyncTime } from '../node/models/scheduler.js';
import { setDefaultModel, setModelAvailability, syncModels } from '../node/models/service.js';

after(() => connection.end());

test('模型元数据保留能力，默认强度及用户选择从服务商配置解析', () => {
  const model = normalizeModel({
    id: 'model-a',
    name: '模型 A',
    context_window: 8192,
    effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' },
  });
  const row = { model_key: model.modelKey, ...model };
  assert.deepEqual(resolveModelConfig(row), {
    model: 'model-a',
    reasoningEffort: 'high',
    contextLimit: 8192,
  });
  assert.equal(resolveModelConfig(row, 'max').reasoningEffort, 'max');
  assert.throws(() => resolveModelConfig(row, 'medium'), /不支持/);
  assert.deepEqual(modelRequestOptions(resolveModelConfig(row)), {
    model: 'model-a',
    reasoning_effort: 'high',
  });
});

test('缺少、null、空 effort 时完全省略请求强度字段', () => {
  for (const effort of [
    undefined,
    null,
    '',
    '  ',
    [],
    {},
    { supported_levels: [] },
    'null',
    '{}',
  ]) {
    const normalized = normalizeModel({ id: 'model-b', effort });
    const config = resolveModelConfig({ model_key: normalized.modelKey, ...normalized }, 'max');
    assert.deepEqual(modelRequestOptions(config), { model: 'model-b' });
    assert.equal(config.reasoningEffort, null);
  }
  assert.throws(() => normalizeModel({ id: '' }), /无效/);
  assert.throws(() => normalizeModel({ id: 'a', effort: { supported_levels: [null] } }), /无效/);
});

test('每日北京时间 04:00：跨日、月末和临界时间计算正确', () => {
  for (const [now, next] of [
    ['2026-10-08T19:59:59Z', '2026-10-08T20:00:00.000Z'],
    ['2026-10-08T20:00:00Z', '2026-10-09T20:00:00.000Z'],
    ['2026-10-09T01:00:00Z', '2026-10-09T20:00:00.000Z'],
    ['2026-12-31T21:00:00Z', '2027-01-01T20:00:00.000Z'],
  ])
    assert.equal(nextModelSyncTime(new Date(now)).toISOString(), next);
});

test(
  '真实 MySQL 临时表：同步更新、失效禁用、恢复启用、分页失败及写入失败回滚',
  {
    skip: process.env.AI_MODELS_DB_TEST !== '1',
  },
  async () => {
    const db = await connection.getConnection();
    try {
      // 临时表仅对当前连接可见，避免测试修改真实模型目录。
      const [[schema]] = await db.query('SHOW CREATE TABLE ai_models');
      await db.query(schema['Create Table'].replace('CREATE TABLE', 'CREATE TEMPORARY TABLE'));
      const pool = {
        getConnection: async () => ({
          query: (...args) => db.query(...args),
          beginTransaction: () => db.beginTransaction(),
          commit: () => db.commit(),
          rollback: () => db.rollback(),
          release() {},
        }),
      };
      const sync = (models) => syncModels({ pool, loadModels: async () => models });
      const snapshot = async () =>
        (
          await db.query(
            'SELECT model_key, model_name, enabled, effort, is_default FROM ai_models ORDER BY model_key',
          )
        )[0];
      await sync([
        { id: 'a', name: 'A' },
        { id: 'b', effort: { supported_levels: ['high'], default_level: 'high' } },
      ]);
      const result = await sync([{ id: 'b', name: 'B updated' }, { id: 'c' }]);
      assert.equal(result.disabled, 1);
      let rows = await snapshot();
      assert.deepEqual(
        rows.map((row) => [row.model_key, row.enabled]),
        [
          ['a', 0],
          ['b', 1],
          ['c', 1],
        ],
      );
      assert.equal(rows[1].model_name, 'B updated');
      assert.equal(rows[1].effort, null);
      assert.equal(rows[1].is_default, 1);
      assert.equal(rows[0].is_default, 0);
      await sync([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
      rows = await snapshot();
      assert.equal(rows[0].enabled, 1);
      await assert.rejects(
        syncModels({
          pool,
          loadModels: async () =>
            (async function* () {
              yield { id: 'partial' };
              throw new Error('page failed');
            })(),
        }),
        /page failed/,
      );
      assert.deepEqual(await snapshot(), rows);
      await assert.rejects(sync([{ id: '' }]), /无效/);
      assert.deepEqual(await snapshot(), rows);
      const failingPool = {
        getConnection: async () => {
          const wrapped = await pool.getConnection();
          return {
            ...wrapped,
            query: (sql, params) => {
              if (sql.startsWith('UPDATE ai_models')) throw new Error('database write failed');
              return wrapped.query(sql, params);
            },
          };
        },
      };
      await assert.rejects(
        syncModels({ pool: failingPool, loadModels: async () => [{ id: 'new' }] }),
        /write failed/,
      );
      assert.deepEqual(await snapshot(), rows);
      await setDefaultModel('c', { pool });
      assert.equal((await snapshot()).find((row) => row.model_key === 'c').is_default, 1);
      await sync([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
      assert.equal((await snapshot()).find((row) => row.model_key === 'c').is_default, 1);
      await sync([{ id: 'a' }, { id: 'b' }]);
      const fallback = await snapshot();
      assert.equal(fallback.find((row) => row.model_key === 'a').is_default, 1);
      assert.equal(fallback.find((row) => row.model_key === 'c').is_default, 0);
      await assert.rejects(setDefaultModel('c', { pool }), /失效/);
      assert.deepEqual(await snapshot(), fallback);
      // 管理员禁用与目录同步互不覆盖，默认模型始终指向可用模型。
      await setModelAvailability('a', false, { pool });
      assert.equal((await snapshot()).find((row) => row.model_key === 'b').is_default, 1);
      await sync([{ id: 'a' }, { id: 'b' }]);
      assert.equal((await snapshot()).find((row) => row.model_key === 'a').enabled, 0);
      await assert.rejects(setDefaultModel('a', { pool }), /失效/);
      await assert.rejects(setModelAvailability('c', true, { pool }), /下线/);
      await assert.rejects(setModelAvailability('a', 1, { pool }), /布尔/);
      await assert.rejects(setModelAvailability('unknown', false, { pool }), /不存在/);
      await setModelAvailability('a', true, { pool });
      assert.equal((await snapshot()).find((row) => row.model_key === 'a').enabled, 1);
      await setModelAvailability('a', false, { pool });
      await setModelAvailability('b', false, { pool });
      assert.ok((await snapshot()).every((row) => row.enabled === 0 && row.is_default === 0));
      await sync([{ id: 'a' }, { id: 'b' }]);
      assert.ok((await snapshot()).every((row) => row.enabled === 0 && row.is_default === 0));
      await setModelAvailability('a', true, { pool });
      await setModelAvailability('b', true, { pool });
      const empty = await sync([]);
      assert.equal(empty.disabled, 2);
      assert.ok((await snapshot()).every((row) => row.enabled === 0 && row.is_default === 0));
    } finally {
      await db.query('DROP TEMPORARY TABLE IF EXISTS ai_models');
      db.release();
    }
  },
);
