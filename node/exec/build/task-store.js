import connection from '../../../Mysql/index.js';

function parse(row) {
  return typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
}

export const buildTaskStore = {
  async save(task) {
    await connection.query(
      `INSERT INTO project_build_tasks
       (id, project_id, account, kind, revision, status, requested_at, completed_at, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE revision = VALUES(revision), status = VALUES(status),
       requested_at = VALUES(requested_at), completed_at = VALUES(completed_at), payload = VALUES(payload)`,
      [task.id, task.projectId, task.account, task.kind, task.revision, task.status,
        task.requestedAt, task.completedAt, JSON.stringify(task)],
    );
  },

  async latest(projectId, kind) {
    const [rows] = await connection.query(
      'SELECT payload FROM project_build_tasks WHERE project_id = ? AND kind = ? ORDER BY requested_at DESC LIMIT 1',
      [projectId, kind],
    );
    return rows.length ? parse(rows[0]) : null;
  },

  async ready(projectId, revision) {
    const params = [projectId];
    const filter = revision ? ' AND revision = ?' : '';
    if (revision) params.push(revision);
    const [rows] = await connection.query(
      `SELECT payload FROM project_build_tasks WHERE project_id = ? AND kind = 'preview'
       AND status = 'ready'${filter} ORDER BY completed_at DESC, requested_at DESC LIMIT 1`, params,
    );
    return rows.length ? parse(rows[0]) : null;
  },

  async recover() {
    const [rows] = await connection.query(
      "SELECT payload FROM project_build_tasks WHERE status IN ('queued', 'running')",
    );
    for (const row of rows) {
      await this.save({ ...parse(row), status: 'failed', error: '服务已重启，任务中断，请重试',
        completedAt: new Date().toISOString(), queuePosition: 0 });
    }
  },
};
