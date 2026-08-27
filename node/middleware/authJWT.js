import { verifyToken } from '../auth/index.js';
import connection from '../../Mysql/index.js';

/**
 * JWT 鉴权中间件，从 Authorization: Bearer <token> 中解析用户
 */
const authJWT = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      status: 1,
      message: '未登录或 Token 无效'
    });
    return;
  }

  const token = authHeader.slice(7);
  let payload;

  try {
    payload = verifyToken(token);
  } catch {
    res.status(401).json({
      status: 1,
      message: 'Token 已过期或无效'
    });
    return;
  }

  try {
    const [rows] = await connection.query(
      `SELECT id, account, nickname, role, storage_key
       FROM users
       WHERE id = ?
       LIMIT 1`,
      [payload.id]
    );

    if (rows.length === 0) {
      res.status(401).json({
        status: 1,
        message: '用户不存在或 Token 已失效'
      });
      return;
    }

    const user = rows[0];
    if (user.role === 'disabled') {
      res.status(403).json({
        status: 1,
        message: '账号已被禁用'
      });
      return;
    }

    // 以数据库实时资料为准，角色或账号变更后无需等待旧 Token 过期。
    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
};

export default authJWT;
