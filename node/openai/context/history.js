import connection from '../../../Mysql/index.js';
import { readImageContext } from '../media/image-input.js';

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
  let archivedImages = [];
  if (conversationId && Number(summarizedUntilSessionId) > 0) {
    const [archived] = await connection.query(
      'SELECT image_context FROM sessions WHERE account = ? AND project_id = ? AND conversation_id = ? AND id <= ? AND image_context IS NOT NULL',
      [account, projectId, conversationId, summarizedUntilSessionId],
    );
    archivedImages = [...new Map(archived.flatMap((item) => readImageContext(item.image_context).images).map((image) => [image.imageId, image])).values()];
  }
  return { result, length: result.length, archivedImages };
}
