import connection from '../../Mysql/index.js';

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

/** 获取会话列表 */
export const getSessionList = async (projectId, title = undefined, user) => {
  const account = user.account;
  const where = title ? `and title = '${title}'` : '';
  const [result] = await connection.query(
    `select * from sessions where project_id = ? ${where} and account = ?`,
    [projectId, account]
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

/** 删除会话 */
export const deleteSession = async (body, user) => {
  const { title,projectId } = body;
  const account = user.account;
  const [sessions] = await connection.query('select * from sessions where title = ? and project_id = ? and account = ?', [title,projectId,account]);
  const messageIds = []
  for(const item of sessions) if(item.message_id) messageIds.push(item.message_id);
  if(messageIds.length > 0) await connection.query('delete from messages where id in (?)', [messageIds]);
  const [result] = await connection.query('delete from sessions where title = ? and project_id = ? and account = ?', [title,projectId,account]);
  return { content: '删除成功',affectedRows: result.affectedRows || 0 };
}