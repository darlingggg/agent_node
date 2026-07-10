import connection from '../../Mysql/index.js';

/** 软删除标题后缀：_delete_ + 当前时间戳后10位 */
const DELETE_TITLE_SUFFIX = () => `_delete_${String(Date.now()).slice(-10)}`;

/** 已软删除会话的 title 匹配规则 */
const DELETED_TITLE_REGEXP = '_delete_[0-9]{10}$';

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
    'UPDATE sessions SET title = CONCAT(title, ?) WHERE project_id = ? AND account = ? AND title NOT REGEXP ?',
    [suffix, projectId, account, DELETED_TITLE_REGEXP]
  );
}

/** 创建会话 */
export const createSession = async (body, user) => {
  const { role, projectId, content } = body;
  const title = body.title || content.slice(0, 30);
  const account = user.account;

  const [res] = await connection.query('select * from projects where id = ?', [projectId]);
  if(res.length === 0) throw new Error('项目不存在');

  // await ensureSessionTitleAvailable(account, projectId, title);

  if(role === 'assistant' || role === 'vision') {
    const [res1] = await connection.query(
      'insert into messages (content) values (?)',
      [content]
    );
    const messageId = res1.insertId;
    const [res2] = await connection.query(
      'insert into sessions (title, role, project_id, message_id,account) VALUES (?, ?, ?, ?, ?)',
      [title, role, projectId, messageId, account]
    );
    return { id: res2.insertId,content: '创建成功' };
  }

  const [res2] = await connection.query(
    'insert into sessions (title, role, project_id, content,account) VALUES (?, ?, ?, ?, ?)',
    [title, role, projectId, content, account]
  );
  return { id: res2.insertId,content: '创建成功' };
}

/** 创建用户会话消息，不检查 title 唯一性，供后端托管 AI 流式对话使用 */
export const createUserChatSession = async ({ title, projectId, content }, user) => {
  const account = user.account;
  // 用户消息是已经输入完成的内容，直接标记为 completed。
  const [result] = await connection.query(
    'insert into sessions (title, role, project_id, content, account, status) VALUES (?, ?, ?, ?, ?, ?)',
    [title || content.slice(0, 30), 'user', projectId, content, account, 'completed']
  );
  return { id: result.insertId };
}

/** 创建正在生成中的 assistant 消息，并预先分配 messageId */
export const createStreamingAssistantSession = async ({ title, projectId }, user) => {
  const account = user.account;
  // assistant 内容会边生成边写入 messages，这里先插入空消息拿到 messageId。
  const [messageResult] = await connection.query(
    'insert into messages (content) values (?)',
    ['']
  );
  const messageId = messageResult.insertId;
  // sessions 只保存 message_id 引用，实际内容存放在 messages 表中。
  const [sessionResult] = await connection.query(
    'insert into sessions (title, role, project_id, message_id, account, status) VALUES (?, ?, ?, ?, ?, ?)',
    [title, 'assistant', projectId, messageId, account, 'streaming']
  );
  return { sessionId: sessionResult.insertId, messageId };
}

/** 获取会话列表（不含已软删除的会话） */
export const getSessionList = async (projectId, title = undefined, user) => {
  const account = user.account;
  const where = title ? `and title = ?` : '';
  const params = title ? [projectId, title, account] : [projectId, account];
  const [result] = await connection.query(
    `select * from sessions where project_id = ? ${where} and account = ? and title not regexp ?`,
    [...params, DELETED_TITLE_REGEXP]
  );
  // assistant/vision 等长内容存放在 messages 表，列表接口需要回填给前端展示。
  for (const item of result) {
    if (!item.message_id) continue;
    const [messages] = await connection.query('select content from messages where id = ?', [item.message_id]);
    item.content = messages[0]?.content ?? '';
  }
  return result;
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
  return { content: '删除成功', affectedRows: result.affectedRows || 0 };
}

/** 获取ai会话详情 */
export const getSessionDetail = async (id) => {
  const [result] = await connection.query('select * from messages where id = ?', [id]);
  return result;
}
