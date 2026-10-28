import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// 构建策略变化时更新此值，使产物缓存与相同源码失败抑制能够区分新旧策略。
export const BUILD_PROFILE_VERSION = 'bounded-build-v1';

/** 源码版本 + 任务类型 + 构建策略生成产物缓存键，避免预览未压缩产物与正式产物混用。 */
export function artifactRevision(revision, kind) {
  return createHash('sha256').update(`${BUILD_PROFILE_VERSION}:${kind}:${revision}`).digest('hex');
}

/**
 * 在 work/.agent-build 中生成 Vite 配置并返回文件路径，供 pipeline 的 --config 使用。
 * 运行时读取原项目配置并合并，保留插件/别名；关闭 sourcemap 和压缩体积统计。
 * preview 额外关闭 JS/CSS 压缩，publish 保留原压缩设置；不修改原项目配置文件。
 */
export async function writeBuildConfig(workspace, kind) {
  const directory = path.join(workspace, '.agent-build');
  await fs.mkdir(directory, { recursive: true });
  const target = path.join(directory, 'vite.config.mjs');
  const overrides = { build: { sourcemap: false, reportCompressedSize: false,
    ...(kind === 'preview' ? { minify: false, cssMinify: false } : {}) } };
  await fs.writeFile(target, `import { loadConfigFromFile, mergeConfig } from 'vite';\n`
    + `export default async (env) => {\n`
    + `  const original = await loadConfigFromFile(env, undefined, ${JSON.stringify(workspace)});\n`
    + `  return mergeConfig(original?.config || {}, ${JSON.stringify(overrides)});\n};\n`);
  return target;
}
