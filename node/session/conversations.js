import connection from '../../Mysql/index.js';
import { createDeleteTitleSuffix, DELETED_TITLE_REGEXP } from './shared.js';

export async function getOrCreateConversation({ projectId, title, conversationId = null }, user) {
  const account = user.account;
  if (conversationId) {
    const [rows] = await connection.query(
      `select * from conversations
       where id = ? and account = ? and project_id = ? and status = 'active'
       limit 1`,
      [conversationId, account, projectId],
    );
    if (rows.length === 0) throw new Error('会话不存在或无权访问');
    await connection.query('update conversations set updated_at = current_timestamp where id = ?', [
      conversationId,
    ]);
    return rows[0];
  }

  const [result] = await connection.query(
    `insert into conversations (account, project_id, title)
     values (?, ?, ?)
     on duplicate key update id = last_insert_id(id), updated_at = current_timestamp`,
    [account, projectId, title],
  );
  const [rows] = await connection.query(
    'select * from conversations where id = ? and account = ? limit 1',
    [result.insertId, account],
  );
  return rows[0];
}

export async function saveConversationModel(conversationId, config, user) {
  const [result] = await connection.query(
    `UPDATE conversations SET model = ?, reasoning_effort = ?, updated_at = current_timestamp
     WHERE id = ? AND account = ? AND status = 'active'`,
    [config.model, config.reasoningEffort, conversationId, user.account],
  );
  if (result.affectedRows !== 1) throw new Error('会话不存在或无权访问');
}

export async function markProjectSessionsDeleted(projectId, account) {
  const suffix = createDeleteTitleSuffix();
  await connection.query(
    'UPDATE conversations SET title = CONCAT(title, ?), status = ? WHERE project_id = ? AND account = ? AND status = ?',
    [suffix, 'deleted', projectId, account, 'active'],
  );
  await connection.query(
    'UPDATE sessions SET title = CONCAT(title, ?) WHERE project_id = ? AND account = ? AND title NOT REGEXP ?',
    [suffix, projectId, account, DELETED_TITLE_REGEXP],
  );
}

export async function getConversationList(
  { projectId, keyword = '', page = 1, pageSize = 30 },
  user,
) {
  const safePage = Math.max(Number(page) || 1, 1);
  const safePageSize = Math.min(Math.max(Number(pageSize) || 30, 1), 50);
  const offset = (safePage - 1) * safePageSize;
  const normalizedKeyword = String(keyword || '').trim();
  const conditions = ['c.account = ?', 'c.project_id = ?', "c.status = 'active'"];
  const params = [user.account, projectId];
  if (normalizedKeyword) {
    conditions.push('c.title like ?');
    params.push(`%${normalizedKeyword}%`);
  }

  const [rows] = await connection.query(
    `select c.id, c.project_id, c.title, c.model, c.reasoning_effort, c.created_at, c.updated_at,
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
    [...params, safePageSize + 1, offset],
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

export async function getConversationMessages(
  { conversationId, beforeId = null, limit = 50 },
  user,
) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const [conversations] = await connection.query(
    `select id, project_id, title, model, reasoning_effort, created_at, updated_at
       from conversations
      where id = ? and account = ? and status = 'active'
      limit 1`,
    [conversationId, user.account],
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
            s.title, s.account, s.role, s.model, s.reasoning_effort,
            coalesce(m.content, s.content, '') as content,
            s.status, s.error_msg, s.created_at, s.updated_at
       from sessions s
       left join messages m on m.id = s.message_id
      where ${conditions.join(' and ')}
      order by s.id desc
      limit ?`,
    [...params, safeLimit + 1],
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

export async function updateConversation({ conversationId, title }, user) {
  const normalizedTitle = String(title || '').trim();
  if (!normalizedTitle) throw new Error('会话标题不能为空');
  const db = await connection.getConnection();
  try {
    await db.beginTransaction();
    const [rows] = await db.query(
      `select id, project_id, title from conversations
       where id = ? and account = ? and status = 'active' limit 1 for update`,
      [conversationId, user.account],
    );
    if (rows.length === 0) throw new Error('会话不存在或无权访问');
    const conversation = rows[0];
    if (conversation.title !== normalizedTitle) {
      const [duplicates] = await db.query(
        `select id from conversations
         where account = ? and project_id = ? and title = ? and status = 'active' and id <> ?
         limit 1`,
        [user.account, conversation.project_id, normalizedTitle, conversationId],
      );
      if (duplicates.length > 0) throw new Error('当前项目下会话标题已存在');
      await db.query(
        'update conversations set title = ?, updated_at = current_timestamp where id = ?',
        [normalizedTitle, conversationId],
      );
      await db.query('update sessions set title = ? where conversation_id = ? and account = ?', [
        normalizedTitle,
        conversationId,
        user.account,
      ]);
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

export async function deleteConversation(conversationId, user) {
  const suffix = createDeleteTitleSuffix();
  const db = await connection.getConnection();
  try {
    await db.beginTransaction();
    const [rows] = await db.query(
      `select id from conversations
       where id = ? and account = ? and status = 'active' limit 1 for update`,
      [conversationId, user.account],
    );
    if (rows.length === 0) throw new Error('会话不存在或无权访问');
    await db.query(
      `update conversations
          set title = concat(title, ?), status = 'deleted', updated_at = current_timestamp
        where id = ?`,
      [suffix, conversationId],
    );
    const [result] = await db.query(
      'update sessions set title = concat(title, ?) where conversation_id = ? and account = ?',
      [suffix, conversationId, user.account],
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
