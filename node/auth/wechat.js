import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import connection from '../../Mysql/index.js';
import { issueTokenPair } from './index.js';
import { createStorageKey } from '../utils/storageKey.js';
import { WECHAT_VERIFY_TOKEN, WECHAT_APP_ID, WECHAT_APP_SECRET, WECHAT_OAUTH_SCOPE } from '../../key.js';

export function verifyWechatServerSignature({ signature, timestamp, nonce }) {
  if (!signature || !timestamp || !nonce) {
    return false;
  }

  const digest = crypto
    .createHash('sha1')
    .update([WECHAT_VERIFY_TOKEN, timestamp, nonce].sort().join(''))
    .digest('hex');

  return digest === signature;
}

function assertWechatOAuthConfig() {
  if (!WECHAT_APP_ID || !WECHAT_APP_SECRET) {
    throw new Error('WECHAT_APP_ID 和 WECHAT_APP_SECRET 不能为空');
  }
}

function assertSuccess(data, step) {
  if (data.errcode) {
    throw new Error(`${step}失败: ${data.errmsg || data.errcode}`);
  }
}

function normalizeNickname(nickname, openid) {
  const fallback = `微信用户${openid.slice(-6)}`;
  return Array.from(String(nickname || fallback)).slice(0, 20).join('');
}

async function requestWechatJson(url, step) {
  const response = await fetch(url);
  const data = await response.json();
  assertSuccess(data, step);
  return data;
}

export function buildWechatOAuthUrl({ redirectUri, state, scope = WECHAT_OAUTH_SCOPE }) {
  assertWechatOAuthConfig();

  if (!redirectUri) {
    throw new Error('微信授权回调地址不能为空');
  }

  if (!state) {
    throw new Error('state 不能为空');
  }

  const params = new URLSearchParams({
    appid: WECHAT_APP_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope,
    state: state,
  });

  return `https://open.weixin.qq.com/connect/oauth2/authorize?${params.toString()}#wechat_redirect`;
}

export async function getWechatOAuthAccessToken(code) {
  assertWechatOAuthConfig();

  if (!code) {
    throw new Error('微信授权 code 不能为空');
  }

  const params = new URLSearchParams({
    appid: WECHAT_APP_ID,
    secret: WECHAT_APP_SECRET,
    code,
    grant_type: 'authorization_code',
  });

  return requestWechatJson(
    `https://api.weixin.qq.com/sns/oauth2/access_token?${params.toString()}`,
    '获取微信网页授权 access_token'
  );
}

export async function getWechatUserInfo({ accessToken, openid }) {
  if (!accessToken || !openid) {
    throw new Error('微信 access_token 和 openid 不能为空');
  }

  const params = new URLSearchParams({
    access_token: accessToken,
    openid,
    lang: 'zh_CN',
  });

  return requestWechatJson(
    `https://api.weixin.qq.com/sns/userinfo?${params.toString()}`,
    '获取微信用户信息'
  );
}

export async function loginWithWechatCode(code,wechatAuth,account=null) {
  const oauthToken = await getWechatOAuthAccessToken(code);
  const userInfo = await getWechatUserInfo({
    accessToken: oauthToken.access_token,
    openid: oauthToken.openid,
  });
  wechatAuth.desc = '获取用户信息完毕...';
  const openid = userInfo.openid || oauthToken.openid;
  const targetAccount = account || `wx_${openid}`;
  const nickname = normalizeNickname(userInfo.nickname, openid);

  const [openidRows] = await connection.query(
    'SELECT id, account, nickname FROM users WHERE wx_openid = ?',
    [openid]
  );

  let user = openidRows[0];

  if (account && user && user.account !== targetAccount) {
    throw new Error('该微信已绑定其他账号');
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
    // 初始密码为123456
    const hashedPassword = await bcrypt.hash("123456", 10);

    try {
      const [result] = await connection.query(
        `INSERT INTO users
         (account, password, nickname, wx_openid, avatar, storage_key)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [targetAccount, hashedPassword, nickname, openid, userInfo.headimgurl, createStorageKey()]
      );

      user = { id: result.insertId, account: targetAccount, nickname, avatar: userInfo.headimgurl };
    } catch (err) {
      if (err?.code !== 'ER_DUP_ENTRY') {
        throw err;
      }

      const [latestRows] = await connection.query(
        'SELECT id, account, nickname FROM users WHERE wx_openid = ? OR account = ?',
        [openid, targetAccount]
      );
      user = latestRows[0];
    }
  }else{
    const [result] = await connection.query(
      `
      UPDATE users
      SET
        nickname = IF(nickname IS NULL OR nickname = '', ?, nickname),
        avatar = IF(avatar IS NULL OR avatar = '', ?, avatar),
        wx_openid = ?
      WHERE id = ?
      `,
      [userInfo.nickname, userInfo.headimgurl, openid, user.id]
    );
    if(result.affectedRows !== 1) throw new Error('账号绑定微信失败');
  }

  const tokenPair = await issueTokenPair(user, { recordLogin: !account });

  return {
    ...tokenPair,
    wechat: {
      openid,
      unionid: userInfo.unionid || null,
      nickname: userInfo.nickname || nickname,
      avatar: userInfo.headimgurl || '',
    },
  };
}
