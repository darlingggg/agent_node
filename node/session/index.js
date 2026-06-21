import connection from '../../Mysql/index.js';

/** 软删除标题后缀：_delete_ + 当前时间戳后10位 */
const DELETE_TITLE_SUFFIX = () => `_delete_${String(Date.now()).slice(-10)}`;

/** 已软删除会话的 title 匹配规则 */
const DELETED_TITLE_REGEXP = '_delete_[0-9]{10}$';

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

  if(role === 'assistant') {
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

/** 获取会话列表（不含已软删除的会话） */
export const getSessionList = async (projectId, title = undefined, user) => {
  const account = user.account;
  const where = title ? `and title = ?` : '';
  const params = title ? [projectId, title, account] : [projectId, account];
  const [result] = await connection.query(
    `select * from sessions where project_id = ? ${where} and account = ? and title not regexp ?`,
    [...params, DELETED_TITLE_REGEXP]
  );
  return result;
}

/** 修改会话标题 */
export const updateSession = async (body, user) => {
  const { title,oldTitle,projectId } = body;
  const account = user.account;
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