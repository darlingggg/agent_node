import connection from '../../../Mysql/index.js';

/** 兼容 MySQL 驱动将 JSON 字段返回为字符串或对象的两种情况。 */
function parse(row) {
  return typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
}

/** 持久化 scheduler.view(job) 提取的状态和成功链接；内部执行数据与队列留在内存。 */
export const buildTaskStore = {
  /** 按任务 ID 插入或更新 scheduler.view(job) 的状态快照，payload 保留完整可查询字段。 */
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

  /** 取用户最近请求的任务，按 requested_at 而非完成时间排序；无记录返回 null。 */
  async latest(projectId, kind) {
    const [rows] = await connection.query(
      'SELECT payload FROM project_build_tasks WHERE project_id = ? AND kind = ? ORDER BY requested_at DESC LIMIT 1',
      [projectId, kind],
    );
    return rows.length ? parse(rows[0]) : null;
  },

  /** 取成功预览；传 revision 时精确匹配源码版本，不传时取最近完成的成功版本。 */
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

  /** 重启后将遗留 queued/running 标为失败；内存队列和源码上下文已丢失，成功记录保留。 */
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
