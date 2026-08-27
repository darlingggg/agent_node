import connection from '../../Mysql/index.js';

const USER_ROLES = new Set(['super', 'admin', 'normal', 'disabled']);

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function normalizeOpenid(value, field, maxLength) {
  if (value === false || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new Error(`${field} 格式不正确`);
  }

  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${field} 格式不正确`);
  }
  return normalized;
}

function parseUserId(rawId) {
  const userId = Number(rawId);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error('用户 id 格式不正确');
  }
  return userId;
}

/** 获取管理端用户列表及项目数量。 */
export async function getAdminUserList({ pageSize, offset }) {
  const [[countRow]] = await connection.query('SELECT COUNT(*) AS total FROM users');
  const [rows] = await connection.query(
    `SELECT u.id, u.account, u.nickname, u.avatar, u.qq_openid, u.wx_openid,
            u.role, u.storage_key, u.created_at, u.last_login_at, u.last_active_at,
            COUNT(p.id) AS project_count,
            SUM(p.id IS NOT NULL AND p.deleted_at IS NULL) AS active_project_count,
            SUM(p.id IS NOT NULL AND p.deleted_at IS NOT NULL) AS deleted_project_count
     FROM users u
     LEFT JOIN projects p ON p.account = u.account
     GROUP BY u.id, u.account, u.nickname, u.avatar, u.qq_openid, u.wx_openid,
              u.role, u.storage_key, u.created_at, u.last_login_at, u.last_active_at
     ORDER BY u.created_at DESC, u.id DESC
     LIMIT ? OFFSET ?`,
    [pageSize, offset]
  );

  return { rows, total: Number(countRow.total) || 0 };
}

/** 获取单个用户资料及其全部项目（包含已删除项目）。 */
export async function getAdminUserDetail(rawUserId) {
  const userId = parseUserId(rawUserId);
  const [users] = await connection.query(
    `SELECT id, account, nickname, avatar, qq_openid, wx_openid,
            role, storage_key, created_at, last_login_at, last_active_at
     FROM users
     WHERE id = ?`,
    [userId]
  );

  if (users.length === 0) throw new Error('用户不存在');

  return users[0];
}

/**
 * 修改用户权限或 QQ/微信绑定。
 * super 可操作所有其他用户；admin 仅可操作 normal/disabled 用户，且不能授予管理角色。
 */
export async function updateAdminUser(actor, rawUserId, body) {
  const userId = parseUserId(rawUserId);
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const wantsRole = hasOwn(input, 'role');
  const wantsQQ = hasOwn(input, 'qqOpenid') || hasOwn(input, 'qq');
  const wantsWechat = hasOwn(input, 'wxOpenid') || hasOwn(input, 'wx');

  if (!wantsRole && !wantsQQ && !wantsWechat) {
    throw new Error('没有可修改的字段');
  }

  const role = wantsRole ? String(input.role || '').trim() : null;
  if (wantsRole && !USER_ROLES.has(role)) {
    throw new Error('用户权限只能是 super/admin/normal/disabled');
  }

  const qqOpenid = wantsQQ
    ? normalizeOpenid(hasOwn(input, 'qqOpenid') ? input.qqOpenid : input.qq, 'qqOpenid', 64)
    : undefined;
  const wxOpenid = wantsWechat
    ? normalizeOpenid(hasOwn(input, 'wxOpenid') ? input.wxOpenid : input.wx, 'wxOpenid', 50)
    : undefined;

  const db = await connection.getConnection();
  try {
    await db.beginTransaction();
    const [rows] = await db.query(
      `SELECT id, account, role, qq_openid, wx_openid, storage_key
       FROM users
       WHERE id = ?
       FOR UPDATE`,
      [userId]
    );

    if (rows.length === 0) throw new Error('用户不存在');
    const target = rows[0];

    if (actor.role !== 'super' && (target.role === 'super' || target.role === 'admin')) {
      throw new Error('admin 无权修改管理账号');
    }
    if (wantsRole && actor.id === target.id) {
      throw new Error('不能修改自己的用户权限');
    }
    if (wantsRole && (role === 'super' || role === 'admin') && actor.role !== 'super') {
      throw new Error('只有 super 可以授予管理权限');
    }

    const assignments = [];
    const params = [];
    if (wantsRole && role !== target.role) {
      assignments.push('role = ?');
      params.push(role);
    }
    if (wantsQQ && qqOpenid !== target.qq_openid) {
      assignments.push('qq_openid = ?');
      params.push(qqOpenid);
    }
    if (wantsWechat && wxOpenid !== target.wx_openid) {
      assignments.push('wx_openid = ?');
      params.push(wxOpenid);
    }

    if (assignments.length > 0) {
      await db.query(
        `UPDATE users SET ${assignments.join(', ')} WHERE id = ?`,
        [...params, userId]
      );
    }

    if (wantsRole && role === 'disabled') {
      await db.query(
        'UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ? AND revoked = 0',
        [userId]
      );
    }

    await db.commit();
  } catch (error) {
    await db.rollback();
    if (error?.code === 'ER_DUP_ENTRY') {
      throw new Error('该 QQ 或微信账号已绑定其他用户');
    }
    throw error;
  } finally {
    db.release();
  }

  return getAdminUserDetail(userId);
}
