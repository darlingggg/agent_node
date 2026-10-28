import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

test('real Vite builds for tool, 2D and 3D templates using existing dependency caches',
  { skip: process.env.BUILD_TEMPLATE_TEST !== '1' }, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-template-builds-'));
    process.env.BUILD_CACHE_ROOT = path.join(root, 'cache');
    const { captureProjectInput, projectCacheRoot, prepareWorkspace, dependencyRevision } =
      await import('../node/exec/build/project-input.js');
    const { createBuildPipeline } = await import('../node/exec/build/pipeline.js');
    try {
      for (const [index, name] of ['projectTemp', 'gameTemp2d', 'gameTemp3d'].entries()) {
        const projectId = 100 + index;
        const template = fileURLToPath(new URL(`../../gameAgent/src/a_template/${name}/`, import.meta.url));
        const input = await captureProjectInput(projectId, template);
        const workspace = await prepareWorkspace(projectId, input);
        await fs.symlink(path.join(template, 'node_modules'), path.join(workspace, 'node_modules'), 'junction');
        await fs.writeFile(path.join(projectCacheRoot(projectId), 'dependencies.json'),
          JSON.stringify({ revision: await dependencyRevision(input.directory) }));
        let uploads = 0;
        const build = createBuildPipeline({ validatePreviewBranch: async () => {}, wrangler: async (args, cwd) => {
          if (args[1] === 'deployment') return { success: true, code: 0, stdout: '[]', stderr: '' };
          uploads++;
          const html = await fs.readFile(path.join(cwd, 'dist/index.html'), 'utf8');
          if (args.includes(`--branch=preview-p${projectId}`)) assert.match(html, /agent-preview-ready/);
          assert.match(html, /assets\//);
          return { success: true, code: 0, stdout: `https://template-${index}.gen-agent.pages.dev`, stderr: '' };
        } });
        const result = await build({ projectId, input, kind: 'preview', send: () => {} });
        assert.equal(uploads, 1);
        console.log(`${name} preview: ${result.durationText} (${result.distPath})`);
        const published = await build({ projectId, input, kind: 'publish', send: () => {} });
        assert.equal(uploads, 2);
        assert.notEqual(result.distPath, published.distPath);
        console.log(`${name} publish: ${published.durationText}`);
        await input.dispose();
      }
    } finally {
      if (process.env.BUILD_KEEP_ARTIFACTS === '1') console.log(`Retained artifacts: ${root}`);
      else await fs.rm(root, { recursive: true, force: true });
    }
  });
