import connection from '../Mysql/index.js';

const [action, rawId] = process.argv.slice(2);
const title = '工具回显压力验收（临时数据）';

async function seed(projectId) {
  const db = await connection.getConnection();
  try {
    await db.beginTransaction();
    const [[project]] = await db.query(
      'SELECT account FROM projects WHERE id = ? AND deleted_at IS NULL',
      [projectId],
    );
    if (!project) throw new Error('项目不存在');
    const [conversation] = await db.query(
      'INSERT INTO conversations (account, project_id, title) VALUES (?, ?, ?)',
      [project.account, projectId, title],
    );
    const conversationId = conversation.insertId;
    let lastAssistant = null;
    for (let index = 0; index < 61; index += 1) {
      await db.query(
        'INSERT INTO sessions (project_id, title, account, role, content, conversation_id) VALUES (?, ?, ?, ?, ?, ?)',
        [projectId, title, project.account, 'user', `验收消息 ${index + 1}`, conversationId],
      );
      const [message] = await db.query(
        'INSERT INTO messages (content) VALUES (?)',
        [`第 ${index + 1} 条回复。${index === 60 ? '以下是工具执行过程。' : '历史分页测试。'}`],
      );
      const [session] = await db.query(
        'INSERT INTO sessions (message_id, project_id, title, account, role, content, conversation_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [message.insertId, projectId, title, project.account, 'assistant', '', conversationId],
      );
      lastAssistant = { messageId: message.insertId, sessionId: session.insertId };
    }
    const startedAt = new Date();
    const rows = Array.from({ length: 100 }, (_, index) => [
      lastAssistant.messageId,
      lastAssistant.sessionId,
      projectId,
      conversationId,
      project.account,
      `acceptance-${index + 1}`,
      'get_file_content',
      index + 1,
      18,
      'succeeded',
      JSON.stringify({ path: `src/fixture-${index + 1}.vue` }),
      JSON.stringify({ success: true, data: index === 0 ? 'long line\n'.repeat(10000) : `result-${index + 1}` }),
      startedAt,
      startedAt,
      5,
    ]);
    await db.query(
      `INSERT INTO message_tool_calls
        (message_id, assistant_session_id, project_id, conversation_id, account,
         tool_call_id, name, sequence_no, text_offset, status, args_json, result_json,
         started_at, finished_at, duration_ms) VALUES ?`,
      [rows],
    );
    await db.commit();
    console.log(JSON.stringify({ conversationId, messageId: lastAssistant.messageId, toolCount: rows.length, sessionCount: 122 }));
  } catch (error) {
    await db.rollback();
    throw error;
  } finally {
    db.release();
  }
}

async function cleanup(conversationId) {
  const db = await connection.getConnection();
  try {
    await db.beginTransaction();
    const [[fixture]] = await db.query('SELECT title FROM conversations WHERE id = ? FOR UPDATE', [conversationId]);
    if (fixture?.title !== title) throw new Error('不是验收夹具会话，拒绝清理');
    await db.query('DELETE FROM message_tool_calls WHERE conversation_id = ?', [conversationId]);
    const [messages] = await db.query('SELECT message_id FROM sessions WHERE conversation_id = ? AND message_id IS NOT NULL', [conversationId]);
    await db.query('DELETE FROM sessions WHERE conversation_id = ?', [conversationId]);
    if (messages.length) await db.query('DELETE FROM messages WHERE id IN (?)', [messages.map((row) => row.message_id)]);
    await db.query('DELETE FROM conversations WHERE id = ?', [conversationId]);
    await db.commit();
    console.log(JSON.stringify({ cleanedConversationId: conversationId }));
  } catch (error) {
    await db.rollback();
    throw error;
  } finally {
    db.release();
  }
}

try {
  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id <= 0 || !['seed', 'cleanup'].includes(action)) {
    throw new Error('用法: node tests/manual-tool-history-fixture.mjs seed <projectId> | cleanup <conversationId>');
  }
  if (action === 'seed') await seed(id);
  else await cleanup(id);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await connection.end();
}
