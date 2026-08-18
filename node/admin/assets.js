import path from 'path';
import connection from '../../Mysql/index.js';
import { getSignedObjectUrl, listObjects } from '../cos/index.js';

function isTruncated(value) {
  return value === true || value === 'true';
}

function getContents(data) {
  return Array.isArray(data?.Contents) ? data.Contents : [];
}

async function getUsersByStorageKey(userId) {
  const params = [];
  let where = '';
  if (userId !== undefined && userId !== '') {
    const normalizedUserId = Number(userId);
    if (!Number.isInteger(normalizedUserId) || normalizedUserId <= 0) {
      throw new Error('userId 格式不正确');
    }
    where = 'WHERE id = ?';
    params.push(normalizedUserId);
  }

  const [users] = await connection.query(
    `SELECT id, account, nickname, storage_key
     FROM users
     ${where}`,
    params
  );

  if (where && users.length === 0) throw new Error('用户不存在');
  return new Map(users.map((user) => [user.storage_key, user]));
}

function getNextMarker(data, contents) {
  return data?.NextMarker || contents.at(-1)?.Key || null;
}

async function resolvePageMarker({ prefix, page, pageSize, marker }) {
  if (marker) return marker;
  if (page === 1) return '';

  let currentMarker = '';
  for (let currentPage = 1; currentPage < page; currentPage++) {
    const data = await listObjects({ prefix, marker: currentMarker, maxKeys: pageSize });
    const contents = getContents(data);
    if (!isTruncated(data?.IsTruncated) || contents.length === 0) return null;
    currentMarker = getNextMarker(data, contents);
    if (!currentMarker) return null;
  }

  return currentMarker;
}

function getStorageKeyFromObjectKey(key) {
  const match = String(key).match(/^uploads\/([^/]+)\//);
  return match?.[1] || null;
}

/** 分页查询所有用户上传到 COS 的素材，userId 可选。 */
export async function getUploadedAssets({ page, pageSize, marker = '', userId }) {
  const usersByStorageKey = await getUsersByStorageKey(userId);
  const selectedUser = userId !== undefined && userId !== ''
    ? usersByStorageKey.values().next().value
    : null;
  const prefix = selectedUser ? `uploads/${selectedUser.storage_key}/` : 'uploads/';
  const pageMarker = await resolvePageMarker({ prefix, page, pageSize, marker });

  if (pageMarker === null) {
    return { rows: [], hasMore: false, nextMarker: null };
  }

  const data = await listObjects({ prefix, marker: pageMarker, maxKeys: pageSize });
  const contents = getContents(data);
  const rows = await Promise.all(contents.map(async (item) => {
    const key = String(item.Key || '');
    const storageKey = getStorageKeyFromObjectKey(key);
    const user = storageKey ? usersByStorageKey.get(storageKey) : null;
    const isDirectory = key.endsWith('/');
    const extension = path.posix.extname(key).toLowerCase();

    return {
      key,
      fileName: isDirectory ? '' : path.posix.basename(key),
      relativePath: storageKey ? key.slice(`uploads/${storageKey}/`.length) : key,
      extension,
      size: Number(item.Size) || 0,
      etag: String(item.ETag || '').replace(/^"|"$/g, ''),
      storageClass: item.StorageClass || null,
      lastModified: item.LastModified || null,
      isDirectory,
      url: isDirectory ? null : await getSignedObjectUrl(key),
      storageKey,
      userId: user?.id ?? null,
      account: user?.account ?? null,
      userNickname: user?.nickname ?? null,
    };
  }));

  const hasMore = isTruncated(data?.IsTruncated);
  return {
    rows,
    hasMore,
    nextMarker: hasMore ? getNextMarker(data, contents) : null,
  };
}
