import connection from '../../Mysql/index.js';
import { getBeijingDateKey } from '../utils/beijingTime.js';

export async function getConversationStats({ conversationId, projectId, title }, user) {
  const conditions = ['account = ?'];
  const params = [user.account];
  if (conversationId) {
    conditions.push('id = ?');
    params.push(conversationId);
  } else {
    conditions.push('project_id = ?', 'title = ?');
    params.push(projectId, title);
  }
  const [rows] = await connection.query(
    `select id, project_id as projectId, title, model, reasoning_effort as reasoningEffort,
            prompt_tokens as promptTokens,
            completion_tokens as completionTokens,
            total_tokens as totalTokens,
            current_context_tokens as currentContextTokens,
            context_limit as contextLimit,
            summary is not null as summaryExists,
            last_compressed_at as lastCompressedAt,
            created_at as createdAt,
            updated_at as updatedAt
     from conversations where ${conditions.join(' and ')} limit 1`,
    params,
  );
  if (rows.length === 0) throw new Error('会话不存在');
  return rows[0];
}

export async function settleConversationUsage({
  conversationId,
  projectId,
  assistantSessionId,
  usage,
  status = 'completed',
}) {
  const db = await connection.getConnection();
  try {
    await db.beginTransaction();
    const [settled] = await db.query(
      `update sessions set usage_settled = 1
       where id = ? and conversation_id = ? and usage_settled = 0`,
      [assistantSessionId, conversationId],
    );
    if (settled.affectedRows !== 1) {
      await db.rollback();
      const [rows] = await connection.query('select * from conversations where id = ? limit 1', [
        conversationId,
      ]);
      return { settled: false, conversation: rows[0] || null };
    }

    const promptTokens = Math.max(Number(usage?.promptTokens) || 0, 0);
    const completionTokens = Math.max(Number(usage?.completionTokens) || 0, 0);
    const totalTokens = promptTokens + completionTokens;
    const modelCalls = Math.max(Number(usage?.modelCalls) || 0, 0);
    const failedCalls = status === 'completed' ? 0 : 1;
    const contextTokens = Math.max(Number(usage?.currentContextTokens) || 0, 0);
    const contextLimit = Math.max(Number(usage?.contextLimit) || 0, 0);
    const [conversationUpdate] = await db.query(
      `update conversations
       set prompt_tokens = prompt_tokens + ?,
           completion_tokens = completion_tokens + ?,
           total_tokens = total_tokens + ?,
           current_context_tokens = ?,
           context_limit = ?,
           summary = coalesce(?, summary),
           summarized_until_session_id = coalesce(?, summarized_until_session_id),
           last_compressed_at = if(? = 1, current_timestamp, last_compressed_at)
       where id = ?`,
      [
        promptTokens,
        completionTokens,
        totalTokens,
        contextTokens,
        contextLimit,
        usage?.summary || null,
        usage?.summarizedUntilSessionId || null,
        usage?.compressed ? 1 : 0,
        conversationId,
      ],
    );
    if (conversationUpdate.affectedRows !== 1) {
      throw new Error('会话 token 结算失败：会话不存在');
    }

    const [projectUpdate] = await db.query(
      `update projects
       set ai_prompt_tokens = ai_prompt_tokens + ?,
           ai_completion_tokens = ai_completion_tokens + ?,
           ai_total_tokens = ai_total_tokens + ?
       where id = ?`,
      [promptTokens, completionTokens, totalTokens, projectId],
    );
    if (projectUpdate.affectedRows !== 1) {
      throw new Error('项目 token 结算失败：项目不存在');
    }

    const [[owner]] = await db.query(
      `SELECT u.id AS user_id
       FROM projects p
       JOIN users u ON u.account = p.account
       WHERE p.id = ?
       LIMIT 1`,
      [projectId],
    );
    if (!owner) throw new Error('AI 用量结算失败：项目用户不存在');
    await db.query(
      `INSERT INTO ai_usage_daily
       (metric_date, user_id, project_id, prompt_tokens, completion_tokens,
        total_tokens, model_calls, failed_calls)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         prompt_tokens = prompt_tokens + VALUES(prompt_tokens),
         completion_tokens = completion_tokens + VALUES(completion_tokens),
         total_tokens = total_tokens + VALUES(total_tokens),
         model_calls = model_calls + VALUES(model_calls),
         failed_calls = failed_calls + VALUES(failed_calls)`,
      [
        getBeijingDateKey(),
        owner.user_id,
        projectId,
        promptTokens,
        completionTokens,
        totalTokens,
        modelCalls,
        failedCalls,
      ],
    );

    await db.commit();
    const [rows] = await connection.query('select * from conversations where id = ? limit 1', [
      conversationId,
    ]);
    return { settled: true, conversation: rows[0] || null };
  } catch (error) {
    await db.rollback();
    throw error;
  } finally {
    db.release();
  }
}
