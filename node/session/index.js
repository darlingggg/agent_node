import connection from '../../Mysql/index.js';
import { getBeijingDateKey } from '../utils/beijingTime.js';

/** 软删除标题后缀：_delete_ + 当前时间戳后10位 */
const DELETE_TITLE_SUFFIX = () => `_delete_${String(Date.now()).slice(-10)}`;

/** 已软删除会话的 title 匹配规则 */
const DELETED_TITLE_REGEXP = '_delete_[0-9]{10}$';

/**
 * 获取当前账号、项目和标题对应的会话汇总记录；不存在时原子创建。
 * LAST_INSERT_ID(id) 让新增和命中唯一键两种情况都能通过 insertId 取得稳定 conversationId。
 * @param {{projectId: number|string, title: string}} params 会话所属项目和标题
 * @param {{account: string}} user 当前登录用户
 * @returns {Promise<object>} conversations 表中的完整会话记录
 */
export const getOrCreateConversation = async ({ projectId, title, conversationId = null }, user) => {
  const account = user.account;
  if (conversationId) {
    const [rows] = await connection.query(
      `select * from conversations
       where id = ? and account = ? and project_id = ? and status = 'active'
       limit 1`,
      [conversationId, account, projectId]
    );
    if (rows.length === 0) throw new Error('会话不存在或无权访问');
    await connection.query(
      'update conversations set updated_at = current_timestamp where id = ?',
      [conversationId]
    );
    return rows[0];
  }

  const [result] = await connection.query(
    `insert into conversations (account, project_id, title)
     values (?, ?, ?)
     on duplicate key update id = last_insert_id(id), updated_at = current_timestamp`,
    [account, projectId, title]
  );
  const id = result.insertId;
  const [rows] = await connection.query(
    'select * from conversations where id = ? and account = ? limit 1',
    [id, account]
  );
  return rows[0];
}

/**
 * 查询当前会话累计 Token、当前上下文长度和摘要状态。
 * 优先使用 conversationId；旧前端也可以使用 projectId + title 定位。
 * @param {{conversationId?: number|string, projectId?: number|string, title?: string}} params 会话定位参数
 * @param {{account: string}} user 当前登录用户，用于数据隔离
 * @returns {Promise<object>} 供前端展示的会话统计信息
 * @throws {Error} 会话不存在或不属于当前账号
 */
export const getConversationStats = async ({ conversationId, projectId, title }, user) => {
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
    `select id, project_id as projectId, title,
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
    params
  );
  if (rows.length === 0) throw new Error('会话不存在');
  return rows[0];
}

/**
 * 在一次完整生成完成、失败或取消后，统一结算会话和项目累计 Token。
 * 事务首先把 assistant sessions 记录从 usage_settled=0 改为 1；只有首次成功修改才能继续累计，避免回调重试导致重复计数。
 * 会话/项目 Token 使用原子加法累计，current_context_tokens、摘要正文和摘要覆盖位置使用本轮最新状态覆盖。
 * @param {object} params 结算参数
 * @param {number|string} params.conversationId 会话 ID
 * @param {number|string} params.projectId 项目 ID
 * @param {number|string} params.assistantSessionId 本轮 assistant 对应的 sessions.id
 * @param {object|undefined} params.usage chat 返回或 error.chatUsage 携带的本轮汇总用量
 * @returns {Promise<{settled: boolean, conversation: object|null}>} 是否首次结算及结算后的会话汇总
 * @throws {Error} 会话/项目不存在或事务更新失败
 */
export const settleConversationUsage = async ({ conversationId, projectId, assistantSessionId, usage, status = 'completed' }) => {
  const db = await connection.getConnection();
  try {
    await db.beginTransaction();
    const [settled] = await db.query(
      `update sessions set usage_settled = 1
       where id = ? and conversation_id = ? and usage_settled = 0`,
      [assistantSessionId, conversationId]
    );
    if (settled.affectedRows !== 1) {
      await db.rollback();
      const [rows] = await connection.query('select * from conversations where id = ? limit 1', [conversationId]);
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
        promptTokens, completionTokens, totalTokens, contextTokens, contextLimit,
        usage?.summary || null, usage?.summarizedUntilSessionId || null,
        usage?.compressed ? 1 : 0, conversationId,
      ]
    );
    if (conversationUpdate.affectedRows !== 1) throw new Error('会话 token 结算失败：会话不存在');
    const [projectUpdate] = await db.query(
      `update projects
       set ai_prompt_tokens = ai_prompt_tokens + ?,
           ai_completion_tokens = ai_completion_tokens + ?,
           ai_total_tokens = ai_total_tokens + ?
       where id = ?`,
      [promptTokens, completionTokens, totalTokens, projectId]
    );
    if (projectUpdate.affectedRows !== 1) throw new Error('项目 token 结算失败：项目不存在');
    const [[owner]] = await db.query(
      `SELECT u.id AS user_id
       FROM projects p
       JOIN users u ON u.account = p.account
       WHERE p.id = ?
       LIMIT 1`,
      [projectId]
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
        getBeijingDateKey(), owner.user_id, projectId, promptTokens,
        completionTokens, totalTokens, modelCalls, failedCalls,
      ]
    );
    await db.commit();
    const [rows] = await connection.query('select * from conversations where id = ? limit 1', [conversationId]);
    return { settled: true, conversation: rows[0] || null };
  } catch (error) {
    await db.rollback();
    throw error;
  } finally {
    db.release();
  }
}

/**
 * 校验同一用户、同一项目下是否已有未删除的同名会话。
 * 软删除的会话会被排除，避免旧记录阻塞重新创建同名会话。
 */
const ensureSessionTitleAvailable = async (account, projectId, title) => {
  const [rows] = await connection.query(
    'select id from sessions where account = ? and project_id = ? and title = ? and title not regexp ? limit 1',
    [account, projectId, title, DELETED_TITLE_REGEXP]
  );
  if (rows.length > 0) throw new Error('当前项目下会话标题已存在');
}

/**
 * 按项目软删除全部会话（重命名 title，保留消息记录）
 * @param {number|string} projectId 项目 id
 * @param {string} account 用户账号
 */
export const markProjectSessionsDeleted = async (projectId, account) => {
  const suffix = DELETE_TITLE_SUFFIX();
  await connection.query(
    'UPDATE conversations SET title = CONCAT(title, ?), status = ? WHERE project_id = ? AND account = ? AND status = ?',
    [suffix, 'deleted', projectId, account, 'active']
  );
  await connection.query(
    'UPDATE sessions SET title = CONCAT(title, ?) WHERE project_id = ? AND account = ? AND title NOT REGEXP ?',
    [suffix, projectId, account, DELETED_TITLE_REGEXP]
  );
}

/** 创建会话 */
export const createSession = async (body, user) => {
  const { role, projectId, content } = body;
  const title = body.title || content.slice(0, 30);
  const account = user.account;

  const [res] = await connection.query('select * from projects where id = ? and account = ?', [projectId, account]);
  if(res.length === 0) throw new Error('项目不存在');
  const conversation = await getOrCreateConversation({ projectId, title }, user);

  // await ensureSessionTitleAvailable(account, projectId, title);

  if(role === 'assistant' || role === 'vision') {
    const [res1] = await connection.query(
      'insert into messages (content) values (?)',
      [content]
    );
    const messageId = res1.insertId;
    const [res2] = await connection.query(
      'insert into sessions (title, role, project_id, message_id,account,conversation_id) VALUES (?, ?, ?, ?, ?, ?)',
      [title, role, projectId, messageId, account, conversation.id]
    );
    return { id: res2.insertId,content: '创建成功' };
  }

  const [res2] = await connection.query(
    'insert into sessions (title, role, project_id, content,account,conversation_id) VALUES (?, ?, ?, ?, ?, ?)',
    [title, role, projectId, content, account, conversation.id]
  );
  return { id: res2.insertId,content: '创建成功' };
}

/** 创建用户会话消息，不检查 title 唯一性，供后端托管 AI 流式对话使用 */
export const createUserChatSession = async ({ title, projectId, content, conversationId }, user) => {
  const account = user.account;
  // 用户消息是已经输入完成的内容，直接标记为 completed。
  const [result] = await connection.query(
    'insert into sessions (title, role, project_id, content, account, status, conversation_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [title || content.slice(0, 30), 'user', projectId, content, account, 'completed', conversationId]
  );
  return { id: result.insertId };
}

/** 创建正在生成中的 assistant 消息，并预先分配 messageId */
export const createStreamingAssistantSession = async ({ title, projectId, conversationId }, user) => {
  const account = user.account;
  // assistant 内容会边生成边写入 messages，这里先插入空消息拿到 messageId。
  const [messageResult] = await connection.query(
    'insert into messages (content) values (?)',
    ['']
  );
  const messageId = messageResult.insertId;
  // sessions 只保存 message_id 引用，实际内容存放在 messages 表中。
  const [sessionResult] = await connection.query(
    'insert into sessions (title, role, project_id, message_id, account, status, conversation_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [title, 'assistant', projectId, messageId, account, 'streaming', conversationId]
  );
  return { sessionId: sessionResult.insertId, messageId };
}

/** 获取会话列表（不含已软删除的会话） */
export const getSessionList = async (projectId, title = undefined, user) => {
  const account = user.account;
  const where = title ? `and s.title = ?` : '';
  const params = title ? [projectId, title, account] : [projectId, account];
  const [result] = await connection.query(
    `select s.*, coalesce(m.content, s.content, '') as content
       from sessions s
       left join messages m on m.id = s.message_id
      where s.project_id = ? ${where} and s.account = ? and s.title not regexp ?`,
    [...params, DELETED_TITLE_REGEXP]
  );
  return result;
}

/** Return paginated conversation summaries without loading every message body. */
export const getConversationList = async ({
  projectId,
  keyword = '',
  page = 1,
  pageSize = 30,
}, user) => {
  const safePage = Math.max(Number(page) || 1, 1);
  const safePageSize = Math.min(Math.max(Number(pageSize) || 30, 1), 50);
  const offset = (safePage - 1) * safePageSize;
  const normalizedKeyword = String(keyword || '').trim();
  const conditions = ["c.account = ?", "c.project_id = ?", "c.status = 'active'"];
  const params = [user.account, projectId];

  if (normalizedKeyword) {
    conditions.push('c.title like ?');
    params.push(`%${normalizedKeyword}%`);
  }

  const [rows] = await connection.query(
    `select c.id, c.project_id, c.title, c.created_at, c.updated_at,
            (select count(*)
               from sessions counted
              where counted.conversation_id = c.id) as message_count,
            coalesce((
              select left(coalesce(m.content, latest.content, ''), 160)
                from sessions latest
                left join messages m on m.id = latest.message_id
               where latest.conversation_id = c.id
               order by latest.id desc
               limit 1
            ), '') as preview
       from conversations c
      where ${conditions.join(' and ')}
      order by c.updated_at desc, c.id desc
      limit ? offset ?`,
    [...params, safePageSize + 1, offset]
  );

  return {
    list: rows.slice(0, safePageSize),
    pagination: {
      page: safePage,
      pageSize: safePageSize,
      hasMore: rows.length > safePageSize,
    },
  };
}

/** Return one conversation's latest messages using cursor pagination and one join. */
export const getConversationMessages = async ({
  conversationId,
  beforeId = null,
  limit = 50,
}, user) => {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const [conversations] = await connection.query(
    `select id, project_id, title, created_at, updated_at
       from conversations
      where id = ? and account = ? and status = 'active'
      limit 1`,
    [conversationId, user.account]
  );
  if (conversations.length === 0) throw new Error('会话不存在或无权访问');

  const conditions = ['s.conversation_id = ?', 's.account = ?'];
  const params = [conversationId, user.account];
  if (beforeId) {
    conditions.push('s.id < ?');
    params.push(beforeId);
  }

  const [rows] = await connection.query(
    `select s.id, s.project_id, s.conversation_id, s.message_id,
            s.title, s.account, s.role,
            coalesce(m.content, s.content, '') as content,
            s.status, s.error_msg, s.created_at, s.updated_at
       from sessions s
       left join messages m on m.id = s.message_id
      where ${conditions.join(' and ')}
      order by s.id desc
      limit ?`,
    [...params, safeLimit + 1]
  );
  const hasMore = rows.length > safeLimit;
  const list = rows.slice(0, safeLimit).reverse();

  return {
    conversation: conversations[0],
    list,
    pagination: {
      limit: safeLimit,
      hasMore,
      nextCursor: hasMore && list.length ? Number(list[0].id) : null,
    },
  };
}

/** Rename one conversation and its denormalized session titles by stable ID. */
export const updateConversation = async ({ conversationId, title }, user) => {
  const normalizedTitle = String(title || '').trim();
  if (!normalizedTitle) throw new Error('会话标题不能为空');
  const db = await connection.getConnection();
  try {
    await db.beginTransaction();
    const [rows] = await db.query(
      `select id, project_id, title from conversations
       where id = ? and account = ? and status = 'active' limit 1 for update`,
      [conversationId, user.account]
    );
    if (rows.length === 0) throw new Error('会话不存在或无权访问');
    const conversation = rows[0];
    if (conversation.title !== normalizedTitle) {
      const [duplicates] = await db.query(
        `select id from conversations
         where account = ? and project_id = ? and title = ? and status = 'active' and id <> ?
         limit 1`,
        [user.account, conversation.project_id, normalizedTitle, conversationId]
      );
      if (duplicates.length > 0) throw new Error('当前项目下会话标题已存在');
      await db.query(
        'update conversations set title = ?, updated_at = current_timestamp where id = ?',
        [normalizedTitle, conversationId]
      );
      await db.query(
        'update sessions set title = ? where conversation_id = ? and account = ?',
        [normalizedTitle, conversationId, user.account]
      );
    }
    await db.commit();
    return { id: Number(conversationId), title: normalizedTitle };
  } catch (error) {
    await db.rollback();
    throw error;
  } finally {
    db.release();
  }
}

/** Soft-delete one conversation and its sessions by stable ID. */
export const deleteConversation = async (conversationId, user) => {
  const suffix = DELETE_TITLE_SUFFIX();
  const db = await connection.getConnection();
  try {
    await db.beginTransaction();
    const [rows] = await db.query(
      `select id from conversations
       where id = ? and account = ? and status = 'active' limit 1 for update`,
      [conversationId, user.account]
    );
    if (rows.length === 0) throw new Error('会话不存在或无权访问');
    await db.query(
      `update conversations
          set title = concat(title, ?), status = 'deleted', updated_at = current_timestamp
        where id = ?`,
      [suffix, conversationId]
    );
    const [result] = await db.query(
      'update sessions set title = concat(title, ?) where conversation_id = ? and account = ?',
      [suffix, conversationId, user.account]
    );
    await db.commit();
    return { id: Number(conversationId), affectedRows: result.affectedRows || 0 };
  } catch (error) {
    await db.rollback();
    throw error;
  } finally {
    db.release();
  }
}

/** 修改会话标题 */
export const updateSession = async (body, user) => {
  const { title,oldTitle,projectId } = body;
  const account = user.account;
  if (title !== oldTitle) await ensureSessionTitleAvailable(account, projectId, title);
  const [result] = await connection.query(
    'update sessions set title = ? where title = ? and project_id = ? and account = ?',
    [title,oldTitle,projectId,account]
  );
  await connection.query(
    'update conversations set title = ? where title = ? and project_id = ? and account = ? and status = ?',
    [title, oldTitle, projectId, account, 'active']
  );
  return { content: '修改成功',affectedRows: result.affectedRows || 0 };
}

/** 软删除会话（重命名 title，保留消息记录） */
export const deleteSession = async (body, user) => {
  const { title, projectId } = body;
  const account = user.account;
  const suffix = DELETE_TITLE_SUFFIX();
  const [result] = await connection.query(
    'update sessions set title = concat(title, ?) where title = ? and project_id = ? and account = ?',
    [suffix, title, projectId, account]
  );
  await connection.query(
    'update conversations set title = concat(title, ?), status = ? where title = ? and project_id = ? and account = ?',
    [suffix, 'deleted', title, projectId, account]
  );
  return { content: '删除成功', affectedRows: result.affectedRows || 0 };
}

/** 获取ai会话详情 */
export const getSessionDetail = async (id) => {
  const [result] = await connection.query('select * from messages where id = ?', [id]);
  return result;
}
