import path from 'path';
import connection from '../../Mysql/index.js';
import { getBeijingDateKey } from '../utils/beijingTime.js';
import { listObjects } from './index.js';

export const STORAGE_METRICS_LOCK_NAME = 'gameAgent:cos-storage-metrics';
const SYNC_INTERVAL_MS = 60 * 60 * 1000;
const INITIAL_SYNC_DELAY_MS = 30 * 1000;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.svg']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v']);

let syncState = {
  running: false,
  source: null,
  startedAt: null,
  finishedAt: null,
  lastError: null,
};

function getContents(data) {
  return Array.isArray(data?.Contents) ? data.Contents : [];
}

function isTruncated(value) {
  return value === true || value === 'true';
}

function createEmptyStats(user) {
  return {
    userId: user.id,
    storageKey: user.storage_key,
    fileCount: 0,
    totalBytes: 0,
    imageCount: 0,
    videoCount: 0,
    otherCount: 0,
  };
}

function getStorageKey(objectKey) {
  return String(objectKey).match(/^uploads\/([^/]+)\//)?.[1] || null;
}

async function scanAllUploads(usersByStorageKey) {
  const stats = new Map([...usersByStorageKey.values()].map((user) => [user.storage_key, createEmptyStats(user)]));
  let marker = '';
  let orphanFileCount = 0;
  let orphanBytes = 0;

  do {
    const data = await listObjects({ prefix: 'uploads/', marker, maxKeys: 1000 });
    const contents = getContents(data);

    for (const object of contents) {
      const key = String(object.Key || '');
      if (!key || key.endsWith('/')) continue;

      const size = Math.max(Number(object.Size) || 0, 0);
      const storageKey = getStorageKey(key);
      const userStats = storageKey ? stats.get(storageKey) : null;
      if (!userStats) {
        orphanFileCount += 1;
        orphanBytes += size;
        continue;
      }

      userStats.fileCount += 1;
      userStats.totalBytes += size;
      const extension = path.posix.extname(key).toLowerCase();
      if (IMAGE_EXTENSIONS.has(extension)) userStats.imageCount += 1;
      else if (VIDEO_EXTENSIONS.has(extension)) userStats.videoCount += 1;
      else userStats.otherCount += 1;
    }

    if (!isTruncated(data?.IsTruncated) || contents.length === 0) break;
    const nextMarker = data?.NextMarker || contents.at(-1)?.Key || '';
    if (!nextMarker || nextMarker === marker) break;
    marker = nextMarker;
  } while (marker);

  return { stats: [...stats.values()], orphanFileCount, orphanBytes };
}

async function persistMetrics(db, metrics) {
  const now = new Date();
  await db.beginTransaction();
  try {
    for (const row of metrics.stats) {
      await db.query(
        `INSERT INTO user_storage_stats
         (user_id, storage_key, file_count, total_bytes, image_count, video_count,
          other_count, last_synced_at, sync_status, error_message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'success', NULL)
         ON DUPLICATE KEY UPDATE
           storage_key = VALUES(storage_key),
           file_count = VALUES(file_count),
           total_bytes = VALUES(total_bytes),
           image_count = VALUES(image_count),
           video_count = VALUES(video_count),
           other_count = VALUES(other_count),
           last_synced_at = VALUES(last_synced_at),
           sync_status = 'success',
           error_message = NULL`,
        [
          row.userId, row.storageKey, row.fileCount, row.totalBytes,
          row.imageCount, row.videoCount, row.otherCount, now,
        ]
      );
    }

    await db.query(
      `DELETE stats FROM user_storage_stats stats
       LEFT JOIN users u ON u.id = stats.user_id
       WHERE u.id IS NULL`
    );

    const totals = metrics.stats.reduce((result, row) => ({
      fileCount: result.fileCount + row.fileCount,
      totalBytes: result.totalBytes + row.totalBytes,
    }), { fileCount: 0, totalBytes: 0 });
    const allFileCount = totals.fileCount + metrics.orphanFileCount;
    const allBytes = totals.totalBytes + metrics.orphanBytes;

    await db.query(
      `INSERT INTO storage_daily_metrics
       (metric_date, file_count, total_bytes, orphan_file_count, orphan_bytes, synced_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         file_count = VALUES(file_count),
         total_bytes = VALUES(total_bytes),
         orphan_file_count = VALUES(orphan_file_count),
         orphan_bytes = VALUES(orphan_bytes),
         synced_at = VALUES(synced_at)`,
      [
        getBeijingDateKey(now), allFileCount, allBytes,
        metrics.orphanFileCount, metrics.orphanBytes, now,
      ]
    );
    await db.commit();
    return {
      fileCount: allFileCount,
      totalBytes: allBytes,
      managedFileCount: totals.fileCount,
      managedBytes: totals.totalBytes,
      orphanFileCount: metrics.orphanFileCount,
      orphanBytes: metrics.orphanBytes,
      syncedAt: now,
    };
  } catch (error) {
    await db.rollback();
    throw error;
  }
}

/** 扫描 COS 并刷新用户当前汇总和北京时间每日快照。 */
export async function syncStorageMetrics() {
  const db = await connection.getConnection();
  let lockAcquired = false;
  try {
    const [[lockRow]] = await db.query('SELECT GET_LOCK(?, 0) AS acquired', [STORAGE_METRICS_LOCK_NAME]);
    lockAcquired = Number(lockRow?.acquired) === 1;
    if (!lockAcquired) return { skipped: true, reason: '已有同步任务正在运行' };

    const [users] = await db.query('SELECT id, storage_key FROM users');
    const usersByStorageKey = new Map(users.map((user) => [user.storage_key, user]));
    const metrics = await scanAllUploads(usersByStorageKey);
    return await persistMetrics(db, metrics);
  } catch (error) {
    try {
      await db.query(
        `UPDATE user_storage_stats
         SET sync_status = 'error', error_message = ?`,
        [String(error.message || error).slice(0, 500)]
      );
    } catch {
      // 数据表尚未迁移时只保留原始错误，避免掩盖真正原因。
    }
    throw error;
  } finally {
    if (lockAcquired) {
      try {
        await db.query('SELECT RELEASE_LOCK(?)', [STORAGE_METRICS_LOCK_NAME]);
      } catch {
        // 连接释放时 MySQL 也会释放命名锁。
      }
    }
    db.release();
  }
}

export function getStorageSyncState() {
  return { ...syncState };
}

/** 非阻塞请求一次同步；正在运行时直接返回当前状态。 */
export function requestStorageMetricsSync(source = 'manual') {
  if (syncState.running) return { started: false, ...getStorageSyncState() };

  syncState = {
    running: true,
    source,
    startedAt: new Date(),
    finishedAt: syncState.finishedAt,
    lastError: null,
  };

  void syncStorageMetrics()
    .then(() => {
      syncState = { ...syncState, running: false, finishedAt: new Date(), lastError: null };
    })
    .catch((error) => {
      syncState = {
        ...syncState,
        running: false,
        finishedAt: new Date(),
        lastError: String(error.message || error),
      };
      console.error('[storage-metrics] COS 同步失败:', error);
    });

  return { started: true, ...getStorageSyncState() };
}

export function startStorageMetricsScheduler() {
  const initialTimer = setTimeout(() => requestStorageMetricsSync('startup'), INITIAL_SYNC_DELAY_MS);
  initialTimer.unref?.();
  const interval = setInterval(() => requestStorageMetricsSync('scheduler'), SYNC_INTERVAL_MS);
  interval.unref?.();
}
