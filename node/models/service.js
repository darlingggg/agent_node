import connection from '../../Mysql/index.js';
import { client } from '../openai/client.js';
import { normalizeModel, parseModelJson, resolveModelConfig } from './config.js';

const SYNC_LOCK = 'gameAgent:ai-models-sync';

export async function listModels({ includeDisabled = false } = {}) {
  const [rows] = await connection.query(
    `SELECT id, model_key, model_name, capabilities, effort, enabled, manual_disabled, provider_available, is_default, created_at, updated_at
       FROM ai_models ${includeDisabled ? '' : 'WHERE enabled = 1'} ORDER BY id`,
  );
  return rows.map((row) => ({
    ...row,
    capabilities: parseModelJson(row.capabilities),
    effort: parseModelJson(row.effort),
  }));
}

export async function selectChatModel({ model, reasoningEffort } = {}, conversation = {}) {
  const models = await listModels();
  if (!models.length) throw new Error('暂无可用模型，请联系管理员同步模型');
  if (model !== undefined && (typeof model !== 'string' || !model.trim())) {
    throw new Error('模型标识不能为空');
  }
  const preferred = model || conversation.model;
  let selected = models.find((item) => item.model_key === preferred);
  if (model && !selected) throw new Error('所选模型不存在或已失效，请重新选择');
  selected ||= models.find((item) => Number(item.is_default) === 1) || models[0];
  const storedEffort =
    selected.model_key === conversation.model ? conversation.reasoning_effort : null;
  const supported = parseModelJson(selected.effort)?.supported_levels || [];
  return resolveModelConfig(
    selected,
    reasoningEffort !== undefined
      ? reasoningEffort
      : supported.includes(storedEffort)
        ? storedEffort
        : null,
  );
}

/** 同步后保留有效默认值；默认失效或初次同步时选取可用模型。 */
async function ensureDefaultModel(db) {
  const [models] = await db.query(
    'SELECT id, is_default FROM ai_models WHERE enabled = 1 ORDER BY is_default DESC, id',
  );
  if (models.some((model) => Number(model.is_default) === 1)) return;
  await db.query('UPDATE ai_models SET is_default = 0 WHERE is_default = 1');
  if (models.length)
    await db.query('UPDATE ai_models SET is_default = 1 WHERE id = ?', [models[0].id]);
}

/** 人工开关与服务商可用性分别保存，目录同步不会覆盖管理员设置。 */
export async function setModelAvailability(modelKey, enabled, { pool = connection } = {}) {
  if (typeof modelKey !== 'string' || !modelKey.trim()) throw new Error('模型标识不能为空');
  if (typeof enabled !== 'boolean') throw new Error('enabled 必须是布尔值');
  const db = await pool.getConnection();
  let locked = false;
  let inTransaction = false;
  try {
    const [[lock]] = await db.query('SELECT GET_LOCK(?, 0) AS acquired', [SYNC_LOCK]);
    locked = Number(lock.acquired) === 1;
    if (!locked) throw new Error('模型配置正在更新，请稍后重试');
    await db.beginTransaction();
    inTransaction = true;
    const [models] = await db.query(
      'SELECT id, provider_available FROM ai_models WHERE model_key = ? LIMIT 1 FOR UPDATE',
      [modelKey],
    );
    if (!models.length) throw new Error('模型不存在');
    if (enabled && !Number(models[0].provider_available)) {
      throw new Error('服务商已下线此模型，请同步目录后再启用');
    }
    await db.query('UPDATE ai_models SET manual_disabled = ?, enabled = ? WHERE id = ?', [
      enabled ? 0 : 1, enabled ? 1 : 0, models[0].id,
    ]);
    await ensureDefaultModel(db);
    const [defaults] = await db.query('SELECT model_key FROM ai_models WHERE is_default = 1 LIMIT 1');
    await db.commit();
    inTransaction = false;
    return { modelKey, enabled: enabled ? 1 : 0, defaultModel: defaults[0]?.model_key || null };
  } catch (error) {
    if (inTransaction) await db.rollback();
    throw error;
  } finally {
    if (locked) await db.query('SELECT RELEASE_LOCK(?)', [SYNC_LOCK]).catch(() => {});
    db.release();
  }
}

export async function setDefaultModel(modelKey, { pool = connection } = {}) {
  if (typeof modelKey !== 'string' || !modelKey.trim()) throw new Error('模型标识不能为空');
  const db = await pool.getConnection();
  let locked = false;
  let inTransaction = false;
  try {
    const [[lock]] = await db.query('SELECT GET_LOCK(?, 0) AS acquired', [SYNC_LOCK]);
    locked = Number(lock.acquired) === 1;
    if (!locked) throw new Error('模型同步或默认设置正在运行，请稍后重试');
    await db.beginTransaction();
    inTransaction = true;
    const [models] = await db.query(
      'SELECT id FROM ai_models WHERE model_key = ? AND enabled = 1 LIMIT 1 FOR UPDATE',
      [modelKey],
    );
    if (!models.length) throw new Error('所选模型不存在或已失效');
    await db.query('UPDATE ai_models SET is_default = 0 WHERE is_default = 1');
    await db.query('UPDATE ai_models SET is_default = 1 WHERE id = ?', [models[0].id]);
    await db.commit();
    inTransaction = false;
    return { modelKey, isDefault: 1 };
  } catch (error) {
    if (inTransaction) await db.rollback();
    throw error;
  } finally {
    if (locked) await db.query('SELECT RELEASE_LOCK(?)', [SYNC_LOCK]).catch(() => {});
    db.release();
  }
}

/** 完整获取并校验后才修改数据库；失败回滚，消失的模型禁用，重新出现的模型启用。 */
export async function syncModels({
  pool = connection,
  loadModels = () => client.models.list(),
} = {}) {
  const db = await pool.getConnection();
  let locked = false;
  let inTransaction = false;
  try {
    const [[lock]] = await db.query('SELECT GET_LOCK(?, 0) AS acquired', [SYNC_LOCK]);
    locked = Number(lock.acquired) === 1;
    if (!locked) return { skipped: true, reason: '已有模型同步任务正在运行' };

    const fetched = [];
    for await (const model of await loadModels()) fetched.push(normalizeModel(model));
    const models = [...new Map(fetched.map((model) => [model.modelKey, model])).values()];
    await db.beginTransaction();
    inTransaction = true;
    for (const model of models) {
      await db.query(
        `INSERT INTO ai_models (model_key, model_name, capabilities, effort, enabled)
         VALUES (?, ?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE model_name = VALUES(model_name),
           capabilities = VALUES(capabilities), effort = VALUES(effort),
           provider_available = 1, enabled = IF(manual_disabled = 1, 0, 1)`,
        [
          model.modelKey,
          model.modelName,
          JSON.stringify(model.capabilities),
          model.effort == null ? null : JSON.stringify(model.effort),
        ],
      );
    }
    const keys = models.map((model) => model.modelKey);
    const [disabled] = await db.query(
      `UPDATE ai_models SET enabled = 0, provider_available = 0 WHERE provider_available = 1${keys.length ? ' AND model_key NOT IN (?)' : ''}`,
      keys.length ? [keys] : [],
    );
    await ensureDefaultModel(db);
    await db.commit();
    inTransaction = false;
    return { synced: models.length, disabled: disabled.affectedRows, syncedAt: new Date() };
  } catch (error) {
    if (inTransaction) await db.rollback();
    throw error;
  } finally {
    if (locked) await db.query('SELECT RELEASE_LOCK(?)', [SYNC_LOCK]).catch(() => {});
    db.release();
  }
}
