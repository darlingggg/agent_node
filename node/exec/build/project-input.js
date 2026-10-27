import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

export const BUILD_CACHE_ROOT = path.resolve(process.env.BUILD_CACHE_ROOT || path.join(os.tmpdir(), 'agent-project-builds'));
const EXCLUDED = new Set(['node_modules', 'dist', 'dist-ssr', '.git', '.vscode', '.preview-cache', 'coverage']);

export function projectCacheRoot(projectId) {
  if (!Number.isSafeInteger(projectId) || projectId < 1) throw new Error('项目 id 无效');
  return path.join(BUILD_CACHE_ROOT, String(projectId));
}

/** 流式读取文件原始字节，计算 SHA-256，避免一次性加载整个文件。 */
async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** 逐层按名称排序遍历，生成由相对路径和文件内容哈希组成的清单。 */
export async function projectManifest(root, relative = '', include = () => true) {
  const files = [];
  const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (EXCLUDED.has(entry.name)) continue;
    const name = path.posix.join(relative, entry.name);
    if (name === 'agent_base/versions') continue;
    if (entry.isSymbolicLink()) throw new Error(`构建输入不支持符号链接: ${name}`);
    if (entry.isDirectory()) files.push(...await projectManifest(root, name, include));
    if (entry.isFile() && include(name)) files.push([name, await hashFile(path.join(root, name))]);
  }
  return files;
}

/** 对文件清单的 JSON 字符串再次计算 SHA-256，得到项目内容版本指纹。 */
export function manifestRevision(manifest) {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

/** 在磁盘上复制并校验项目输入，避免将游戏资源整体缓存在 Node.js 堆内存中。 */
export async function captureProjectInput(projectId, root) {
  const inputs = path.join(projectCacheRoot(projectId), 'inputs');
  await fs.mkdir(inputs, { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    const directory = path.join(inputs, randomUUID());
    await fs.mkdir(directory);
    try {
      const before = await projectManifest(root);
      for (const [relative] of before) {
        const target = path.join(directory, relative);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(path.join(root, relative), target);
      }
      const revision = manifestRevision(before);
      const copied = manifestRevision(await projectManifest(directory));
      const after = manifestRevision(await projectManifest(root));
      // 复制前的源码、输入副本和复制后的源码指纹一致，才接受本次输入。
      if (revision === copied && revision === after) {
        return { directory, revision, dispose: () => fs.rm(directory, { recursive: true, force: true }) };
      }
    } catch (error) {
      await fs.rm(directory, { recursive: true, force: true });
      if (error.code !== 'ENOENT') throw error;
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
  throw new Error('项目文件仍在变化，请等待本轮修改完成后重试');
}

export async function prepareWorkspace(projectId, input) {
  const workspace = path.join(projectCacheRoot(projectId), 'work');
  await fs.mkdir(workspace, { recursive: true });
  for (const entry of await fs.readdir(workspace)) {
    if (entry !== 'node_modules') await fs.rm(path.join(workspace, entry), { recursive: true, force: true });
  }
  await fs.cp(input.directory, workspace, { recursive: true });
  return workspace;
}

/** 仅对依赖声明、锁文件、安装配置、补丁和运行时信息计算依赖指纹。 */
export async function dependencyRevision(directory) {
  const dependencies = await projectManifest(directory, '', (name) =>
    /(^|\/)(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|\.pnpmfile\.cjs)$/.test(name)
    || name.startsWith('patches/'));
  return manifestRevision([['runtime', `${process.version}:${process.platform}:${process.arch}:pnpm11`], ...dependencies]);
}

export async function readCacheJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

/** 每个项目仅保留两份本地构建产物，不影响 Cloudflare 上已发布链接的访问。 */
export async function pruneBuildArtifacts(projectId, currentRevision) {
  const root = path.join(projectCacheRoot(projectId), 'artifacts');
  const entries = await fs.readdir(root, { withFileTypes: true });
  const markers = await Promise.all(entries.filter((entry) => /^[a-f0-9]{64}\.json$/.test(entry.name))
    .map(async (entry) => ({ revision: entry.name.slice(0, -5),
      modified: (await fs.stat(path.join(root, entry.name))).mtimeMs })));
  markers.sort((a, b) => b.modified - a.modified);
  const previous = markers.find((entry) => entry.revision !== currentRevision)?.revision;
  const keep = new Set([currentRevision, previous]);
  for (const entry of entries) {
    const revision = entry.name.replace(/\.json$/, '');
    if (/^[a-f0-9]{64}$/.test(revision) && !keep.has(revision)) {
      await fs.rm(path.join(root, entry.name), { recursive: entry.isDirectory(), force: true });
    }
  }
}

export async function clearAbandonedBuildInputs() {
  const projects = await fs.readdir(BUILD_CACHE_ROOT, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const project of projects) {
    if (!project.isDirectory() || !/^\d+$/.test(project.name)) continue;
    await fs.rm(path.join(BUILD_CACHE_ROOT, project.name, 'inputs'), { recursive: true, force: true });
  }
}
