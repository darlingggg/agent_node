import express from 'express';
import { fileURLToPath } from 'url';
import authJWT from '../../middleware/authJWT.js';
import {
  getUserProfile,
  login,
  logout,
  refreshAccessToken,
  register,
  updateUserProfile,
} from '../../auth/index.js';
import {
  buildWechatOAuthUrl,
  loginWithWechatCode,
  verifyWechatServerSignature,
} from '../../auth/providers/wechat.js';
import { buildQQOAuthUrl, loginWithQQCode } from '../../auth/providers/qq.js';
import { normalizeOAuthReturnUrl, OAuthSessionStore } from '../../auth/oauth/oauthSession.js';
import { getOAuthCallbackAction } from '../../auth/oauth/oauthCallback.js';
import { QQ_REDIRECT_URI } from '../../../key.js';

const router = express.Router();
const allowedOrigins = ['http://localhost:5173', 'https://darling.xin', 'https://www.darling.xin'];
const wechatSessions = new OAuthSessionStore('wechat');
const qqSessions = new OAuthSessionStore('qq');
const oauthPages = {
  success: fileURLToPath(new URL('../../auth/pages/oauth-success.html', import.meta.url)),
  processing: fileURLToPath(new URL('../../auth/pages/oauth-processing.html', import.meta.url)),
  error: fileURLToPath(new URL('../../auth/pages/oauth-error.html', import.meta.url)),
};

function getExternalOrigin(req) {
  const forwardedProto = req.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const forwardedHost = req.get('x-forwarded-host')?.split(',')[0]?.trim();
  return `${forwardedProto || req.protocol}://${forwardedHost || req.get('host')}`;
}

function getWechatRedirectUri(req) {
  return String(req.query.redirectUri || `${getExternalOrigin(req)}/api/auth/wechat/callback`);
}

function getQQRedirectUri() {
  return String(QQ_REDIRECT_URI || '');
}

function getEventsUrl(provider, state, streamToken) {
  const params = new URLSearchParams({ state, streamToken });
  return `/auth/${provider}/events?${params.toString()}`;
}

function sendOAuthSession(res, provider, authSession, authorizeUrl, message) {
  const { state, streamToken, expiresAt } = authSession;
  const { redirectUri } = authSession.session;
  res.cc(0, message, {
    authorizeUrl,
    redirectUri,
    state,
    streamToken,
    eventsUrl: getEventsUrl(provider, state, streamToken),
    expiresAt,
  });
}

function subscribeOAuthEvents(store, req, res) {
  const result = store.subscribe({
    state: String(req.query.state || ''),
    streamToken: String(req.query.streamToken || ''),
    req,
    res,
  });
  if (!result.ok && !res.headersSent) {
    res.status(result.status).json({ status: 1, message: result.message, data: null });
  }
}

function sendOAuthResultPage(res, result, returnUrl = '') {
  const status = result === true ? 'success' : result === false ? 'error' : result;
  if (returnUrl && status !== 'processing') {
    res.setHeader('Cache-Control', 'no-store');
    return res.redirect(302, returnUrl);
  }

  res.status(200);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; frame-ancestors 'none'",
  );
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-OAuth-Result', status);
  return res.sendFile(oauthPages[status]);
}

function publishLoginResult(store, state, providerName, result) {
  store.publish(state, {
    event: 'login_success',
    status: 'success',
    message: `${providerName}登录成功`,
    result: { ...result, state },
  });
}

function publishLoginError(store, state, error) {
  store.publish(state, {
    event: 'login_error',
    status: 'error',
    message: error.message,
  });
}

router.get('/wechat', (req, res) => {
  const { signature, timestamp, nonce, echostr } = req.query;
  if (!verifyWechatServerSignature({ signature, timestamp, nonce })) {
    res.status(403).type('text/plain').send('Forbidden');
    return;
  }
  res.type('text/plain').send(String(echostr || ''));
});

router.post('/wechat', (_req, res) => {
  res.type('text/plain').send('success');
});

router.get('/auth/wechat/url', (req, res) => {
  let authSession;
  try {
    const redirectUri = getWechatRedirectUri(req);
    authSession = wechatSessions.create({ redirectUri });
    const authorizeUrl = buildWechatOAuthUrl({ redirectUri, state: authSession.state });
    sendOAuthSession(res, 'wechat', authSession, authorizeUrl, '获取微信授权链接成功');
  } catch (error) {
    if (authSession) wechatSessions.remove(authSession.state);
    res.cc(1, error.message);
  }
});

router.get('/auth/wechat/bind', authJWT, (req, res) => {
  let authSession;
  try {
    const redirectUri = getWechatRedirectUri(req);
    authSession = wechatSessions.create({ redirectUri, account: req.user.account });
    const authorizeUrl = buildWechatOAuthUrl({ redirectUri, state: authSession.state });
    sendOAuthSession(res, 'wechat', authSession, authorizeUrl, '获取微信授权链接成功');
  } catch (error) {
    if (authSession) wechatSessions.remove(authSession.state);
    res.cc(1, error.message);
  }
});

router.get('/auth/wechat/events', (req, res) => {
  subscribeOAuthEvents(wechatSessions, req, res);
});

router.get('/auth/wechat/callback', async (req, res) => {
  const state = req.query.state ? String(req.query.state) : '';
  const authSession = wechatSessions.get(state);
  if (!authSession || authSession.status !== 'waiting') {
    return sendOAuthResultPage(res, false);
  }

  try {
    wechatSessions.publish(state, {
      event: 'scan_complete',
      status: 'processing',
      message: '扫码完成，正在登录...',
    });
    const result = await loginWithWechatCode(
      String(req.query.code || ''),
      authSession,
      authSession.account || '',
    );
    publishLoginResult(wechatSessions, state, '微信', result);
    return sendOAuthResultPage(res, true);
  } catch (error) {
    publishLoginError(wechatSessions, state, error);
    return sendOAuthResultPage(res, false);
  }
});

router.get('/auth/qq/url', (req, res) => {
  let authSession;
  try {
    const redirectUri = getQQRedirectUri();
    const returnUrl = normalizeOAuthReturnUrl(req.query.returnUrl, allowedOrigins);
    authSession = qqSessions.create({ redirectUri, returnUrl });
    const authorizeUrl = buildQQOAuthUrl({ redirectUri, state: authSession.state });
    sendOAuthSession(res, 'qq', authSession, authorizeUrl, '获取 QQ 授权链接成功');
  } catch (error) {
    if (authSession) qqSessions.remove(authSession.state);
    res.cc(1, error.message);
  }
});

router.get('/auth/qq/bind', authJWT, (req, res) => {
  let authSession;
  try {
    const redirectUri = getQQRedirectUri();
    authSession = qqSessions.create({ redirectUri, account: req.user.account });
    const authorizeUrl = buildQQOAuthUrl({ redirectUri, state: authSession.state });
    sendOAuthSession(res, 'qq', authSession, authorizeUrl, '获取 QQ 绑定链接成功');
  } catch (error) {
    if (authSession) qqSessions.remove(authSession.state);
    res.cc(1, error.message);
  }
});

router.get('/auth/qq/events', (req, res) => {
  subscribeOAuthEvents(qqSessions, req, res);
});

async function handleQQCallback(req, res) {
  const state = req.query.state ? String(req.query.state) : '';
  const authSession = qqSessions.get(state);
  const callbackAction = getOAuthCallbackAction(authSession);

  if (callbackAction === 'error') return sendOAuthResultPage(res, false, authSession?.returnUrl);
  if (callbackAction === 'success') return sendOAuthResultPage(res, true, authSession.returnUrl);
  if (callbackAction === 'processing') return sendOAuthResultPage(res, 'processing');

  try {
    if (req.query.error) throw new Error(String(req.query.error_description || req.query.error));
    qqSessions.publish(state, {
      event: 'scan_complete',
      status: 'processing',
      message: '扫码完成，正在登录...',
    });
    const result = await loginWithQQCode(
      String(req.query.code || ''),
      authSession,
      authSession.account || '',
    );
    publishLoginResult(qqSessions, state, 'QQ ', result);
    return sendOAuthResultPage(res, true, authSession.returnUrl);
  } catch (error) {
    publishLoginError(qqSessions, state, error);
    return sendOAuthResultPage(res, false, authSession.returnUrl);
  }
}

router.get('/oauth/callback', handleQQCallback);
router.get('/auth/qq/callback', handleQQCallback);

router.post('/register', async (req, res) => {
  try {
    const { account, password, nickname } = req.body;
    res.cc(0, '注册成功', await register(account, password, nickname));
  } catch (error) {
    res.cc(1, error.message);
  }
});

router.post('/login', async (req, res) => {
  try {
    const { account, password } = req.body;
    res.cc(0, '登录成功', await login(account, password));
  } catch (error) {
    res.cc(1, error.message);
  }
});

router.post('/auth/refresh', async (req, res) => {
  try {
    res.cc(0, '刷新成功', await refreshAccessToken(req.body.refreshToken));
  } catch (error) {
    res.cc(1, error.message);
  }
});

router.post('/auth/logout', async (req, res) => {
  try {
    await logout(req.body.refreshToken);
    res.cc(0, '登出成功');
  } catch (error) {
    res.cc(1, error.message);
  }
});

router.get('/user/profile', authJWT, async (req, res) => {
  try {
    res.cc(0, '获取成功', await getUserProfile(req.user.id));
  } catch (error) {
    res.cc(1, error.message);
  }
});

router.patch('/user/profile', authJWT, async (req, res) => {
  try {
    res.cc(0, '修改成功', await updateUserProfile(req.user.id, req.body));
  } catch (error) {
    res.cc(1, error.message);
  }
});

export default router;
