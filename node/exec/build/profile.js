import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const BUILD_PROFILE_VERSION = 'bounded-build-v1';

export function artifactRevision(revision, kind) {
  return createHash('sha256').update(`${BUILD_PROFILE_VERSION}:${kind}:${revision}`).digest('hex');
}

/** 保留项目插件、别名和全部依赖，仅覆盖构建开销相关设置。 */
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
