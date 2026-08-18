const ADMIN_ROLES = new Set(['super', 'admin']);

/** 仅允许管理端角色访问。必须放在 authJWT 之后。 */
export function requireAdmin(req, res, next) {
  if (!req.user || !ADMIN_ROLES.has(req.user.role)) {
    res.status(403).json({
      status: 1,
      message: '无管理端访问权限',
    });
    return;
  }

  next();
}

/** 仅允许超级管理员执行高成本或高权限操作。 */
export function requireSuper(req, res, next) {
  if (!req.user || req.user.role !== 'super') {
    res.status(403).json({
      status: 1,
      message: '仅超级管理员可执行该操作',
    });
    return;
  }

  next();
}
