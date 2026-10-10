import connection from '../Mysql/index.js';

export function parseToolResult(result) {
  if (typeof result !== 'string') return result;
  try {
    return JSON.parse(result);
  } catch {
    return result;
  }
}

export function toolResultStatus(result) {
  const parsed = parseToolResult(result);
  return parsed && typeof parsed === 'object' && parsed.success === false
    ? 'failed'
    : 'succeeded';
}

export function summarizeTools(tools) {
  const summary = {
    total: tools.length,
    running: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const tool of tools)
    if (Object.hasOwn(summary, tool.status)) summary[tool.status] += 1;
  return summary;
}

function jsonValue(value) {
  if (typeof value === 'string') return parseToolResult(value);
  return value ?? null;
}

function iso(value) {
  return value ? new Date(value).toISOString() : undefined;
}

export function mapToolRow(row, messageStatus = 'streaming') {
  const unfinished = row.status === 'running' && messageStatus !== 'streaming';
  return {
    toolCallId: row.tool_call_id,
    name: row.name,
    sequence: Number(row.sequence_no),
    textOffset: Number(row.text_offset),
    status: unfinished
      ? messageStatus === 'cancelled'
        ? 'cancelled'
        : 'failed'
      : row.status,
    args: jsonValue(row.args_json) ?? {},
    result: jsonValue(row.result_json),
    error:
      row.error_text || (unfinished ? '执行已结束，未收到完整结果' : undefined),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    durationMs: row.duration_ms == null ? undefined : Number(row.duration_ms),
  };
}

export function createToolCallStore(db) {
  return {
    async save(messageId, tool) {
      await db.query(
        `INSERT INTO message_tool_calls
          (message_id, assistant_session_id, project_id, conversation_id, account,
           tool_call_id, name, sequence_no, text_offset, status, args_json, result_json,
           error_text, started_at, finished_at, duration_ms)
         SELECT s.message_id, s.id, s.project_id, s.conversation_id, s.account,
           ?, ?, ?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?), FROM_UNIXTIME(?), ?
           FROM sessions s WHERE s.message_id = ? AND s.role = 'assistant'
         ON DUPLICATE KEY UPDATE status = VALUES(status), result_json = VALUES(result_json),
           error_text = VALUES(error_text), finished_at = VALUES(finished_at), duration_ms = VALUES(duration_ms)`,
        [
          tool.toolCallId,
          tool.name,
          tool.sequence,
          tool.textOffset,
          tool.status,
          JSON.stringify(tool.args ?? {}),
          JSON.stringify(tool.result ?? null),
          tool.error ?? null,
          new Date(tool.startedAt).getTime() / 1000,
          tool.finishedAt ? new Date(tool.finishedAt).getTime() / 1000 : null,
          tool.durationMs ?? null,
          messageId,
        ],
      );
    },
    async summaries(messageIds, account) {
      if (!messageIds.length) return new Map();
      let rows;
      try {
        [rows] = await db.query(
          `SELECT message_id, COUNT(*) AS total,
            SUM(status = 'running') AS running, SUM(status = 'succeeded') AS succeeded,
            SUM(status = 'failed') AS failed, SUM(status = 'cancelled') AS cancelled
           FROM message_tool_calls WHERE message_id IN (?) AND account = ? GROUP BY message_id`,
          [messageIds, account],
        );
      } catch (error) {
        if (error.code === 'ER_NO_SUCH_TABLE') return new Map();
        throw error;
      }
      return new Map(
        rows.map((row) => [
          Number(row.message_id),
          {
            total: Number(row.total),
            running: Number(row.running),
            succeeded: Number(row.succeeded),
            failed: Number(row.failed),
            cancelled: Number(row.cancelled),
          },
        ]),
      );
    },
    async list(messageId, account) {
      const [owners] = await db.query(
        `SELECT s.id, s.status FROM sessions s
         JOIN conversations c ON c.id = s.conversation_id AND c.status = 'active'
         JOIN projects p ON p.id = s.project_id AND p.account = s.account
         WHERE s.message_id = ? AND s.account = ? AND s.role = 'assistant' LIMIT 1`,
        [messageId, account],
      );
      if (!owners.length) throw new Error('消息不存在或无权访问');
      const [rows] = await db.query(
        'SELECT * FROM message_tool_calls WHERE message_id = ? AND account = ? ORDER BY sequence_no, id',
        [messageId, account],
      );
      return {
        sessionId: Number(owners[0].id),
        tools: rows.map((row) => mapToolRow(row, owners[0].status)),
      };
    },
  };
}

export const toolCallStore = createToolCallStore(connection);
