import fs from 'fs/promises';
import path from 'path';
import {
  assertWithinRoot,
  cleanPath,
  isProtectedPublicAsset,
  isUnderPublic,
  resolveRootDir,
  resolveTargetPath,
  touchProjectUpdateTime,
} from './path-utils.js';

const DOWNLOAD_MAX_BYTES = 10 * 1024 * 1024;
const CONTENT_TYPE_EXT = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/x-icon': '.ico',
  'image/bmp': '.bmp',
  'application/pdf': '.pdf',
  'application/json': '.json',
  'text/plain': '.txt',
  'text/css': '.css',
  'text/html': '.html',
  'application/javascript': '.js',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'video/mp4': '.mp4',
  'application/zip': '.zip',
};
const FORBIDDEN_TOP_DIRS = new Set(['src', 'agent_base', 'node_modules', 'dist', 'versions']);

function resolvePublicSavePath(filePath, rootDir) {
  if (!filePath || !String(filePath).trim()) throw new Error('保存路径 path 不能为空');
  let cleaned = cleanPath(filePath);
  if (path.isAbsolute(cleaned)) {
    assertWithinRoot(cleaned, rootDir);
    cleaned = path.relative(rootDir, cleaned);
  }

  const relativePosix = cleaned.replace(/\\/g, '/');
  const firstSegment = relativePosix.split('/')[0];
  if (FORBIDDEN_TOP_DIRS.has(firstSegment)) {
    throw new Error('下载文件仅允许保存到 public 目录下');
  }
  if (relativePosix !== 'public' && !relativePosix.startsWith('public/')) {
    cleaned = path.join('public', cleaned);
  }

  const fullPath = path.resolve(rootDir, cleaned);
  assertWithinRoot(fullPath, rootDir);
  if (!isUnderPublic(fullPath, rootDir)) throw new Error('下载文件仅允许保存到 public 目录下');
  if (path.relative(rootDir, fullPath) === 'public') {
    throw new Error('path 不能是 public 目录本身，请指定具体文件名，如 public/images/a.png');
  }
  return fullPath;
}

function guessDownloadExt(url, contentType) {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    if (ext && ext.length <= 10) return ext;
  } catch {
    // Content-Type can still provide the extension.
  }
  const type = contentType?.split(';')[0].trim().toLowerCase();
  return CONTENT_TYPE_EXT[type] || '';
}

function normalizePublicSubDir(subPath = '/') {
  let cleaned = String(subPath ?? '/').trim().replace(/\\/g, '/');
  if (!cleaned || cleaned === '/') return 'public';
  cleaned = cleaned.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!cleaned) return 'public';

  const segments = cleaned.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '..')) throw new Error('非法路径');
  if (FORBIDDEN_TOP_DIRS.has(segments[0])) throw new Error('文件仅允许保存到 public 目录下');
  return segments[0] === 'public' ? segments.join('/') : ['public', ...segments].join('/');
}

function resolvePublicTargetDir(subPath, rootDir) {
  const relativeDir = normalizePublicSubDir(subPath);
  const targetDir = path.resolve(rootDir, relativeDir);
  assertWithinRoot(targetDir, rootDir);
  if (!isUnderPublic(targetDir, rootDir)) throw new Error('文件仅允许保存到 public 目录下');
  return { targetDir, relativeDir };
}

function sanitizeFileName(rawName) {
  const base = path.basename(String(rawName || '').trim());
  const safe = base.replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/^\.+/, '');
  if (!safe) throw new Error('无法解析有效的文件名');
  return safe;
}

function normalizeSaveNames(raw) {
  if (raw == null || raw === '') return [];
  if (Array.isArray(raw)) return raw.map((item) => (item == null ? '' : String(item).trim()));
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return [];
    if (text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
          return parsed.map((item) => (item == null ? '' : String(item).trim()));
        }
      } catch {
        // Treat invalid JSON as a single file name.
      }
    }
    return [text];
  }
  return [String(raw).trim()].filter(Boolean);
}

async function writeBufferToPublicDir(buffer, fileName, targetDir, rootDir) {
  if (!Buffer.isBuffer(buffer)) throw new Error('文件内容无效');
  if (buffer.length > DOWNLOAD_MAX_BYTES) {
    throw new Error(`文件过大，超过 ${DOWNLOAD_MAX_BYTES / 1024 / 1024}MB 限制`);
  }
  const safeName = sanitizeFileName(fileName);
  const fullPath = path.join(targetDir, safeName);
  assertWithinRoot(fullPath, rootDir);
  if (!isUnderPublic(fullPath, rootDir)) throw new Error('文件仅允许保存到 public 目录下');
  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(fullPath, buffer);
  return {
    path: fullPath,
    relativePath: path.relative(rootDir, fullPath),
    bytes: buffer.length,
    fileName: safeName,
  };
}

async function fetchRemoteFile(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!url) throw new Error('url 为空');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('下载地址 url 格式无效');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('仅支持 http/https 协议的下载地址');
  }

  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'agentNode-download/1.0' },
  });
  if (!response.ok) throw new Error(`下载失败，HTTP ${response.status} ${response.statusText}`);
  const contentType = response.headers.get('content-type') || '';
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > DOWNLOAD_MAX_BYTES) {
    throw new Error(`文件过大，超过 ${DOWNLOAD_MAX_BYTES / 1024 / 1024}MB 限制`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > DOWNLOAD_MAX_BYTES) {
    throw new Error(`文件过大，超过 ${DOWNLOAD_MAX_BYTES / 1024 / 1024}MB 限制`);
  }
  return { url, parsed, contentType, buffer };
}

export async function importFilesToPublic({
  dirPath,
  path: subPath = '/',
  urls = [],
  files = [],
  saveNames,
} = {}) {
  if (!dirPath || !String(dirPath).trim()) throw new Error('项目根路径 dirPath 不能为空');
  const urlList = Array.isArray(urls) ? urls : [];
  const fileList = Array.isArray(files) ? files : [];
  if (urlList.length === 0 && fileList.length === 0) {
    throw new Error('请至少提供一个 url 或上传文件');
  }

  const nameList = normalizeSaveNames(saveNames);
  const rootDir = resolveRootDir(dirPath);
  const { targetDir, relativeDir } = resolvePublicTargetDir(subPath, rootDir);
  const results = [];
  let nameIndex = 0;

  for (const rawUrl of urlList) {
    const url = String(rawUrl || '').trim();
    const customName = nameList[nameIndex++] || '';
    try {
      const remote = await fetchRemoteFile(url);
      let fileName = customName
        ? sanitizeFileName(customName)
        : sanitizeFileName(path.basename(remote.parsed.pathname || '') || `file_${Date.now()}`);
      if (!path.extname(fileName)) {
        fileName += guessDownloadExt(remote.url, remote.contentType);
      }
      const saved = await writeBufferToPublicDir(remote.buffer, fileName, targetDir, rootDir);
      results.push({ source: 'url', url, success: true, ...saved });
    } catch (error) {
      results.push({ source: 'url', url, success: false, message: error.message });
    }
  }

  for (const file of fileList) {
    const originalName = file?.originalname || `file_${Date.now()}`;
    const customName = nameList[nameIndex++] || '';
    try {
      let fileName = sanitizeFileName(customName || originalName);
      if (!path.extname(fileName) && file?.mimetype) {
        fileName += CONTENT_TYPE_EXT[String(file.mimetype).split(';')[0].trim().toLowerCase()] || '';
      }
      const buffer = Buffer.isBuffer(file?.buffer) ? file.buffer : Buffer.from(file?.buffer || []);
      const saved = await writeBufferToPublicDir(buffer, fileName, targetDir, rootDir);
      results.push({ source: 'file', originalName, success: true, ...saved });
    } catch (error) {
      results.push({ source: 'file', originalName, success: false, message: error.message });
    }
  }

  if (results.some((item) => item.success)) await touchProjectUpdateTime(rootDir);
  return { dirPath: rootDir, saveDir: relativeDir, results };
}

export async function downloadFile(url, filePath, dir) {
  const rootDir = resolveRootDir(dir);
  let fullPath = resolvePublicSavePath(filePath, rootDir);
  const remote = await fetchRemoteFile(url);
  if (!path.extname(fullPath)) {
    const extension = guessDownloadExt(remote.url, remote.contentType);
    if (extension) {
      fullPath += extension;
      assertWithinRoot(fullPath, rootDir);
      if (!isUnderPublic(fullPath, rootDir)) throw new Error('下载文件仅允许保存到 public 目录下');
    }
  }

  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, remote.buffer);
  await touchProjectUpdateTime(rootDir);
  return {
    dir: rootDir,
    path: fullPath,
    relativePath: path.relative(rootDir, fullPath),
    url: remote.url,
    bytes: remote.buffer.length,
  };
}

export async function resolvePublicAssetFile(filePath, dirPath) {
  if (!dirPath || !String(dirPath).trim()) throw new Error('项目根路径 dirPath 不能为空');
  if (!filePath || !String(filePath).trim()) throw new Error('文件路径 path 不能为空');
  const rootDir = resolveRootDir(dirPath);
  const fullPath = resolveTargetPath(filePath, rootDir);
  assertWithinRoot(fullPath, rootDir);
  if (!isUnderPublic(fullPath, rootDir)) throw new Error('仅允许访问 public 目录下的素材文件');

  let stat;
  try {
    stat = await fs.stat(fullPath);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('文件不存在');
    throw error;
  }
  if (stat.isDirectory()) throw new Error('目标路径是目录，无法读取');
  return { dirPath: rootDir, path: fullPath, relativePath: path.relative(rootDir, fullPath) };
}

export async function deletePublicAsset(filePath, dirPath) {
  const resolved = await resolvePublicAssetFile(filePath, dirPath);
  if (isProtectedPublicAsset(resolved.path, resolved.dirPath)) {
    throw new Error('不允许删除 public/favicon.ico，可通过上传同名文件替换');
  }
  await fs.unlink(resolved.path);
  await touchProjectUpdateTime(resolved.dirPath);
  return resolved;
}
