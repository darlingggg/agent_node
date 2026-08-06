import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import connection from '../../Mysql/index.js';

/** JWT 密钥，生产环境请通过环境变量配置 */
const JWT_SECRET = process.env.JWT_SECRET || 'agentNode_dev_secret';

/** Access Token 过期时间（短） */
const ACCESS_TOKEN_EXPIRES_IN = '6h';

/** Refresh Token 有效期（天） */
const REFRESH_TOKEN_DAYS = 7;

/** Refresh Token 随机字节长度 */
const REFRESH_TOKEN_BYTES = 32;

/** 密码加密盐轮数 */
const SALT_ROUNDS = 10;

/** 昵称默认值，未传时使用账号 */
const DEFAULT_NICKNAME = (account) => account;

/**
 * 生成 Access Token（JWT）
 * @param {object} payload 载荷数据
 * @returns {string}
 */
function createAccessToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRES_IN });
}

/**
 * 生成随机 Refresh Token 明文
 * @returns {string}
 */
function generateRefreshToken() {
  return crypto.randomBytes(REFRESH_TOKEN_BYTES).toString('hex');
}

/**
 * 对 Refresh Token 做 SHA256 哈希，用于存库
 * @param {string} token 明文 refresh token
 * @returns {string}
 */
function hashRefreshToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * 保存 Refresh Token 到数据库
 * @param {number} userId 用户 ID
 * @param {string} refreshToken 明文 refresh token
 */
async function saveRefreshToken(userId, refreshToken) {
  const tokenHash = hashRefreshToken(refreshToken);
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + REFRESH_TOKEN_DAYS);

  await connection.query(
    'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)',
    [userId, tokenHash, expiresAt]
  );
}

/**
 * 登录/注册成功后签发双 Token
 * @param {object} user 用户信息 { id, account, nickname }
 * @returns {Promise<{id: number, account: string, nickname: string, accessToken: string, refreshToken: string}>}
 */
export async function issueTokenPair(user) {
  const accessToken = createAccessToken({
    id: user.id,
    account: user.account,
    nickname: user.nickname,
  });

  const refreshToken = generateRefreshToken();
  await saveRefreshToken(user.id, refreshToken);

  return {
    id: user.id,
    account: user.account,
    nickname: user.nickname,
    accessToken,
    refreshToken,
  };
}

/**
 * 用户注册
 * @param {string} account 账号
 * @param {string} password 明文密码
 * @param {string} [nickname] 昵称，可选，默认与账号相同
 * @returns {Promise<{id: number, account: string, nickname: string, accessToken: string, refreshToken: string}>}
 */
export async function register(account, password, nickname) {
  if (!account || !password) {
    throw new Error('账号和密码不能为空');
  }

  if (password.length < 6) {
    throw new Error('密码长度不能少于6位');
  }

  const finalNickname = nickname?.trim() || DEFAULT_NICKNAME(account);

  const [exists] = await connection.query(
    'SELECT id FROM users WHERE account = ?',
    [account]
  );

  if (exists.length > 0) {
    throw new Error('账号已存在');
  }

  const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

  const [result] = await connection.query(
    'INSERT INTO users (account, password, nickname) VALUES (?, ?, ?)',
    [account, hashedPassword, finalNickname]
  );

  const user = { id: result.insertId, account, nickname: finalNickname };
  return issueTokenPair(user);
}

/**
 * 用户登录
 * @param {string} account 账号
 * @param {string} password 明文密码
 * @returns {Promise<{id: number, account: string, nickname: string, accessToken: string, refreshToken: string}>}
 */
export async function login(account, password) {
  if (!account || !password) {
    throw new Error('账号和密码不能为空');
  }

  const [rows] = await connection.query(
    'SELECT id, account, nickname, password FROM users WHERE account = ?',
    [account]
  );

  if (rows.length === 0) {
    throw new Error('账号或密码错误');
  }

  const user = rows[0];
  const isMatch = await bcrypt.compare(password, user.password);

  if (!isMatch) {
    throw new Error('账号或密码错误');
  }

  return issueTokenPair({
    id: user.id,
    account: user.account,
    nickname: user.nickname,
  });
}

/**
 * 获取当前用户的公开资料与第三方账号绑定状态。
 * openid 只用于服务端关联，不返回给前端。
 * @param {number} userId 用户 ID
 */
export async function getUserProfile(userId) {
  const [rows] = await connection.query(
    'SELECT id, account, nickname, qq_openid, wx_openid FROM users WHERE id = ?',
    [userId]
  );

  if (rows.length === 0) {
    throw new Error('用户不存在');
  }

  const user = rows[0];
  return {
    id: user.id,
    account: user.account,
    nickname: user.nickname,
    bindings: {
      qq: Boolean(user.qq_openid),
      wechat: Boolean(user.wx_openid),
    },
  };
}

/**
 * 用 Refresh Token 换取新的 Access Token
 * @param {string} refreshToken 客户端传来的 refresh token
 * @returns {Promise<{accessToken: string}>}
 */
export async function refreshAccessToken(refreshToken) {
  if (!refreshToken) {
    throw new Error('Refresh Token 不能为空');
  }

  const tokenHash = hashRefreshToken(refreshToken);

  const [rows] = await connection.query(
    `SELECT rt.id, rt.user_id, rt.expires_at, rt.revoked,
            u.account, u.nickname
     FROM refresh_tokens rt
     JOIN users u ON u.id = rt.user_id
     WHERE rt.token_hash = ?`,
    [tokenHash]
  );

  if (rows.length === 0) {
    throw new Error('Refresh Token 无效');
  }

  const record = rows[0];

  if (record.revoked) {
    throw new Error('Refresh Token 已失效');
  }

  if (new Date(record.expires_at) < new Date()) {
    throw new Error('Refresh Token 已过期');
  }

  const accessToken = createAccessToken({
    id: record.user_id,
    account: record.account,
    nickname: record.nickname,
  });

  return { accessToken };
}

/**
 * 登出，吊销当前 Refresh Token
 * @param {string} refreshToken 客户端传来的 refresh token
 */
export async function logout(refreshToken) {
  if (!refreshToken) {
    throw new Error('Refresh Token 不能为空');
  }

  const tokenHash = hashRefreshToken(refreshToken);

  await connection.query(
    'UPDATE refresh_tokens SET revoked = 1 WHERE token_hash = ?',
    [tokenHash]
  );
}

/**
 * 吊销指定用户的所有 Refresh Token（改密等场景使用）
 * @param {number} userId 用户 ID
 */
export async function revokeAllRefreshTokens(userId) {
  await connection.query(
    'UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ? AND revoked = 0',
    [userId]
  );
}

/**
 * 验证 Access Token（JWT）
 * @param {string} token JWT 字符串
 * @returns {object} 解码后的载荷
 */
export function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}
