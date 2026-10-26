import { createReadStream } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import readline from 'readline';
import {
  assertWithinRoot,
  isUnderAgentBase,
  isUnderPublic,
  isUnderSrc,
  resolveRootDir,
  resolveTargetPath,
  touchProjectUpdateTime,
} from './path-utils.js';

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
  'versions',
]);
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
  'version.json',
]);
const IGNORED_EXTENSIONS = new Set(['.log', '.local', '.suo', '.tsbuildinfo']);

function shouldSkipFile(fileName) {
  return (
    IGNORED_FILES.has(fileName) || IGNORED_EXTENSIONS.has(path.extname(fileName).toLowerCase())
  );
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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
  await touchProjectUpdateTime(dirPath);
}

export async function copyDir(sourceDir, targetDir) {
  await fs.cp(sourceDir, targetDir, {
    recursive: true,
    filter: (source) => !source.includes('node_modules'),
  });
  await touchProjectUpdateTime(targetDir);
  return { dirPath: targetDir };
}

export async function deleteDir(dirPath) {
  await fs.rm(dirPath, { recursive: true });
  return { dirPath };
}

export async function getProjectTempFiles(dir) {
  const files = [];
  async function walk(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && !shouldSkipFile(entry.name)) {
        const stat = await fs.stat(fullPath);
        files.push({
          path: fullPath,
          name: entry.name,
          relativePath: path.relative(dir, fullPath),
          bytes: stat.size,
        });
      }
    }
  }
  await walk(dir);
  return files;
}

export async function getFileContent(filePath, dir) {
  const rootDir = resolveRootDir(dir);
  const fullPath = resolveTargetPath(filePath, rootDir);
  assertWithinRoot(fullPath, rootDir);
  return fs.readFile(fullPath, 'utf-8');
}

export async function writeFileContent(filePath, content = '', dir, judgeSrc = true) {
  const rootDir = resolveRootDir(dir);
  const fullPath = resolveTargetPath(filePath, rootDir);
  assertWithinRoot(fullPath, rootDir);
  if (judgeSrc && isUnderAgentBase(fullPath, rootDir)) {
    throw new Error('不允许修改 agent_base 项目底座下的文件');
  }

  try {
    const stat = await fs.stat(fullPath);
    if (stat.isDirectory()) throw new Error('目标路径是目录，无法写入文件');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const parentDir = path.dirname(fullPath);
  let parentExists = false;
  try {
    parentExists = (await fs.stat(parentDir)).isDirectory();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  if (!parentExists) {
    if (!judgeSrc || isUnderSrc(fullPath, rootDir) || isUnderPublic(fullPath, rootDir)) {
      await fs.mkdir(parentDir, { recursive: true });
    } else {
      throw new Error('父目录不存在，仅 src 目录下支持自动创建目录');
    }
  }

  await fs.writeFile(fullPath, content, 'utf-8');
  await touchProjectUpdateTime(rootDir);
  return { dir: rootDir, path: fullPath, relativePath: path.relative(rootDir, fullPath) };
}

export async function countFileLines(fullPath) {
  let lines = 0;
  const reader = readline.createInterface({
    input: createReadStream(fullPath),
    crlfDelay: Infinity,
  });
  for await (const _line of reader) lines += 1;
  return lines;
}

export async function getFileBytes(filePath) {
  return fs.stat(filePath);
}

export async function getFileMeta(filePath, dir) {
  const rootDir = resolveRootDir(dir);
  const fullPath = resolveTargetPath(filePath, rootDir);
  assertWithinRoot(fullPath, rootDir);
  const stat = await fs.stat(fullPath);
  if (stat.isDirectory()) throw new Error('目标路径是目录，无法获取文件信息');
  return {
    path: fullPath,
    relativePath: path.relative(rootDir, fullPath),
    bytes: stat.size,
    length: await countFileLines(fullPath),
  };
}

export async function deleteFileContent(filePath, dir) {
  const rootDir = resolveRootDir(dir);
  const fullPath = resolveTargetPath(filePath, rootDir);
  assertWithinRoot(fullPath, rootDir);
  const stat = await fs.stat(fullPath);
  if (stat.isDirectory()) throw new Error('目标路径是目录，请使用 deleteDir 删除');
  await fs.unlink(fullPath);
  await touchProjectUpdateTime(rootDir);
  return { content: '删除成功', path: fullPath };
}

export function assertDeletableToolPath(filePath, dirPath) {
  const rootDir = path.resolve(dirPath);
  const fullPath = path.resolve(rootDir, filePath);
  const relativePath = path.relative(rootDir, fullPath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error('不允许删除项目目录外的文件');
  }
  const normalized = relativePath.replace(/\\/g, '/');
  if (!normalized.startsWith('src/') && !normalized.startsWith('public/')) {
    throw new Error('仅允许删除 src 或 public 目录下的文件');
  }
  if (normalized.toLowerCase() === 'public/favicon.ico') {
    throw new Error('不允许删除 public/favicon.ico，可通过上传同名文件替换');
  }
}
