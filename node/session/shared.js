import connection from '../../Mysql/index.js';

export const DELETED_TITLE_REGEXP = '_delete_[0-9]{10}$';
export const createDeleteTitleSuffix = () => `_delete_${String(Date.now()).slice(-10)}`;

export async function ensureSessionTitleAvailable(account, projectId, title) {
  const [rows] = await connection.query(
    'select id from sessions where account = ? and project_id = ? and title = ? and title not regexp ? limit 1',
    [account, projectId, title, DELETED_TITLE_REGEXP],
  );
  if (rows.length > 0) throw new Error('当前项目下会话标题已存在');
}
