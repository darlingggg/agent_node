import { createReadStream } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import readline from 'readline';

/** 默认项目根目录 */
export const PROJECT_TEMP_ROOT = 'C:\\pro_self\\projectTemp';

/** 需要跳过的目录名 */
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'dist-ssr',
  'coverage',
  '.idea',
  'logs',
  '__screenshots__',
  '.vscode',
  'versions'
]);

/** 需要跳过的文件名 */
const IGNORED_FILES = new Set([
  '.DS_Store',
  'Thumbs.db',
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  '.eslintcache',
  '.gitignore',
  '.npmrc',
  'README.md',
  "version.json"
]);

/** 需要跳过的文件后缀 */
const IGNORED_EXTENSIONS = new Set([
  '.log',
  '.local',
  '.suo',
  '.tsbuildinfo',
]);

/**
 * 判断文件是否应被过滤
 * @param {string} fileName 文件名
 * @returns {boolean}
 */
function shouldSkipFile(fileName) {
  if (IGNORED_FILES.has(fileName)) {
    return true;
  }
  return IGNORED_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

/**
 * 清理路径字符串
 * @param {string} rawPath 原始路径
 * @returns {string}
 */
function cleanPath(rawPath) {
  let cleaned = String(rawPath).trim();

  try {
    cleaned = decodeURIComponent(cleaned);
  } catch {
  }

  cleaned = cleaned.replace(/[\u200B-\u200F\u202A-\u202E\uFEFF]/g, '');
  return path.normalize(cleaned);
}

/**
 * 解析项目根目录
 * @param {string} [dir] 项目根目录，默认 PROJECT_TEMP_ROOT
 * @returns {string}
 */
function resolveRootDir(dir) {
  if (!dir) {
    return PROJECT_TEMP_ROOT;
  }

  const cleaned = cleanPath(dir);
  return path.isAbsolute(cleaned)
    ? cleaned
    : path.resolve(PROJECT_TEMP_ROOT, cleaned);
}

/**
 * 基于根目录解析目标路径
 * @param {string} targetPath 目标路径
 * @param {string} rootDir 项目根目录
 * @returns {string}
 */
function resolveTargetPath(targetPath, rootDir) {
  if (!targetPath) {
    return rootDir;
  }

  const cleaned = cleanPath(targetPath);
  return path.isAbsolute(cleaned)
    ? cleaned
    : path.resolve(rootDir, cleaned);
}

/**
 * 校验路径是否在指定根目录内
 * @param {string} fullPath 绝对路径
 * @param {string} rootDir 项目根目录
 */
function assertWithinRoot(fullPath, rootDir) {
  const relative = path.relative(rootDir, fullPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('不允许访问项目目录外的路径');
  }
}

/**
 * 判断路径是否在 src 目录下
 * @param {string} fullPath 绝对路径
 * @param {string} rootDir 项目根目录
 * @returns {boolean}
 */
function isUnderSrc(fullPath, rootDir) {
  const relative = path.relative(rootDir, fullPath);
  return relative === 'src' || relative.startsWith(`src${path.sep}`);
}

/**
 * 判断路径是否在 agent_base 目录下
 * @param {string} fullPath 绝对路径
 * @param {string} rootDir 项目根目录
 * @returns {boolean}
 */
function isUnderAgentBase(fullPath, rootDir) {
  const relative = path.relative(rootDir, fullPath);
  return relative === 'agent_base' || relative.startsWith(`agent_base${path.sep}`);
}

/**
 * 转义 HTML 特殊字符，防止注入
 * @param {string} str 原始字符串
 * @returns {string}
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 更新项目 index.html 的 title 和 description
 * @param {string} dirPath 项目根目录
 * @param {string} title 页面标题
 * @param {string} [desc] 页面描述，无则移除 description meta
 */
export async function updateProjectIndexHtml(dirPath, title, desc) {
  const indexPath = path.join(dirPath, 'index.html');
  let html = await fs.readFile(indexPath, 'utf-8');

  html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(title)}</title>`);

  const descMetaRegex = /<meta\s+name=["']description["'][^>]*>/i;
  const descText = desc?.trim();

  if (descText) {
    const metaTag = `<meta name="description" content="${escapeHtml(descText)}">`;
    html = descMetaRegex.test(html)
      ? html.replace(descMetaRegex, metaTag)
      : html.replace(/<\/head>/i, `    ${metaTag}\n  </head>`);
  } else {
    html = html.replace(/\s*<meta\s+name=["']description["'][^>]*>\s*/i, '\n');
  }

  await fs.writeFile(indexPath, html, 'utf-8');
}

/**
 * 拷贝文件夹到指定目录
 * @param {string} sourceDir 源目录
 * @param {string} targetDir 目标目录
 * @returns {Promise<void>}
 */
export async function copyDir(sourceDir, targetDir) {
  await fs.cp(sourceDir, targetDir, { recursive: true,filter: src => !src.includes('node_modules')});
  return {dirPath: targetDir}
}

/**
 * 删除文件夹
 * @param {string} dirPath 文件夹路径
 * @returns {Promise<void>}
 */
export async function deleteDir(dirPath) {
  await fs.rm(dirPath, { recursive: true });
  return {dirPath}
}

/**
 * 获取指定目录下的所有文件
 * @param {string} dir 项目根目录
 * @returns {Promise<Array<{path: string, name: string, relativePath: string}>>}
 */
export async function getProjectTempFiles(dir) {
  const files = [];
  async function walk(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) {
        continue;
      }

      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && !shouldSkipFile(entry.name)) {
        files.push({
          path: fullPath,
          name: entry.name,
          relativePath: path.relative(dir, fullPath),
        });
      }
    }
  }

  await walk(dir);
  return files;
}

/**
 * 获取文件内容
 * @param {string} filePath 文件路径
 * @param {string} [dir] 项目根目录，默认 PROJECT_TEMP_ROOT
 * @returns {Promise<string>}
 */
export async function getFileContent(filePath, dir) {
  const rootDir = resolveRootDir(dir);
  const fullPath = resolveTargetPath(filePath, rootDir);
  assertWithinRoot(fullPath, rootDir);
  return fs.readFile(fullPath, 'utf-8');
}

/**
 * 写入文件内容，文件已存在则覆盖
 * @param {string} filePath 文件路径
 * @param {string} content 文件内容
 * @param {string} [dir] 项目根目录，默认 PROJECT_TEMP_ROOT
 * @param {boolean} [judgeSrc=true] 为 true 时禁止修改 agent_base，且仅 src 下自动创建父目录；为 false 时不限制（供系统模板更新使用）
 * @returns {Promise<{path: string, relativePath: string, dir: string}>}
 */
export async function writeFileContent(filePath, content = '', dir, judgeSrc = true) {
  const rootDir = resolveRootDir(dir);
  const fullPath = resolveTargetPath(filePath, rootDir);
  assertWithinRoot(fullPath, rootDir);

  // judgeSrc 为 true 时禁止修改 agent_base 底座文件（系统模板更新传 false 可绕过）
  if (judgeSrc && isUnderAgentBase(fullPath, rootDir)) {
    throw new Error('不允许修改 agent_base 项目底座下的文件');
  }

  try {
    const stat = await fs.stat(fullPath);
    if (stat.isDirectory()) {
      throw new Error('目标路径是目录，无法写入文件');
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }

  const parentDir = path.dirname(fullPath);
  let parentExists = false;

  try {
    const parentStat = await fs.stat(parentDir);
    parentExists = parentStat.isDirectory();
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }

  if (!parentExists) {
    // judgeSrc 为 true 时，仅 src 目录下允许自动创建；为 false 时任意路径均可创建
    if (!judgeSrc || isUnderSrc(fullPath, rootDir)) {
      await fs.mkdir(parentDir, { recursive: true });
    } else {
      throw new Error('父目录不存在，仅 src 目录下支持自动创建目录');
    }
  }

  await fs.writeFile(fullPath, content, 'utf-8');

  return {
    dir: rootDir,
    path: fullPath,
    relativePath: path.relative(rootDir, fullPath),
  };
}

/**
 * 流式统计文件行数，避免将整个文件读入内存
 * @param {string} fullPath 文件绝对路径
 * @returns {Promise<number>}
 */
export async function countFileLines(fullPath) {
  let lines = 0;
  const rl = readline.createInterface({
    input: createReadStream(fullPath),
    crlfDelay: Infinity,
  });

  for await (const _ of rl) {
    lines++;
  }

  return lines;
}

/**
 * 获取文件 stat 信息
 * @param {string} filePath 文件绝对路径
 * @returns {Promise<import('fs').Stats>}
 */
export async function getFileBytes(filePath) {
  return fs.stat(filePath);
}

/**
 * 获取文件字节数与行数
 * @param {string} filePath 文件路径（绝对或相对项目根）
 * @param {string} [dir] 项目根目录
 * @returns {Promise<{ path: string, relativePath: string, bytes: number, length: number }>}
 */
export async function getFileMeta(filePath, dir) {
  const rootDir = resolveRootDir(dir);
  const fullPath = resolveTargetPath(filePath, rootDir);
  assertWithinRoot(fullPath, rootDir);

  const stat = await fs.stat(fullPath);
  if (stat.isDirectory()) {
    throw new Error('目标路径是目录，无法获取文件信息');
  }

  const length = await countFileLines(fullPath);

  return {
    path: fullPath,
    relativePath: path.relative(rootDir, fullPath),
    bytes: stat.size,
    length,
  };
}

/**
 * 删除指定文件
 * @param {string} filePath 文件路径（绝对或相对项目根）
 * @param {string} [dir] 项目根目录
 * @returns {Promise<{ path: string, relativePath: string }>}
 */
export async function deleteFileContent(filePath, dir) {
  const rootDir = resolveRootDir(dir)
  const fullPath = resolveTargetPath(filePath, rootDir)
  assertWithinRoot(fullPath, rootDir)

  const stat = await fs.stat(fullPath)
  if (stat.isDirectory()) {
    throw new Error('目标路径是目录，请使用 deleteDir 删除')
  }

  await fs.unlink(fullPath)

  return {
    content: '删除成功',
    path: fullPath,
  }
}