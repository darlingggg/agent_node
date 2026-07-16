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
 * 判断路径是否在 public 目录下
 * @param {string} fullPath 绝对路径
 * @param {string} rootDir 项目根目录
 * @returns {boolean}
 */
function isUnderPublic(fullPath, rootDir) {
  const relative = path.relative(rootDir, fullPath);
  return relative === 'public' || relative.startsWith(`public${path.sep}`);
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
 * @param {boolean} [judgeSrc=true] 为 true 时禁止修改 agent_base，且 仅src 和 public 下自动创建父目录；为 false 时不限制（供系统模板更新使用）
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
    if (!judgeSrc || isUnderSrc(fullPath, rootDir) || isUnderPublic(fullPath, rootDir)) {
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

/** 下载文件大小上限（字节），默认 10MB */
const DOWNLOAD_MAX_BYTES = 10 * 1024 * 1024

/** Content-Type 到扩展名的映射（URL 无扩展名时使用） */
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
}

/** 禁止作为下载目标的项目顶级目录（除 public 外） */
const FORBIDDEN_TOP_DIRS = new Set(['src', 'agent_base', 'node_modules', 'dist', 'versions'])

/**
 * 将保存路径规范到 public 目录下的相对路径
 * @param {string} filePath AI 传入的相对路径
 * @param {string} rootDir 项目根目录
 * @returns {string} 位于 public 下的绝对路径
 */
function resolvePublicSavePath(filePath, rootDir) {
  if (!filePath || !String(filePath).trim()) {
    throw new Error('保存路径 path 不能为空')
  }

  let cleaned = cleanPath(filePath)

  // 若传入绝对路径且落在项目内，转为相对路径
  if (path.isAbsolute(cleaned)) {
    assertWithinRoot(cleaned, rootDir)
    cleaned = path.relative(rootDir, cleaned)
  }

  // 统一为正斜杠再判断，兼容 Windows
  const relPosix = cleaned.replace(/\\/g, '/')
  const firstSeg = relPosix.split('/')[0]

  if (FORBIDDEN_TOP_DIRS.has(firstSeg)) {
    throw new Error('下载文件仅允许保存到 public 目录下')
  }

  if (relPosix === 'public' || relPosix.startsWith('public/')) {
    // 已是 public 下路径
  } else {
    // 未带 public 前缀时（如 images/a.png），自动归入 public/
    cleaned = path.join('public', cleaned)
  }

  const fullPath = path.resolve(rootDir, cleaned)
  assertWithinRoot(fullPath, rootDir)

  if (!isUnderPublic(fullPath, rootDir)) {
    throw new Error('下载文件仅允许保存到 public 目录下')
  }

  // 禁止直接把目录当作文件写入
  const relative = path.relative(rootDir, fullPath)
  if (relative === 'public') {
    throw new Error('path 不能是 public 目录本身，请指定具体文件名，如 public/images/a.png')
  }

  return fullPath
}

/**
 * 从 URL 推断文件扩展名
 * @param {string} url 下载地址
 * @param {string} [contentType] 响应 Content-Type
 * @returns {string} 扩展名（含点），无则空字符串
 */
function guessDownloadExt(url, contentType) {
  try {
    const pathname = new URL(url).pathname
    const ext = path.extname(pathname).toLowerCase()
    if (ext && ext.length <= 10) return ext
  } catch {
  }

  if (contentType) {
    const type = contentType.split(';')[0].trim().toLowerCase()
    return CONTENT_TYPE_EXT[type] || ''
  }
  return ''
}

/**
 * 将接口 path 参数规范为 public 下的相对子目录
 * `/` 或空 → public；`/images`、`/images/`、`images` → public/images
 * @param {string} [subPath='/'] 用户上传的相对目录
 * @returns {string} 相对项目根的目录，如 public 或 public/images
 */
function normalizePublicSubDir(subPath = '/') {
  let cleaned = String(subPath ?? '/').trim().replace(/\\/g, '/')
  if (!cleaned || cleaned === '/') return 'public'

  cleaned = cleaned.replace(/^\/+/, '').replace(/\/+$/, '')
  if (!cleaned) return 'public'

  const segments = cleaned.split('/').filter(Boolean)
  if (segments.some((seg) => seg === '..')) {
    throw new Error('非法路径')
  }

  const firstSeg = segments[0]
  if (FORBIDDEN_TOP_DIRS.has(firstSeg)) {
    throw new Error('文件仅允许保存到 public 目录下')
  }

  if (firstSeg === 'public') {
    return segments.join('/')
  }
  return ['public', ...segments].join('/')
}

/**
 * 解析 public 下目标目录的绝对路径
 * @param {string} subPath 接口 path 参数
 * @param {string} rootDir 项目根目录
 * @returns {{ targetDir: string, relativeDir: string }}
 */
function resolvePublicTargetDir(subPath, rootDir) {
  const relativeDir = normalizePublicSubDir(subPath)
  const targetDir = path.resolve(rootDir, relativeDir)
  assertWithinRoot(targetDir, rootDir)

  const relative = path.relative(rootDir, targetDir)
  if (relative !== 'public' && !relative.startsWith(`public${path.sep}`)) {
    throw new Error('文件仅允许保存到 public 目录下')
  }

  return { targetDir, relativeDir }
}

/**
 * 从 URL 或原始文件名得到安全的保存文件名
 * @param {string} rawName 原始名称
 * @returns {string}
 */
function sanitizeFileName(rawName) {
  const base = path.basename(String(rawName || '').trim())
  const safe = base.replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/^\.+/, '')
  if (!safe) {
    throw new Error('无法解析有效的文件名')
  }
  return safe
}

/**
 * 判断是否为受保护的 public 素材（禁止删除，允许上传替换）
 * @param {string} fullPath 文件绝对路径
 * @param {string} rootDir 项目根目录
 * @returns {boolean}
 */
function isProtectedPublicAsset(fullPath, rootDir) {
  const relative = path.relative(rootDir, fullPath).replace(/\\/g, '/').toLowerCase()
  return relative === 'public/favicon.ico'
}

/**
 * 解析用户指定的保存文件名列表
 * @param {unknown} raw 原始 saveNames / fileName
 * @returns {string[]}
 */
function normalizeSaveNames(raw) {
  if (raw == null || raw === '') return []
  if (Array.isArray(raw)) {
    return raw.map((item) => (item == null ? '' : String(item).trim()))
  }
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (!text) return []
    if (text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text)
        if (Array.isArray(parsed)) {
          return parsed.map((item) => (item == null ? '' : String(item).trim()))
        }
      } catch {
      }
    }
    return [text]
  }
  return [String(raw).trim()].filter(Boolean)
}

/**
 * 将 Buffer 写入 public 子目录
 * @param {Buffer} buffer 文件内容
 * @param {string} fileName 文件名
 * @param {string} targetDir public 下目标目录绝对路径
 * @param {string} rootDir 项目根目录
 * @returns {Promise<{ path: string, relativePath: string, bytes: number, fileName: string }>}
 */
async function writeBufferToPublicDir(buffer, fileName, targetDir, rootDir) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error('文件内容无效')
  }
  if (buffer.length > DOWNLOAD_MAX_BYTES) {
    throw new Error(`文件过大，超过 ${DOWNLOAD_MAX_BYTES / 1024 / 1024}MB 限制`)
  }

  const safeName = sanitizeFileName(fileName)
  const fullPath = path.join(targetDir, safeName)
  assertWithinRoot(fullPath, rootDir)
  if (!isUnderPublic(fullPath, rootDir)) {
    throw new Error('文件仅允许保存到 public 目录下')
  }

  await fs.mkdir(targetDir, { recursive: true })
  await fs.writeFile(fullPath, buffer)

  return {
    path: fullPath,
    relativePath: path.relative(rootDir, fullPath),
    bytes: buffer.length,
    fileName: safeName,
  }
}

/**
 * 从前端导入文件到项目 public 目录（支持多 URL + 多上传文件）
 * @param {object} options 参数
 * @param {string} options.dirPath 项目根目录（绝对路径）
 * @param {string} [options.path='/'] public 下子目录，如 / 或 /images
 * @param {string[]} [options.urls=[]] 远程文件 URL 列表
 * @param {Array<{ originalname?: string, buffer: Buffer, mimetype?: string }>} [options.files=[]] 上传文件列表
 * @param {string|string[]} [options.saveNames] 自定义保存文件名，按「先 urls 后 files」顺序对应；空项表示该文件用默认名
 * @returns {Promise<{ dirPath: string, saveDir: string, results: Array<object> }>}
 */
export async function importFilesToPublic({ dirPath, path: subPath = '/', urls = [], files = [], saveNames } = {}) {
  if (!dirPath || !String(dirPath).trim()) {
    throw new Error('项目根路径 dirPath 不能为空')
  }

  const urlList = Array.isArray(urls) ? urls : []
  const fileList = Array.isArray(files) ? files : []
  if (urlList.length === 0 && fileList.length === 0) {
    throw new Error('请至少提供一个 url 或上传文件')
  }

  const nameList = normalizeSaveNames(saveNames)
  const rootDir = resolveRootDir(dirPath)
  const { targetDir, relativeDir } = resolvePublicTargetDir(subPath, rootDir)
  const results = []
  let nameIndex = 0

  for (const rawUrl of urlList) {
    const url = String(rawUrl || '').trim()
    const customName = nameList[nameIndex++] || ''
    if (!url) {
      results.push({ source: 'url', success: false, message: 'url 为空' })
      continue
    }
    try {
      let parsed
      try {
        parsed = new URL(url)
      } catch {
        throw new Error('下载地址 url 格式无效')
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('仅支持 http/https 协议的下载地址')
      }

      const response = await fetch(url, {
        redirect: 'follow',
        headers: { 'User-Agent': 'agentNode-download/1.0' },
      })
      if (!response.ok) {
        throw new Error(`下载失败，HTTP ${response.status} ${response.statusText}`)
      }

      const contentType = response.headers.get('content-type') || ''
      const contentLength = Number(response.headers.get('content-length') || 0)
      if (contentLength > DOWNLOAD_MAX_BYTES) {
        throw new Error(`文件过大，超过 ${DOWNLOAD_MAX_BYTES / 1024 / 1024}MB 限制`)
      }

      let fileName = ''
      if (customName) {
        fileName = sanitizeFileName(customName)
      } else {
        const rawBase = path.basename(parsed.pathname || '')
        fileName = rawBase ? sanitizeFileName(rawBase) : ''
      }
      if (!path.extname(fileName)) {
        const ext = guessDownloadExt(url, contentType)
        if (ext) fileName = `${fileName || `file_${Date.now()}`}${ext}`
      }
      if (!fileName) {
        fileName = `file_${Date.now()}${guessDownloadExt(url, contentType) || ''}`
      }

      const buffer = Buffer.from(await response.arrayBuffer())
      const saved = await writeBufferToPublicDir(buffer, fileName, targetDir, rootDir)
      results.push({ source: 'url', url, success: true, ...saved })
    } catch (err) {
      results.push({ source: 'url', url, success: false, message: err.message })
    }
  }

  for (const file of fileList) {
    const originalName = file?.originalname || `file_${Date.now()}`
    const customName = nameList[nameIndex++] || ''
    try {
      let fileName = customName ? sanitizeFileName(customName) : sanitizeFileName(originalName)
      if (!path.extname(fileName) && file?.mimetype) {
        const ext = CONTENT_TYPE_EXT[String(file.mimetype).split(';')[0].trim().toLowerCase()]
        if (ext) fileName = `${fileName}${ext}`
      }
      const buffer = Buffer.isBuffer(file?.buffer) ? file.buffer : Buffer.from(file?.buffer || [])
      const saved = await writeBufferToPublicDir(buffer, fileName, targetDir, rootDir)
      results.push({ source: 'file', originalName, success: true, ...saved })
    } catch (err) {
      results.push({ source: 'file', originalName, success: false, message: err.message })
    }
  }

  return {
    dirPath: rootDir,
    saveDir: relativeDir,
    results,
  }
}

/**
 * 从远程 URL 下载文件到项目 public 目录（支持图片及其他类型）
 * @param {string} url 文件 URL（http/https）
 * @param {string} filePath 相对路径，必须落在 public 下，如 public/images/a.png 或 images/a.png
 * @param {string} [dir] 项目根目录，默认 PROJECT_TEMP_ROOT
 * @returns {Promise<{ path: string, relativePath: string, dir: string, url: string, bytes: number }>}
 */
export async function downloadFile(url, filePath, dir) {
  const rawUrl = String(url || '').trim()
  if (!rawUrl) {
    throw new Error('下载地址 url 不能为空')
  }

  let parsed
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error('下载地址 url 格式无效')
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('仅支持 http/https 协议的下载地址')
  }

  const rootDir = resolveRootDir(dir)
  let fullPath = resolvePublicSavePath(filePath, rootDir)

  const response = await fetch(rawUrl, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'agentNode-download/1.0',
    },
  })

  if (!response.ok) {
    throw new Error(`下载失败，HTTP ${response.status} ${response.statusText}`)
  }

  const contentType = response.headers.get('content-type') || ''
  const contentLength = Number(response.headers.get('content-length') || 0)
  if (contentLength > DOWNLOAD_MAX_BYTES) {
    throw new Error(`文件过大，超过 ${DOWNLOAD_MAX_BYTES / 1024 / 1024}MB 限制`)
  }

  // 保存路径无扩展名时，根据 URL 或 Content-Type 补全
  if (!path.extname(fullPath)) {
    const ext = guessDownloadExt(rawUrl, contentType)
    if (ext) {
      fullPath = `${fullPath}${ext}`
      assertWithinRoot(fullPath, rootDir)
      if (!isUnderPublic(fullPath, rootDir)) {
        throw new Error('下载文件仅允许保存到 public 目录下')
      }
    }
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length > DOWNLOAD_MAX_BYTES) {
    throw new Error(`文件过大，超过 ${DOWNLOAD_MAX_BYTES / 1024 / 1024}MB 限制`)
  }

  const parentDir = path.dirname(fullPath)
  await fs.mkdir(parentDir, { recursive: true })
  await fs.writeFile(fullPath, buffer)

  return {
    dir: rootDir,
    path: fullPath,
    relativePath: path.relative(rootDir, fullPath),
    url: rawUrl,
    bytes: buffer.length,
  }
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

/**
 * 解析并校验 public 下的素材文件路径（用于预览读取）
 * @param {string} filePath 文件绝对路径或相对项目根路径
 * @param {string} dirPath 项目根目录（绝对路径）
 * @returns {Promise<{ dirPath: string, path: string, relativePath: string }>}
 */
export async function resolvePublicAssetFile(filePath, dirPath) {
  if (!dirPath || !String(dirPath).trim()) {
    throw new Error('项目根路径 dirPath 不能为空')
  }
  if (!filePath || !String(filePath).trim()) {
    throw new Error('文件路径 path 不能为空')
  }

  const rootDir = resolveRootDir(dirPath)
  const fullPath = resolveTargetPath(filePath, rootDir)
  assertWithinRoot(fullPath, rootDir)

  if (!isUnderPublic(fullPath, rootDir)) {
    throw new Error('仅允许访问 public 目录下的素材文件')
  }

  let stat
  try {
    stat = await fs.stat(fullPath)
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error('文件不存在')
    }
    throw err
  }

  if (stat.isDirectory()) {
    throw new Error('目标路径是目录，无法读取')
  }

  return {
    dirPath: rootDir,
    path: fullPath,
    relativePath: path.relative(rootDir, fullPath),
  }
}

/**
 * 删除项目 public 下的上传素材（仅允许删除 public 内文件）
 * @param {string} filePath 文件绝对路径或相对项目根路径，如 public/images/a.png
 * @param {string} dirPath 项目根目录（绝对路径）
 * @returns {Promise<{ path: string, relativePath: string, dirPath: string }>}
 */
export async function deletePublicAsset(filePath, dirPath) {
  if (!dirPath || !String(dirPath).trim()) {
    throw new Error('项目根路径 dirPath 不能为空')
  }
  if (!filePath || !String(filePath).trim()) {
    throw new Error('文件路径 path 不能为空')
  }

  const rootDir = resolveRootDir(dirPath)
  const fullPath = resolveTargetPath(filePath, rootDir)
  assertWithinRoot(fullPath, rootDir)

  if (!isUnderPublic(fullPath, rootDir)) {
    throw new Error('仅允许删除 public 目录下的素材文件')
  }

  if (isProtectedPublicAsset(fullPath, rootDir)) {
    throw new Error('不允许删除 public/favicon.ico，可通过上传同名文件替换')
  }

  let stat
  try {
    stat = await fs.stat(fullPath)
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error('文件不存在')
    }
    throw err
  }

  if (stat.isDirectory()) {
    throw new Error('目标路径是目录，无法删除')
  }

  await fs.unlink(fullPath)

  return {
    dirPath: rootDir,
    path: fullPath,
    relativePath: path.relative(rootDir, fullPath),
  }
}