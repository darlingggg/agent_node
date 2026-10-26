import connection from '../../../Mysql/index.js';

export async function keepContext(
  account,
  projectId,
  title,
  conversationId = null,
  summarizedUntilSessionId = null,
) {
  const params = conversationId
    ? [account, projectId, conversationId, Number(summarizedUntilSessionId) || 0]
    : [account, projectId, title];
  const sql = conversationId
    ? `select s.*, coalesce(m.content, s.content, '') as content
         from sessions s left join messages m on m.id = s.message_id
        where s.account = ? and s.project_id = ? and s.conversation_id = ? and s.id > ?
        order by s.id asc`
    : `select s.*, coalesce(m.content, s.content, '') as content
         from sessions s left join messages m on m.id = s.message_id
        where s.account = ? and s.project_id = ? and s.title = ?
        order by s.id asc`;
  const [result] = await connection.query(sql, params);
  return { result, length: result.length };
}
