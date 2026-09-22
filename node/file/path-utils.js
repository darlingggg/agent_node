import path from 'path';
import connection from '../../Mysql/index.js';

export const PROJECT_TEMP_ROOT = 'C:\\pro_self\\projectTemp';

export function cleanPath(rawPath) {
  let cleaned = String(rawPath).trim();
  try {
    cleaned = decodeURIComponent(cleaned);
  } catch {
    // Keep the original text when it is not URI encoded.
  }
  return path.normalize(cleaned.replace(/[\u200B-\u200F\u202A-\u202E\uFEFF]/g, ''));
}

export function resolveRootDir(dir) {
  if (!dir) return PROJECT_TEMP_ROOT;
  const cleaned = cleanPath(dir);
  return path.isAbsolute(cleaned) ? cleaned : path.resolve(PROJECT_TEMP_ROOT, cleaned);
}

export function resolveTargetPath(targetPath, rootDir) {
  if (!targetPath) return rootDir;
  const cleaned = cleanPath(targetPath);
  return path.isAbsolute(cleaned) ? cleaned : path.resolve(rootDir, cleaned);
}

export function assertWithinRoot(fullPath, rootDir) {
  const relative = path.relative(rootDir, fullPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('不允许访问项目目录外的路径');
  }
}

function isUnderDirectory(fullPath, rootDir, directory) {
  const relative = path.relative(rootDir, fullPath);
  return relative === directory || relative.startsWith(`${directory}${path.sep}`);
}

export const isUnderSrc = (fullPath, rootDir) => isUnderDirectory(fullPath, rootDir, 'src');
export const isUnderPublic = (fullPath, rootDir) => isUnderDirectory(fullPath, rootDir, 'public');
export const isUnderAgentBase = (fullPath, rootDir) => isUnderDirectory(fullPath, rootDir, 'agent_base');

export function isProtectedPublicAsset(fullPath, rootDir) {
  return path.relative(rootDir, fullPath).replace(/\\/g, '/').toLowerCase() === 'public/favicon.ico';
}

export async function touchProjectUpdateTime(dirPath) {
  const rootDir = resolveRootDir(dirPath);
  await connection.query(
    `UPDATE projects
     SET update_time = CURRENT_TIMESTAMP
     WHERE dir_path = ? AND deleted_at IS NULL`,
    [rootDir],
  );
}
