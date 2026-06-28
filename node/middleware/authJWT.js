import { verifyToken } from '../auth/index.js';

/**
 * JWT 鉴权中间件，从 Authorization: Bearer <token> 中解析用户
 */
const authJWT = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      status: 1,
      message: '未登录或 Token 无效'
    });
    return;
  }

  const token = authHeader.slice(7);

  try {
    req.user = verifyToken(token);
    next();
  } catch {
    res.status(401).json({
      status: 1,
      message: 'Token 已过期或无效'
    });
    return;
  }
};

export default authJWT;
