/** 将响应切换为 SSE，关闭缓存及 Nginx 缓冲，立即发送响应头以便前端开始接收事件。 */
export function prepareSse(res) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
}

/** 把 { event, data } 编码为一条 SSE data 消息；响应已结束则跳过。 */
export function writeSse(res, event) {
  if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
}
