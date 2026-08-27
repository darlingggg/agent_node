import connection from '../../Mysql/index.js';

function parseProjectId(rawId) {
  const projectId = Number(rawId);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    throw new Error('项目 id 格式不正确');
  }
  return projectId;
}

function buildProjectFilters({ userId, account }) {
  const conditions = [];
  const params = [];

  if (userId !== undefined && userId !== '') {
    const normalizedUserId = Number(userId);
    if (!Number.isInteger(normalizedUserId) || normalizedUserId <= 0) {
      throw new Error('userId 格式不正确');
    }
    conditions.push('u.id = ?');
    params.push(normalizedUserId);
  }

  if (account !== undefined && account !== '') {
    const normalizedAccount = String(account).trim();
    if (!normalizedAccount || normalizedAccount.length > 50) {
      throw new Error('account 格式不正确');
    }
    conditions.push('p.account = ?');
    params.push(normalizedAccount);
  }

  return {
    where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

/** 分页获取所有用户的项目，包含已软删除的项目。 */
export async function getAllProjects({ pageSize, offset, userId, account }) {
  const { where, params } = buildProjectFilters({ userId, account });
  const [[countRow]] = await connection.query(
    `SELECT COUNT(*) AS total
     FROM projects p
     LEFT JOIN users u ON u.account = p.account
     ${where}`,
    params
  );

  const [rows] = await connection.query(
    `SELECT p.*,
            (p.deleted_at IS NOT NULL) AS is_deleted,
            u.id AS user_id,
            u.nickname AS user_nickname,
            u.avatar AS user_avatar,
            u.role AS user_role
     FROM projects p
     LEFT JOIN users u ON u.account = p.account
     ${where}
     ORDER BY p.update_time DESC, p.created_at DESC, p.id DESC
     LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );

  return { rows, total: Number(countRow.total) || 0 };
}

/** 获取项目详情，并分页返回 conversation 元数据（不返回摘要和消息内容）。 */
export async function getAdminProjectDetail(rawProjectId, { pageSize, offset }) {
  const projectId = parseProjectId(rawProjectId);
  const [projects] = await connection.query(
    `SELECT p.*,
            (p.deleted_at IS NOT NULL) AS is_deleted,
            u.id AS user_id,
            u.nickname AS user_nickname,
            u.avatar AS user_avatar,
            u.role AS user_role,
            u.storage_key AS user_storage_key
     FROM projects p
     LEFT JOIN users u ON u.account = p.account
     WHERE p.id = ?`,
    [projectId]
  );

  if (projects.length === 0) throw new Error('项目不存在');
  const project = projects[0];

  const [[countRow]] = await connection.query(
    `SELECT COUNT(*) AS total
     FROM conversations
     WHERE project_id = ? AND account = ?`,
    [projectId, project.account]
  );
  const [conversations] = await connection.query(
    `SELECT id, account, project_id, title, status,
            prompt_tokens, completion_tokens, total_tokens,
            current_context_tokens, context_limit,
            summarized_until_session_id, last_compressed_at,
            created_at, updated_at
     FROM conversations
     WHERE project_id = ? AND account = ?
     ORDER BY updated_at DESC, id DESC
     LIMIT ? OFFSET ?`,
    [projectId, project.account, pageSize, offset]
  );

  return {
    project,
    conversations,
    conversationTotal: Number(countRow.total) || 0,
  };
}
