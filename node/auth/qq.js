import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import connection from '../../Mysql/index.js';
import { issueTokenPair } from './index.js';
import { QQ_APP_ID, QQ_APP_KEY } from '../../key.js';

function assertQQOAuthConfig() {
  if (!QQ_APP_ID || !QQ_APP_KEY) {
    throw new Error('QQ_APP_ID 和 QQ_APP_KEY 不能为空');
  }
}

function assertQQSuccess(data, step) {
  if (data.error || (data.ret !== undefined && Number(data.ret) !== 0)) {
    const message = data.error_description || data.msg || data.error;
    throw new Error(`${step}失败: ${message}`);
  }
}

function normalizeNickname(nickname, openid) {
  const fallback = `QQ用户${openid.slice(-6)}`;
  return Array.from(String(nickname || fallback)).slice(0, 20).join('');
}

async function requestQQJson(url, step) {
  const response = await fetch(url);
  const text = await response.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${step}失败: QQ 返回了无法解析的数据`);
  }

  if (!response.ok) {
    throw new Error(`${step}失败: HTTP ${response.status}`);
  }

  assertQQSuccess(data, step);
  return data;
}

export function buildQQOAuthUrl({ redirectUri, state, scope = 'get_user_info' }) {
  assertQQOAuthConfig();

  if (!redirectUri) {
    throw new Error('QQ 授权回调地址不能为空');
  }

  if (!state) {
    throw new Error('state 不能为空');
  }

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: QQ_APP_ID,
    redirect_uri: redirectUri,
    state,
    scope,
  });

  return `https://graph.qq.com/oauth2.0/authorize?${params.toString()}`;
}

export async function getQQOAuthAccessToken({ code, redirectUri }) {
  assertQQOAuthConfig();

  if (!code) {
    throw new Error('QQ 授权 code 不能为空');
  }

  if (!redirectUri) {
    throw new Error('QQ 授权回调地址不能为空');
  }

  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: QQ_APP_ID,
    client_secret: QQ_APP_KEY,
    code,
    redirect_uri: redirectUri,
    fmt: 'json',
    need_openid: '1',
  });

  return requestQQJson(
    `https://graph.qq.com/oauth2.0/token?${params.toString()}`,
    '获取 QQ access_token'
  );
}

export async function getQQUserInfo({ accessToken, openid }) {
  if (!accessToken || !openid) {
    throw new Error('QQ access_token 和 openid 不能为空');
  }

  const params = new URLSearchParams({
    access_token: accessToken,
    oauth_consumer_key: QQ_APP_ID,
    openid,
  });

  return requestQQJson(
    `https://graph.qq.com/user/get_user_info?${params.toString()}`,
    '获取 QQ 用户信息'
  );
}

export async function loginWithQQCode(code, qqAuth, account = '') {
  const oauthToken = await getQQOAuthAccessToken({
    code,
    redirectUri: qqAuth.redirectUri,
  });
  const openid = String(oauthToken.openid || '');

  if (!openid) {
    throw new Error('QQ 授权结果中缺少 openid');
  }

  const userInfo = await getQQUserInfo({
    accessToken: oauthToken.access_token,
    openid,
  });
  qqAuth.desc = '获取用户信息完毕...';

  const targetAccount = account || `qq_${openid}`;
  const nickname = normalizeNickname(userInfo.nickname, openid);
  const avatar = userInfo.figureurl_qq_2 || userInfo.figureurl_qq_1 || userInfo.figureurl_2 || '';

  const [openidRows] = await connection.query(
    'SELECT id, account, nickname FROM users WHERE qq_openid = ?',
    [openid]
  );

  let user = openidRows[0];

  if (account && user && user.account !== targetAccount) {
    throw new Error('该 QQ 已绑定其他账号');
  }

  if (!user && account) {
    const [accountRows] = await connection.query(
      'SELECT id, account, nickname FROM users WHERE account = ?',
      [targetAccount]
    );
    user = accountRows[0];

    if (!user) {
      throw new Error('要绑定的账号不存在');
    }
  }

  if (!user) {
    const randomPassword = crypto.randomBytes(32).toString('hex');
    const hashedPassword = await bcrypt.hash(randomPassword, 10);

    try {
      const [result] = await connection.query(
        'INSERT INTO users (account, password, nickname, qq_openid, avatar) VALUES (?, ?, ?, ?, ?)',
        [targetAccount, hashedPassword, nickname, openid, avatar]
      );

      user = { id: result.insertId, account: targetAccount, nickname };
    } catch (err) {
      if (err?.code !== 'ER_DUP_ENTRY') {
        throw err;
      }

      const [latestRows] = await connection.query(
        'SELECT id, account, nickname FROM users WHERE qq_openid = ? OR account = ?',
        [openid, targetAccount]
      );
      user = latestRows[0];

      if (!user) {
        throw err;
      }
    }
  } else {
    const [result] = await connection.query(
      `UPDATE users
       SET nickname = IF(nickname IS NULL OR nickname = '', ?, nickname),
           avatar = IF(avatar IS NULL OR avatar = '', ?, avatar),
           qq_openid = ?
       WHERE id = ?`,
      [nickname, avatar, openid, user.id]
    );

    if (result.affectedRows !== 1) {
      throw new Error('账号绑定 QQ 失败');
    }
  }

  const tokenPair = await issueTokenPair(user);

  return {
    ...tokenPair,
    qq: {
      openid,
      nickname: userInfo.nickname || nickname,
      avatar,
    },
  };
}
