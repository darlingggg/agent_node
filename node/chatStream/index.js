import connection from '../../Mysql/index.js';
import { chat } from '../openai/index.js';

const FLUSH_INTERVAL_MS = 500;
const FLUSH_CHARS = 800;

// 当前进程内正在生成的 assistant 消息，key 为 messageId。
// 注意：这是内存状态，服务重启后只能从数据库读取已落库内容，不能继续接管旧任务。
const activeStreams = new Map();

/** 按 SSE 格式写入一条事件，浏览器 EventSource/fetch 流会按 data 行解析。 */
const writeSse = (res, msg) => {
  if (res.writableEnded) return;
  res.write(`data: ${JSON.stringify(msg)}\n\n`);
}

/** 关闭单个订阅客户端的响应流。 */
const closeClient = (client) => {
  if (client.res.writableEnded) return;
  client.res.end();
}

/** 生成完成或失败后，关闭所有还在订阅该消息的客户端。 */
const closeAllClients = (state) => {
  for (const client of state.clients) closeClient(client);
  state.clients.clear();
}

/** 向订阅同一个 messageId 的所有客户端广播同一条 SSE 消息。 */
const broadcast = (state, msg) => {
  for (const client of state.clients) writeSse(client.res, msg);
}

/**
 * 将内存中的最新 assistant 内容写入 messages 表。
 * 普通刷新会按时间和字符数节流；force=true 用于结束前强制落库完整内容。
 */
const flushMessage = async (state, force = false) => {
  if (state.flushing) {
    if (force) {
      await state.flushPromise;
      return flushMessage(state, true);
    }
    return;
  }
  if (!force && !state.dirty) return;
  if (!force && Date.now() - state.lastFlushedAt < FLUSH_INTERVAL_MS && state.pendingChars < FLUSH_CHARS) return;

  state.flushing = true;
  state.flushPromise = (async () => {
    do {
      const content = state.content;
      await connection.query('update messages set content = ? where id = ?', [content, state.messageId]);
      state.dirty = state.content !== content;
      state.pendingChars = state.dirty ? state.pendingChars : 0;
      state.lastFlushedAt = Date.now();
    } while (force && state.dirty);
  })();
  try {
    await state.flushPromise;
  } finally {
    state.flushing = false;
    state.flushPromise = null;
  }
}

/** 安排一次延迟落库，避免 AI 每吐出一个 token 就更新数据库。 */
const scheduleFlush = (state) => {
  if (state.flushTimer) return;
  state.flushTimer = setTimeout(async () => {
    state.flushTimer = null;
    await flushMessage(state).catch((err) => {
      console.error('[chat-stream] flush failed:', err);
    });
    if (state.status === 'streaming' && state.dirty) scheduleFlush(state);
  }, FLUSH_INTERVAL_MS);
}

/** 获取当前进程内正在生成的流状态；仅用于调试或内部判断。 */
export const getActiveStream = (messageId) => activeStreams.get(Number(messageId));

/** 查询 messageId 对应的会话，并校验它属于当前账号。 */
export const getMessageSession = async (messageId, account) => {
  const [rows] = await connection.query(
    `select s.*, m.content as message_content
     from sessions s
     left join messages m on m.id = s.message_id
     where s.message_id = ? and s.account = ?
     limit 1`,
    [messageId, account]
  );
  return rows[0] || null;
}

/**
 * 启动一次 AI 流式生成任务。
 * run 会持续回调 onEvent；文本片段会累积到内存、定时写库，并广播给订阅客户端。
 */
export const startChatStream = ({
  messageId,
  sessionId,
  run,
  onComplete,
}) => {
  const id = Number(messageId);
  if (activeStreams.has(id)) return activeStreams.get(id);

  const state = {
    messageId: id,
    sessionId,
    content: '',
    status: 'streaming',
    error: null,
    clients: new Set(),
    dirty: false,
    pendingChars: 0,
    flushing: false,
    flushPromise: null,
    flushTimer: null,
    lastFlushedAt: Date.now(),
  };
  activeStreams.set(id, state);

  // 统一处理 AI 输出：文本事件负责追加内容并触发落库，所有事件都会转发给客户端。
  const onEvent = (msg) => {
    if (msg?.event === 'text' && typeof msg.data === 'string') {
      state.content += msg.data;
      state.dirty = true;
      state.pendingChars += msg.data.length;
      scheduleFlush(state);
    }
    broadcast(state, msg);
  }

  // 后台执行 AI 生成，不阻塞接口返回；结束时更新会话状态并通知所有订阅者。
  Promise.resolve()
    .then(() => run(onEvent))
    .then(async () => {
      state.status = 'completed';
      if (state.flushTimer) clearTimeout(state.flushTimer);
      state.flushTimer = null;
      await flushMessage(state, true);
      await connection.query(
        'update sessions set status = ?, error_msg = null where id = ?',
        ['completed', sessionId]
      );
      await onComplete?.(state.content);
      broadcast(state, { event: 'done', data: null });
      closeAllClients(state);
      activeStreams.delete(id);
    })
    .catch(async (err) => {
      state.status = 'failed';
      state.error = err?.message || String(err);
      if (state.flushTimer) clearTimeout(state.flushTimer);
      state.flushTimer = null;
      await flushMessage(state, true).catch((flushErr) => {
        console.error('[chat-stream] final flush failed:', flushErr);
      });
      await connection.query(
        'update sessions set status = ?, error_msg = ? where id = ?',
        ['failed', state.error, sessionId]
      ).catch((updateErr) => {
        console.error('[chat-stream] status update failed:', updateErr);
      });
      broadcast(state, { event: 'error', data: state.error });
      closeAllClients(state);
      activeStreams.delete(id);
    });

  return state;
}

/**
 * 订阅某条 assistant 消息的 SSE 流。
 * offset 用来断线重连时只补发缺失内容，避免前端重复显示已经收到的文本。
 */
export const subscribeChatStream = async ({ messageId, account, offset = 0, res }) => {
  const id = Number(messageId);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const session = await getMessageSession(id, account);
  if (!session) {
    writeSse(res, { event: 'error', data: 'messageId 不存在或无权限访问' });
    res.end();
    return;
  }

  const state = activeStreams.get(id);
  const content = state?.content ?? session.message_content ?? '';
  // 先补发 offset 之后的已生成内容，再决定是否继续挂到活跃流上。
  if (safeOffset < content.length) {
    writeSse(res, { event: 'text', data: content.slice(safeOffset) });
  }

  if (session.status === 'completed') {
    writeSse(res, { event: 'done', data: null });
    res.end();
    return;
  }

  if (session.status === 'failed') {
    writeSse(res, { event: 'error', data: session.error_msg || '生成失败' });
    res.end();
    return;
  }

  if (!state) {
    writeSse(res, { event: 'error', data: '生成任务不在当前服务进程中，请刷新会话查看已保存内容' });
    res.end();
    return;
  }

  const client = { res };
  state.clients.add(client);
  // 客户端主动断开时移除引用，避免后续广播写入已关闭连接。
  res.on('close', () => {
    state.clients.delete(client);
  });
}

export const runAiChat = chat;
