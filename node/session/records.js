import connection from '../../Mysql/index.js';
import { getOrCreateConversation } from './conversations.js';
import {
  createDeleteTitleSuffix,
  DELETED_TITLE_REGEXP,
  ensureSessionTitleAvailable,
} from './shared.js';

export async function createSession(body, user) {
  const { role, projectId, content } = body;
  const title = body.title || content.slice(0, 30);
  const account = user.account;
  const [projects] = await connection.query(
    'select * from projects where id = ? and account = ?',
    [projectId, account],
  );
  if (projects.length === 0) throw new Error('项目不存在');
  const conversation = await getOrCreateConversation({ projectId, title }, user);

  if (role === 'assistant' || role === 'vision') {
    const [messageResult] = await connection.query(
      'insert into messages (content) values (?)',
      [content],
    );
    const [sessionResult] = await connection.query(
      'insert into sessions (title, role, project_id, message_id,account,conversation_id) VALUES (?, ?, ?, ?, ?, ?)',
      [title, role, projectId, messageResult.insertId, account, conversation.id],
    );
    return { id: sessionResult.insertId, content: '创建成功' };
  }

  const [sessionResult] = await connection.query(
    'insert into sessions (title, role, project_id, content,account,conversation_id) VALUES (?, ?, ?, ?, ?, ?)',
    [title, role, projectId, content, account, conversation.id],
  );
  return { id: sessionResult.insertId, content: '创建成功' };
}

export async function createUserChatSession({ title, projectId, content, conversationId }, user) {
  const [result] = await connection.query(
    'insert into sessions (title, role, project_id, content, account, status, conversation_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [
      title || content.slice(0, 30),
      'user',
      projectId,
      content,
      user.account,
      'completed',
      conversationId,
    ],
  );
  return { id: result.insertId };
}

export async function createStreamingAssistantSession({ title, projectId, conversationId }, user) {
  const [messageResult] = await connection.query(
    'insert into messages (content) values (?)',
    [''],
  );
  const messageId = messageResult.insertId;
  const [sessionResult] = await connection.query(
    'insert into sessions (title, role, project_id, message_id, account, status, conversation_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [title, 'assistant', projectId, messageId, user.account, 'streaming', conversationId],
  );
  return { sessionId: sessionResult.insertId, messageId };
}

export async function getSessionList(projectId, title = undefined, user) {
  const where = title ? 'and s.title = ?' : '';
  const params = title
    ? [projectId, title, user.account]
    : [projectId, user.account];
  const [result] = await connection.query(
    `select s.*, coalesce(m.content, s.content, '') as content
       from sessions s
       left join messages m on m.id = s.message_id
      where s.project_id = ? ${where} and s.account = ? and s.title not regexp ?`,
    [...params, DELETED_TITLE_REGEXP],
  );
  return result;
}

export async function updateSession(body, user) {
  const { title, oldTitle, projectId } = body;
  if (title !== oldTitle) {
    await ensureSessionTitleAvailable(user.account, projectId, title);
  }
  const [result] = await connection.query(
    'update sessions set title = ? where title = ? and project_id = ? and account = ?',
    [title, oldTitle, projectId, user.account],
  );
  await connection.query(
    'update conversations set title = ? where title = ? and project_id = ? and account = ? and status = ?',
    [title, oldTitle, projectId, user.account, 'active'],
  );
  return { content: '修改成功', affectedRows: result.affectedRows || 0 };
}

export async function deleteSession(body, user) {
  const { title, projectId } = body;
  const suffix = createDeleteTitleSuffix();
  const [result] = await connection.query(
    'update sessions set title = concat(title, ?) where title = ? and project_id = ? and account = ?',
    [suffix, title, projectId, user.account],
  );
  await connection.query(
    'update conversations set title = concat(title, ?), status = ? where title = ? and project_id = ? and account = ?',
    [suffix, 'deleted', title, projectId, user.account],
  );
  return { content: '删除成功', affectedRows: result.affectedRows || 0 };
}

export async function getSessionDetail(id) {
  const [result] = await connection.query('select * from messages where id = ?', [id]);
  return result;
}
