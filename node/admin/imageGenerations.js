import connection from '../../Mysql/index.js';
import { getSignedObjectUrl } from '../cos/index.js';
import { keysToCamelCase } from '../utils/case.js';

const VALID_STATUSES = new Set(['queued', 'submitted', 'generating', 'storing', 'succeeded', 'failed']);
const VALID_ORIGINS = new Set(['image_lab', 'agent_tool']);

function parsePositiveInteger(value, name) {
  if (value === undefined || value === '') return null;
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized <= 0) throw new Error(name + ' 格式不正确');
  return normalized;
}

function buildFilters({ account, projectId, status, origin, keyword, dateFrom, dateTo }) {
  const conditions = [];
  const params = [];

  if (account) {
    const value = String(account).trim();
    if (value.length > 64) throw new Error('account 格式不正确');
    conditions.push('a.account = ?');
    params.push(value);
  }
  const normalizedProjectId = parsePositiveInteger(projectId, 'projectId');
  if (normalizedProjectId) {
    conditions.push('a.project_id = ?');
    params.push(normalizedProjectId);
  }
  if (status) {
    if (!VALID_STATUSES.has(status)) throw new Error('status 格式不正确');
    conditions.push('a.status = ?');
    params.push(status);
  }
  if (origin) {
    if (!VALID_ORIGINS.has(origin)) throw new Error('origin 格式不正确');
    conditions.push(origin === 'agent_tool' ? 'a.assistant_session_id IS NOT NULL' : 'a.assistant_session_id IS NULL');
  }
  if (keyword) {
    const value = String(keyword).trim();
    if (value.length > 200) throw new Error('keyword 过长');
    conditions.push('(a.prompt LIKE ? OR CAST(a.id AS CHAR) = ? OR a.tool_call_id = ?)');
    params.push('%' + value + '%', value, value);
  }
  if (dateFrom) {
    conditions.push('a.created_at >= ?');
    params.push(dateFrom);
  }
  if (dateTo) {
    conditions.push('a.created_at < DATE_ADD(?, INTERVAL 1 DAY)');
    params.push(dateTo);
  }

  return {
    where: conditions.length ? 'WHERE ' + conditions.join(' AND ') : '',
    params,
  };
}

function parseReferenceImages(value) {
  if (Array.isArray(value)) return value;
  try {
    return value ? JSON.parse(value) : [];
  } catch {
    return [];
  }
}

async function toAdminTask(row) {
  const task = keysToCamelCase({
    ...row,
    origin: row.assistant_session_id ? 'agent_tool' : 'image_lab',
    reference_images: parseReferenceImages(row.reference_images),
  });
  if (row.object_key) task.url = await getSignedObjectUrl(row.object_key);
  return task;
}

/** 管理端分页查询 AI 生图任务及当前筛选范围汇总。 */
export async function getAdminImageGenerations({ pageSize, offset, ...filters }) {
  const { where, params } = buildFilters(filters);
  const summarySql = "SELECT COUNT(*) AS total, SUM(a.status = 'succeeded') AS succeeded, SUM(a.status = 'failed') AS failed, SUM(a.status IN ('queued', 'submitted', 'generating', 'storing')) AS processing, COALESCE(SUM(a.stored_size), 0) AS stored_bytes FROM ai_generated_images a " + where;
  const [[summaryRow]] = await connection.query(summarySql, params);
  const listSql = 'SELECT a.*, u.id AS user_id, u.nickname AS user_nickname, p.title AS project_title FROM ai_generated_images a LEFT JOIN users u ON u.account = a.account COLLATE utf8mb4_unicode_ci LEFT JOIN projects p ON p.id = a.project_id ' + where + ' ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?';
  const [rows] = await connection.query(listSql, [...params, pageSize, offset]);

  return {
    rows: await Promise.all(rows.map(toAdminTask)),
    total: Number(summaryRow.total) || 0,
    summary: {
      total: Number(summaryRow.total) || 0,
      succeeded: Number(summaryRow.succeeded) || 0,
      failed: Number(summaryRow.failed) || 0,
      processing: Number(summaryRow.processing) || 0,
      storedBytes: Number(summaryRow.stored_bytes) || 0,
    },
  };
}

/** 管理端查看单个 AI 生图任务完整信息。 */
export async function getAdminImageGeneration(rawTaskId) {
  const taskId = parsePositiveInteger(rawTaskId, 'taskId');
  const [rows] = await connection.query(
    'SELECT a.*, u.id AS user_id, u.nickname AS user_nickname, p.title AS project_title, c.title AS conversation_title FROM ai_generated_images a LEFT JOIN users u ON u.account = a.account COLLATE utf8mb4_unicode_ci LEFT JOIN projects p ON p.id = a.project_id LEFT JOIN conversations c ON c.id = a.conversation_id WHERE a.id = ? LIMIT 1',
    [taskId],
  );
  if (!rows.length) throw new Error('生图任务不存在');
  return toAdminTask(rows[0]);
}
