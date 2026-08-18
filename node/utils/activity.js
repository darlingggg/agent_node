import connection from '../../Mysql/index.js';

/** 更新用户最后活跃时间；登录成功时同时更新最后登录时间。 */
export async function markUserActive(userId, { login = false, db = connection } = {}) {
  if (!Number.isInteger(Number(userId)) || Number(userId) <= 0) return;
  const assignment = login
    ? 'last_login_at = CURRENT_TIMESTAMP, last_active_at = CURRENT_TIMESTAMP'
    : 'last_active_at = CURRENT_TIMESTAMP';
  await db.query(`UPDATE users SET ${assignment} WHERE id = ?`, [Number(userId)]);
}

/** 文件发生实际变更后，同时刷新所属项目和用户的活跃时间。 */
export async function markProjectFileActivity(dirPath, db = connection) {
  if (!dirPath) return;
  await db.query(
    `UPDATE projects p
     JOIN users u ON u.account = p.account
     SET p.update_time = CURRENT_TIMESTAMP,
         u.last_active_at = CURRENT_TIMESTAMP
     WHERE p.dir_path = ? AND p.deleted_at IS NULL`,
    [dirPath]
  );
}
