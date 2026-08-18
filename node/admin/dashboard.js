import connection from '../../Mysql/index.js';
import { getStorageSyncState, STORAGE_METRICS_LOCK_NAME } from '../cos/storageMetrics.js';
import { getBeijingDateRange, listBeijingDates } from '../utils/beijingTime.js';

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function rowsByDate(rows) {
  return new Map(rows.map((row) => [String(row.metric_date), row]));
}

export function parseDashboardDays(rawDays) {
  const days = Number(rawDays || 30);
  if (days !== 7 && days !== 30) throw new Error('days 只支持 7 或 30');
  return days;
}

/** 获取不受列表分页影响的全站运营数据。 */
export async function getDashboardOverview(days) {
  const range = getBeijingDateRange(days);
  const [
    [[userSummary]], [[projectSummary]], [[aiSummary]], [[storageSummary]],
    [userTrend], [projectTrend], [aiTrend], [storageTrend],
    [usersByTokens], [projectsByTokens], [usersByStorage], [roleRows], [typeRows], [[storageLock]],
  ] = await Promise.all([
    connection.query(
      `SELECT COUNT(*) AS total,
              SUM(created_at >= ? AND created_at < ?) AS new_count,
              SUM(last_active_at >= ? AND last_active_at < ?) AS active_count,
              SUM(role = 'disabled') AS disabled_count
       FROM users`,
      [range.startUtc, range.endExclusiveUtc, range.startUtc, range.endExclusiveUtc]
    ),
    connection.query(
      `SELECT COUNT(*) AS total,
              SUM(created_at >= ? AND created_at < ?) AS new_count,
              SUM(deleted_at IS NULL) AS active_count,
              SUM(deleted_at IS NOT NULL) AS deleted_count
       FROM projects`,
      [range.startUtc, range.endExclusiveUtc]
    ),
    connection.query(
      `SELECT
         COALESCE((SELECT SUM(ai_prompt_tokens) FROM projects), 0) AS cumulative_prompt_tokens,
         COALESCE((SELECT SUM(ai_completion_tokens) FROM projects), 0) AS cumulative_completion_tokens,
         COALESCE((SELECT SUM(ai_total_tokens) FROM projects), 0) AS cumulative_total_tokens,
         COALESCE(SUM(prompt_tokens), 0) AS period_prompt_tokens,
         COALESCE(SUM(completion_tokens), 0) AS period_completion_tokens,
         COALESCE(SUM(total_tokens), 0) AS period_total_tokens,
         COALESCE(SUM(model_calls), 0) AS model_calls,
         COALESCE(SUM(failed_calls), 0) AS failed_calls
       FROM ai_usage_daily
       WHERE metric_date BETWEEN ? AND ?`,
      [range.startDate, range.endDate]
    ),
    connection.query(
      `SELECT COALESCE(SUM(s.file_count), 0) AS file_count,
              COALESCE(SUM(s.total_bytes), 0) AS total_bytes,
              COALESCE(SUM(s.image_count), 0) AS image_count,
              COALESCE(SUM(s.video_count), 0) AS video_count,
              COALESCE(SUM(s.other_count), 0) AS other_count,
              MAX(s.last_synced_at) AS last_synced_at,
              CASE
                WHEN COUNT(s.user_id) = 0 THEN 'never'
                WHEN SUM(s.sync_status = 'error') > 0 THEN 'error'
                ELSE 'success'
              END AS sync_status,
              MAX(s.error_message) AS error_message,
              COALESCE((SELECT orphan_file_count FROM storage_daily_metrics ORDER BY metric_date DESC LIMIT 1), 0) AS orphan_file_count,
              COALESCE((SELECT orphan_bytes FROM storage_daily_metrics ORDER BY metric_date DESC LIMIT 1), 0) AS orphan_bytes
       FROM user_storage_stats s`
    ),
    connection.query(
      `SELECT DATE_FORMAT(CONVERT_TZ(created_at, '+00:00', '+08:00'), '%Y-%m-%d') AS metric_date,
              COUNT(*) AS new_users
       FROM users
       WHERE created_at >= ? AND created_at < ?
       GROUP BY metric_date`,
      [range.startUtc, range.endExclusiveUtc]
    ),
    connection.query(
      `SELECT DATE_FORMAT(CONVERT_TZ(created_at, '+00:00', '+08:00'), '%Y-%m-%d') AS metric_date,
              COUNT(*) AS new_projects
       FROM projects
       WHERE created_at >= ? AND created_at < ?
       GROUP BY metric_date`,
      [range.startUtc, range.endExclusiveUtc]
    ),
    connection.query(
      `SELECT DATE_FORMAT(metric_date, '%Y-%m-%d') AS metric_date,
              SUM(prompt_tokens) AS prompt_tokens,
              SUM(completion_tokens) AS completion_tokens,
              SUM(total_tokens) AS total_tokens,
              SUM(model_calls) AS model_calls,
              SUM(failed_calls) AS failed_calls
       FROM ai_usage_daily
       WHERE metric_date BETWEEN ? AND ?
       GROUP BY metric_date`,
      [range.startDate, range.endDate]
    ),
    connection.query(
      `SELECT DATE_FORMAT(metric_date, '%Y-%m-%d') AS metric_date,
              file_count, total_bytes, orphan_file_count, orphan_bytes, synced_at
       FROM storage_daily_metrics
       WHERE metric_date BETWEEN ? AND ?
       ORDER BY metric_date`,
      [range.startDate, range.endDate]
    ),
    connection.query(
      `SELECT u.id AS user_id, u.account, u.nickname, u.avatar,
              SUM(p.ai_total_tokens) AS total_tokens
       FROM users u
       JOIN projects p ON p.account = u.account
       GROUP BY u.id, u.account, u.nickname, u.avatar
       HAVING total_tokens > 0
       ORDER BY total_tokens DESC, u.id ASC
       LIMIT 10`
    ),
    connection.query(
      `SELECT p.id AS project_id, p.title, p.account, u.nickname AS user_nickname,
              u.avatar AS user_avatar, p.ai_total_tokens AS total_tokens
       FROM projects p
       LEFT JOIN users u ON u.account = p.account
       WHERE p.ai_total_tokens > 0
       ORDER BY p.ai_total_tokens DESC, p.id ASC
       LIMIT 10`
    ),
    connection.query(
      `SELECT u.id AS user_id, u.account, u.nickname, u.avatar,
              s.file_count, s.total_bytes, s.last_synced_at
       FROM user_storage_stats s
       JOIN users u ON u.id = s.user_id
       ORDER BY s.total_bytes DESC, s.file_count DESC, u.id ASC
       LIMIT 10`
    ),
    connection.query('SELECT role, COUNT(*) AS count FROM users GROUP BY role'),
    connection.query('SELECT type, COUNT(*) AS count FROM projects GROUP BY type'),
    connection.query('SELECT IS_USED_LOCK(?) AS connection_id', [STORAGE_METRICS_LOCK_NAME]),
  ]);

  const userDates = rowsByDate(userTrend);
  const projectDates = rowsByDate(projectTrend);
  const aiDates = rowsByDate(aiTrend);
  const storageDates = rowsByDate(storageTrend);
  const storageSyncState = getStorageSyncState();
  const trends = listBeijingDates(range.startDate, days).map((date) => {
    const user = userDates.get(date) || {};
    const project = projectDates.get(date) || {};
    const ai = aiDates.get(date) || {};
    const storage = storageDates.get(date) || {};
    return {
      date,
      newUsers: toNumber(user.new_users),
      newProjects: toNumber(project.new_projects),
      promptTokens: toNumber(ai.prompt_tokens),
      completionTokens: toNumber(ai.completion_tokens),
      totalTokens: toNumber(ai.total_tokens),
      modelCalls: toNumber(ai.model_calls),
      failedCalls: toNumber(ai.failed_calls),
      storageFileCount: toNumber(storage.file_count),
      storageBytes: toNumber(storage.total_bytes),
      orphanFileCount: toNumber(storage.orphan_file_count),
    };
  });

  return {
    range: { days, startDate: range.startDate, endDate: range.endDate, timezone: '北京时间（UTC+8）' },
    summary: {
      users: {
        total: toNumber(userSummary.total),
        newCount: toNumber(userSummary.new_count),
        activeCount: toNumber(userSummary.active_count),
        disabledCount: toNumber(userSummary.disabled_count),
        roleCounts: Object.fromEntries(roleRows.map((row) => [row.role, toNumber(row.count)])),
      },
      projects: {
        total: toNumber(projectSummary.total),
        newCount: toNumber(projectSummary.new_count),
        activeCount: toNumber(projectSummary.active_count),
        deletedCount: toNumber(projectSummary.deleted_count),
        typeCounts: Object.fromEntries(typeRows.map((row) => [row.type, toNumber(row.count)])),
      },
      ai: {
        cumulativePromptTokens: toNumber(aiSummary.cumulative_prompt_tokens),
        cumulativeCompletionTokens: toNumber(aiSummary.cumulative_completion_tokens),
        cumulativeTotalTokens: toNumber(aiSummary.cumulative_total_tokens),
        periodPromptTokens: toNumber(aiSummary.period_prompt_tokens),
        periodCompletionTokens: toNumber(aiSummary.period_completion_tokens),
        periodTotalTokens: toNumber(aiSummary.period_total_tokens),
        modelCalls: toNumber(aiSummary.model_calls),
        failedCalls: toNumber(aiSummary.failed_calls),
      },
      storage: {
        fileCount: toNumber(storageSummary.file_count) + toNumber(storageSummary.orphan_file_count),
        totalBytes: toNumber(storageSummary.total_bytes) + toNumber(storageSummary.orphan_bytes),
        managedFileCount: toNumber(storageSummary.file_count),
        managedBytes: toNumber(storageSummary.total_bytes),
        imageCount: toNumber(storageSummary.image_count),
        videoCount: toNumber(storageSummary.video_count),
        otherCount: toNumber(storageSummary.other_count),
        orphanFileCount: toNumber(storageSummary.orphan_file_count),
        orphanBytes: toNumber(storageSummary.orphan_bytes),
        lastSyncedAt: storageSummary.last_synced_at || null,
        syncStatus: storageSummary.sync_status || 'never',
        errorMessage: storageSummary.error_message || null,
      },
    },
    trends,
    rankings: { usersByTokens, projectsByTokens, usersByStorage },
    storageSync: {
      ...storageSyncState,
      running: storageSyncState.running
        || (storageLock?.connection_id !== null && storageLock?.connection_id !== undefined),
    },
    generatedAt: new Date(),
  };
}
