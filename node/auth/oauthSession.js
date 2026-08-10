import crypto from 'crypto';

const DEFAULT_AUTH_TIMEOUT_MS = 3 * 60 * 1000;
const DEFAULT_RESULT_RETENTION_MS = 3 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 15 * 1000;
const TERMINAL_STATUSES = new Set(['success', 'error', 'expired']);

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest();
}

function tokenMatches(token, expectedHash) {
  const actualHash = hashToken(token);
  return crypto.timingSafeEqual(actualHash, expectedHash);
}

function writeSSE(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function normalizeOAuthReturnUrl(value, allowedOrigins) {
  if (!value) return '';

  let returnUrl;
  try {
    returnUrl = new URL(String(value));
  } catch {
    throw new Error('OAuth 回跳地址无效');
  }

  if (!allowedOrigins.includes(returnUrl.origin)) {
    throw new Error('OAuth 回跳地址不在允许范围内');
  }
  return returnUrl.toString();
}

export class OAuthSessionStore {
  constructor(provider, {
    authTimeoutMs = DEFAULT_AUTH_TIMEOUT_MS,
    resultRetentionMs = DEFAULT_RESULT_RETENTION_MS,
  } = {}) {
    this.provider = provider;
    this.authTimeoutMs = authTimeoutMs;
    this.resultRetentionMs = resultRetentionMs;
    this.sessions = new Map();
  }

  create(data = {}) {
    const state = crypto.randomBytes(16).toString('hex');
    const streamToken = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    const session = {
      ...data,
      state,
      streamTokenHash: hashToken(streamToken),
      status: 'waiting',
      desc: '等待扫码...',
      timeout: now + this.authTimeoutMs,
      clients: new Set(),
      lastPayload: {
        event: 'waiting_scan',
        data: {
          provider: this.provider,
          status: 'waiting',
          message: '等待扫码...',
        },
      },
      expiryTimer: null,
    };

    this.sessions.set(state, session);
    this.#scheduleExpiry(session, this.authTimeoutMs);

    return {
      session,
      state,
      streamToken,
      expiresAt: new Date(session.timeout).toISOString(),
    };
  }

  get(state) {
    const session = this.sessions.get(String(state || ''));
    if (!session) return null;

    if (!TERMINAL_STATUSES.has(session.status) && Date.now() > session.timeout) {
      this.publish(session.state, {
        event: 'auth_expired',
        status: 'expired',
        message: '二维码已过期，请重新获取',
      });
    }

    return session;
  }

  remove(state) {
    const session = this.sessions.get(String(state || ''));
    if (!session) return;

    clearTimeout(session.expiryTimer);
    for (const client of [...session.clients]) {
      client.cleanup();
      client.res.end();
    }
    this.sessions.delete(session.state);
  }

  publish(state, { event, status, message, result = null }) {
    const session = this.sessions.get(String(state || ''));
    if (!session) return null;

    session.status = status;
    session.desc = message;
    session.result = result;
    session.lastPayload = {
      event,
      data: {
        provider: this.provider,
        status,
        message,
        ...(result ? { result } : {}),
      },
    };

    const isTerminal = TERMINAL_STATUSES.has(status);
    for (const client of [...session.clients]) {
      try {
        if (isTerminal) client.res.write('retry: 60000\n\n');
        writeSSE(client.res, session.lastPayload);
      } catch {
        client.cleanup();
        continue;
      }

      if (isTerminal) {
        client.cleanup();
        client.res.end();
      }
    }

    if (isTerminal) {
      clearTimeout(session.expiryTimer);
      session.timeout = Date.now() + this.resultRetentionMs;
      this.#scheduleExpiry(session, this.resultRetentionMs, true);
    }

    return session;
  }

  subscribe({ state, streamToken, req, res }) {
    const session = this.get(state);
    if (!session) {
      return { ok: false, status: 404, message: '授权会话不存在' };
    }

    if (!streamToken || !tokenMatches(streamToken, session.streamTokenHash)) {
      return { ok: false, status: 403, message: 'SSE 订阅凭证无效' };
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    if (TERMINAL_STATUSES.has(session.status)) res.write('retry: 60000\n\n');
    writeSSE(res, session.lastPayload);

    if (TERMINAL_STATUSES.has(session.status)) {
      res.end();
      return { ok: true };
    }

    const client = { res, cleanup: null };
    const heartbeat = setInterval(() => {
      try {
        res.write(': heartbeat\n\n');
      } catch {
        client.cleanup();
      }
    }, HEARTBEAT_INTERVAL_MS);
    heartbeat.unref?.();

    client.cleanup = () => {
      clearInterval(heartbeat);
      session.clients.delete(client);
    };

    session.clients.add(client);
    req.once('close', client.cleanup);
    res.once('close', client.cleanup);
    return { ok: true };
  }

  #scheduleExpiry(session, delay, removeOnly = false) {
    clearTimeout(session.expiryTimer);
    session.expiryTimer = setTimeout(() => {
      if (removeOnly || TERMINAL_STATUSES.has(session.status)) {
        this.remove(session.state);
        return;
      }

      this.publish(session.state, {
        event: 'auth_expired',
        status: 'expired',
        message: '二维码已过期，请重新获取',
      });
    }, delay);
    session.expiryTimer.unref?.();
  }
}
