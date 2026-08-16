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
 * run 会持续回调 onEvent；文本片段会累积到内存、定时写库，所有事件都会广播给订阅客户端。
 * 任务完成、失败或取消后会强制刷新 assistant 正文，再调用 onSettled 结算用量并发送 usage 事件。
 * 每个任务持有独立 AbortController，使主动取消可以中断上游模型请求，而不仅是关闭浏览器 SSE。
 * @param {object} params 流任务配置
 * @param {number|string} params.messageId assistant 正文对应的 messages.id，也是 activeStreams 的键
 * @param {number|string} params.sessionId assistant 对应的 sessions.id
 * @param {(onEvent: Function, signal: AbortSignal) => Promise<object>} params.run AI 对话执行函数，返回整轮 usage
 * @param {(content: string, usage: object, meta: object) => Promise<void>} [params.onComplete] 正常完成后的缓存同步回调
 * @param {(usage: object|undefined, status: string) => Promise<object>} [params.onSettled] 完成/失败/取消后的用量结算回调
 * @returns {object} 当前进程内的活跃流状态；相同 messageId 已存在时直接返回原状态
 */
export const startChatStream = ({
  messageId,
  sessionId,
  run,
  onComplete,
  onSettled,
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
    abortController: new AbortController(),
    cancelRequested: false,
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
    .then(() => run(onEvent, state.abortController.signal))
    .then(async (runResult) => {
      state.status = 'completed';
      if (state.flushTimer) clearTimeout(state.flushTimer);
      state.flushTimer = null;
      await flushMessage(state, true);
      await connection.query(
        'update sessions set status = ?, error_msg = null where id = ?',
        ['completed', sessionId]
      );
      let settlement = null;
      let settlementFailed = false;
      if (onSettled) {
        try {
          settlement = await onSettled(runResult, 'completed');
        } catch (settleErr) {
          settlementFailed = true;
          console.error('[chat-stream] usage settlement failed:', settleErr);
          broadcast(state, { event: 'usage_error', data: 'Token 用量结算失败' });
        }
      }
      await onComplete?.(state.content, runResult, { settlementFailed });
      if (settlement) broadcast(state, { event: 'usage', data: settlement });
      broadcast(state, { event: 'done', data: null });
      closeAllClients(state);
      activeStreams.delete(id);
    })
    .catch(async (err) => {
      state.status = state.cancelRequested || err?.name === 'AbortError' ? 'cancelled' : 'failed';
      state.error = err?.message || String(err);
      if (state.flushTimer) clearTimeout(state.flushTimer);
      state.flushTimer = null;
      await flushMessage(state, true).catch((flushErr) => {
        console.error('[chat-stream] final flush failed:', flushErr);
      });
      await connection.query(
        'update sessions set status = ?, error_msg = ? where id = ?',
        [state.status, state.status === 'failed' ? state.error : null, sessionId]
      ).catch((updateErr) => {
        console.error('[chat-stream] status update failed:', updateErr);
      });
      if (onSettled) {
        try {
          const settlement = await onSettled(err?.chatUsage, state.status);
          if (settlement) broadcast(state, { event: 'usage', data: settlement });
        } catch (settleErr) {
          console.error('[chat-stream] usage settlement failed:', settleErr);
        }
      }
      if (state.status === 'cancelled') broadcast(state, { event: 'cancelled', data: null });
      else broadcast(state, { event: 'error', data: state.error });
      closeAllClients(state);
      activeStreams.delete(id);
    });

  return state;
}

/**
 * 主动取消当前进程中的生成任务。
 * 该方法先校验 messageId 所属账号，再触发任务的 AbortController；实际状态更新和部分 Token 结算由 startChatStream 的异常分支完成。
 * 如果任务已结束或不在当前进程，只返回数据库/内存中的现有状态，不重复取消。
 * @param {{messageId: number|string, account: string}} params 目标 assistant messageId 与当前账号
 * @returns {Promise<{cancelled: boolean, status: string}>} 是否发起取消及任务当前状态
 * @throws {Error} 消息不存在或当前账号无权访问
 */
export const cancelChatStream = async ({ messageId, account }) => {
  const id = Number(messageId);
  const session = await getMessageSession(id, account);
  if (!session) throw new Error('messageId 不存在或无权限访问');
  const state = activeStreams.get(id);
  if (!state) return { cancelled: false, status: session.status };
  if (state.status !== 'streaming') return { cancelled: false, status: state.status };
  state.cancelRequested = true;
  state.abortController.abort();
  return { cancelled: true, status: 'cancelling' };
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

  if (session.status === 'cancelled') {
    writeSse(res, { event: 'cancelled', data: null });
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
