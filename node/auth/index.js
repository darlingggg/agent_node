import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import connection from '../../Mysql/index.js';

/** JWT 密钥，生产环境请通过环境变量配置 */
const JWT_SECRET = process.env.JWT_SECRET || 'agentNode_dev_secret';

/** JWT 过期时间 */
const JWT_EXPIRES_IN = '7d';

/** 密码加密盐轮数 */
const SALT_ROUNDS = 10;

/** 昵称默认值，未传时使用账号 */
const DEFAULT_NICKNAME = (account) => account;

/**
 * 生成 JWT Token
 * @param {object} payload 载荷数据
 * @returns {string}
 */
function createToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

/**
 * 用户注册
 * @param {string} account 账号
 * @param {string} password 明文密码
 * @param {string} [nickname] 昵称，可选，默认与账号相同
 * @returns {Promise<{id: number, account: string, nickname: string, token: string}>}
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
  const token = createToken(user);

  return { ...user, token };
}

/**
 * 用户登录
 * @param {string} account 账号
 * @param {string} password 明文密码
 * @returns {Promise<{id: number, account: string, nickname: string, token: string}>}
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

  const token = createToken({
    id: user.id,
    account: user.account,
    nickname: user.nickname,
  });

  return {
    id: user.id,
    account: user.account,
    nickname: user.nickname,
    token,
  };
}

/**
 * 验证 JWT Token
 * @param {string} token JWT 字符串
 * @returns {object} 解码后的载荷
 */
export function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}
