import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

// 每个项目各有 inputs/work/artifacts/upload，避免直接在持续编辑的源码目录安装、构建。
export const BUILD_CACHE_ROOT = path.resolve(process.env.BUILD_CACHE_ROOT || path.join(
  process.platform === 'linux' ? path.join(os.homedir(), '.cache') : os.tmpdir(), 'agent-project-builds'));
const EXCLUDED = new Set(['node_modules', 'dist', 'dist-ssr', '.git', '.vscode', '.preview-cache', 'coverage',
  '.agent-build', '.agent-build-logs']);

/** 校验项目 ID 并返回该项目的缓存根目录；这里只计算路径，不创建目录。 */
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

/**
 * 递归生成 [[相对路径, 文件 SHA-256], ...]，固定排序使相同内容得到稳定指纹。
 * 排除依赖、产物、历史及内部目录；include 可进一步筛选文件，供依赖指纹复用。
 * 拒绝符号链接，避免副本构建读取项目目录之外的文件。
 */
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

/**
 * 把源码固定为独立 inputs/<uuid> 副本，供 service 提交任务，避免排队期间编辑影响任务。
 * 对比复制前、复制后原目录及副本的指纹；不一致或文件消失时最多尝试 3 次。
 * 返回 { directory, revision, dispose }：副本路径、源码版本、删除副本的异步回调。
 * 未提交的副本由 service 清理，调度器接管后在完成/替换/超时时清理。
 */
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

/**
 * 将本次固定输入复制到项目 work 目录，返回运行 pnpm 的工作路径。
 * 清除上次源码但保留 node_modules；依赖是否仍适用由 pipeline 的依赖指纹决定。
 * 同项目 work 会被复用，依赖 scheduler 的单执行槽避免同时覆盖。
 */
export async function prepareWorkspace(projectId, input) {
  const workspace = path.join(projectCacheRoot(projectId), 'work');
  await fs.mkdir(workspace, { recursive: true });
  for (const entry of await fs.readdir(workspace)) {
    if (entry !== 'node_modules') await fs.rm(path.join(workspace, entry), { recursive: true, force: true });
  }
  await fs.cp(input.directory, workspace, { recursive: true });
  return workspace;
}

/**
 * 仅对依赖声明、锁文件、安装配置、补丁和 Node/平台/pnpm 信息计算依赖指纹。
 * 与源码 revision 不同：改组件通常只需重建，改 package.json 等才需要重新安装。
 */
export async function dependencyRevision(directory) {
  const dependencies = await projectManifest(directory, '', (name) =>
    /(^|\/)(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|\.pnpmfile\.cjs)$/.test(name)
    || name.startsWith('patches/'));
  return manifestRevision([['runtime', `${process.version}:${process.platform}:${process.arch}:pnpm11`], ...dependencies]);
}

/** 读取缓存标记；文件不存在或 JSON 损坏视为未命中并返回 null，其他磁盘错误继续抛出。 */
export async function readCacheJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

/**
 * 保留当前产物及另一份最近产物，删除更旧的本地目录和标记，不删除 Cloudflare 部署。
 * currentRevision 在当前 pipeline 中传入 artifactRevision，包含构建策略与任务类型。
 */
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

/** 服务启动时清理中断任务遗留的输入副本；保留依赖和产物缓存，不负责重跑任务。 */
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
