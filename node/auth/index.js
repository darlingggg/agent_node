import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import connection from '../../Mysql/index.js';
import { createStorageKey } from '../utils/storageKey.js';
import { markUserActive } from '../utils/activity.js';

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

const USER_ACCOUNT_TABLES = ['projects', 'sessions', 'log', 'snapshots'];

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function validTrimmedString(value, maxLength) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || Array.from(trimmed).length > maxLength) return null;
  return trimmed;
}

/**
 * 过滤用户资料更新参数。未传字段不处理，无效字段记录后忽略。
 * qq/wx 仅接受 false，避免空值或表单异常导致意外解绑。
 */
export function normalizeUserProfileInput(body) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const values = {};
  const ignoredFields = [];

  if (hasOwn(input, 'account')) {
    const account = validTrimmedString(input.account, 50);
    if (account) values.account = account;
    else ignoredFields.push('account');
  }

  if (hasOwn(input, 'password')) {
    const password = typeof input.password === 'string' ? input.password : '';
    const passwordLength = Array.from(password).length;
    const passwordBytes = Buffer.byteLength(password, 'utf8');
    if (password.trim() && passwordLength >= 6 && passwordBytes <= 72) {
      values.password = password;
    } else {
      ignoredFields.push('password');
    }
  }

  if (hasOwn(input, 'currentPassword')) {
    const currentPassword = typeof input.currentPassword === 'string' ? input.currentPassword : '';
    const currentPasswordBytes = Buffer.byteLength(currentPassword, 'utf8');
    if (currentPassword && currentPasswordBytes <= 72) {
      values.currentPassword = currentPassword;
    } else {
      ignoredFields.push('currentPassword');
    }
  }

  if (hasOwn(input, 'avatar')) {
    const avatar = validTrimmedString(input.avatar, 2048);
    if (avatar) values.avatar = avatar;
    else ignoredFields.push('avatar');
  }

  if (hasOwn(input, 'nickname')) {
    const nickname = validTrimmedString(input.nickname, 20);
    if (nickname) values.nickname = nickname;
    else ignoredFields.push('nickname');
  }

  if (hasOwn(input, 'qq')) {
    if (input.qq === false) values.qqOpenid = null;
    else ignoredFields.push('qq');
  }

  if (hasOwn(input, 'wx')) {
    if (input.wx === false) values.wxOpenid = null;
    else ignoredFields.push('wx');
  }

  return { values, ignoredFields };
}

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
 * @param {object} user 用户信息，必须包含 id
 * @returns {Promise<{id: number, account: string, nickname: string, role: string, accessToken: string, refreshToken: string}>}
 */
export async function issueTokenPair(user, { recordLogin = false } = {}) {
  const [rows] = await connection.query(
    'SELECT id, account, nickname, role FROM users WHERE id = ? LIMIT 1',
    [user.id]
  );
  if (rows.length === 0) throw new Error('用户不存在');

  const currentUser = rows[0];
  if (currentUser.role === 'disabled') {
    throw new Error('账号已被禁用');
  }

  const accessToken = createAccessToken({
    id: currentUser.id,
    account: currentUser.account,
    nickname: currentUser.nickname,
    role: currentUser.role,
  });

  const refreshToken = generateRefreshToken();
  await saveRefreshToken(currentUser.id, refreshToken);
  if (recordLogin) await markUserActive(currentUser.id, { login: true });

  return {
    id: currentUser.id,
    account: currentUser.account,
    nickname: currentUser.nickname,
    role: currentUser.role,
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
  const storageKey = createStorageKey();

  const [result] = await connection.query(
    'INSERT INTO users (account, password, nickname, storage_key) VALUES (?, ?, ?, ?)',
    [account, hashedPassword, finalNickname, storageKey]
  );

  const user = { id: result.insertId, account, nickname: finalNickname };
  return issueTokenPair(user, { recordLogin: true });
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
  }, { recordLogin: true });
}

/**
 * 获取当前用户的公开资料与第三方账号绑定状态。
 * openid 只用于服务端关联，不返回给前端。
 * @param {number} userId 用户 ID
 */
export async function getUserProfile(userId) {
  const [rows] = await connection.query(
    'SELECT id, account, nickname, avatar, qq_openid, wx_openid, role FROM users WHERE id = ?',
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
    avatar: user.avatar,
    role: user.role,
    bindings: {
      qq: Boolean(user.qq_openid),
      wechat: Boolean(user.wx_openid),
    },
  };
}

/**
 * 按请求中提供的有效字段更新当前用户资料。
 * 修改账号时同步迁移所有以 account 作为归属键的数据。
 * @param {number} userId 当前用户 ID
 * @param {object} body 前端更新参数
 */
export async function updateUserProfile(userId, body) {
  const { values, ignoredFields } = normalizeUserProfileInput(body);
  const passwordChangeRequested = body && typeof body === 'object' && hasOwn(body, 'password');

  if (passwordChangeRequested && !hasOwn(values, 'password')) {
    throw new Error('新密码格式不正确');
  }
  if (passwordChangeRequested && !hasOwn(values, 'currentPassword')) {
    throw new Error('请输入原密码');
  }

  const db = await connection.getConnection();
  const updatedFields = [];
  let shouldRotateTokens = false;

  try {
    await db.beginTransaction();

    const [rows] = await db.query(
      'SELECT id, account, nickname, avatar, password, qq_openid, wx_openid FROM users WHERE id = ? FOR UPDATE',
      [userId]
    );

    if (rows.length === 0) {
      throw new Error('用户不存在');
    }

    const current = rows[0];
    const assignments = [];
    const params = [];

    if (passwordChangeRequested) {
      const currentPasswordMatches = await bcrypt.compare(values.currentPassword, current.password);
      if (!currentPasswordMatches) {
        throw new Error('原密码错误');
      }
      assignments.push('password = ?');
      params.push(await bcrypt.hash(values.password, SALT_ROUNDS));
      updatedFields.push('password');
      shouldRotateTokens = true;
    }

    if (hasOwn(values, 'nickname') && values.nickname !== current.nickname) {
      assignments.push('nickname = ?');
      params.push(values.nickname);
      updatedFields.push('nickname');
    }

    if (hasOwn(values, 'avatar') && values.avatar !== current.avatar) {
      assignments.push('avatar = ?');
      params.push(values.avatar);
      updatedFields.push('avatar');
    }

    if (hasOwn(values, 'qqOpenid') && current.qq_openid !== null) {
      assignments.push('qq_openid = NULL');
      updatedFields.push('qq');
    }

    if (hasOwn(values, 'wxOpenid') && current.wx_openid !== null) {
      assignments.push('wx_openid = NULL');
      updatedFields.push('wx');
    }

    if (assignments.length > 0) {
      await db.query(
        `UPDATE users SET ${assignments.join(', ')} WHERE id = ?`,
        [...params, userId]
      );
    }

    if (hasOwn(values, 'account') && values.account !== current.account) {
      const [accountRows] = await db.query(
        'SELECT id FROM users WHERE account = ? AND id <> ? LIMIT 1',
        [values.account, userId]
      );

      if (accountRows.length > 0) {
        ignoredFields.push('account');
      } else {
        try {
          await db.query('UPDATE users SET account = ? WHERE id = ?', [values.account, userId]);
          for (const table of USER_ACCOUNT_TABLES) {
            await db.query(`UPDATE ${table} SET account = ? WHERE account = ?`, [values.account, current.account]);
          }
          updatedFields.push('account');
          shouldRotateTokens = true;
        } catch (error) {
          if (error.code === 'ER_DUP_ENTRY') {
            ignoredFields.push('account');
          } else {
            throw error;
          }
        }
      }
    }

    if (shouldRotateTokens) {
      await db.query(
        'UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ? AND revoked = 0',
        [userId]
      );
    }

    await db.commit();
  } catch (error) {
    await db.rollback();
    throw error;
  } finally {
    db.release();
  }

  const profile = await getUserProfile(userId);
  const tokenPair = shouldRotateTokens ? await issueTokenPair(profile) : null;

  return {
    ...profile,
    updatedFields,
    ignoredFields: [...new Set(ignoredFields)],
    ...(tokenPair ? {
      accessToken: tokenPair.accessToken,
      refreshToken: tokenPair.refreshToken,
    } : {}),
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
            u.account, u.nickname, u.role
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

  if (record.role === 'disabled') {
    throw new Error('账号已被禁用');
  }

  const accessToken = createAccessToken({
    id: record.user_id,
    account: record.account,
    nickname: record.nickname,
    role: record.role,
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
