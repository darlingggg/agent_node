import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setImmediate as tick } from 'node:timers/promises';

const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-build-tests-'));
process.env.BUILD_CACHE_ROOT = path.join(testRoot, 'cache');
const { captureProjectInput, projectCacheRoot } = await import('../node/exec/build/project-input.js');
const { createBuildPipeline } = await import('../node/exec/build/pipeline.js');
const { createBuildService } = await import('../node/exec/build/service.js');
const { buildEnvironment } = await import('../node/exec/build/environment.js');
const { execCommand } = await import('../node/exec/process-runner.js');
const { assertPreviewBranch } = await import('../node/exec/deploy/cloudflare.js');
const { artifactRevision, BUILD_PROFILE_VERSION } = await import('../node/exec/build/profile.js');
after(() => fs.rm(testRoot, { recursive: true, force: true }));

const success = { success: true, code: 0, stdout: '', stderr: '' };

async function fixture(name) {
  const root = path.join(testRoot, name);
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { build: 'vite build' }, dependencies: { vue: '3.5.35' } }));
  await fs.writeFile(path.join(root, 'index.html'), '<html><head></head><body>test</body></html>');
  await fs.writeFile(path.join(root, 'src/main.js'), 'version A');
  return root;
}

function runners(projectId = 1) {
  const counts = { install: 0, build: 0, upload: 0 };
  const api = {
    counts,
    validatePreviewBranch: async () => {},
    pnpm: async (args, cwd) => {
      if (args[0] === 'install') {
        counts.install++;
        await fs.mkdir(path.join(cwd, 'node_modules'), { recursive: true });
        return success;
      }
      counts.build++;
      const outDir = args[args.indexOf('--outDir') + 1];
      await fs.mkdir(outDir, { recursive: true });
      await fs.writeFile(path.join(outDir, 'index.html'), await fs.readFile(path.join(cwd, 'index.html')));
      await fs.writeFile(path.join(outDir, 'main.js'), await fs.readFile(path.join(cwd, 'src/main.js')));
      return success;
    },
    wrangler: async (args, cwd) => {
      counts.upload++;
      assert.ok(args.includes(`--branch=preview-p${projectId}`));
      assert.equal(await fs.stat(path.join(cwd, 'dist/index.html')).then((stat) => stat.isFile()), true);
      const html = await fs.readFile(path.join(cwd, 'dist/index.html'), 'utf8');
      assert.match(html, /agent-preview-ready/);
      const headers = await fs.readFile(path.join(cwd, 'dist/_headers'), 'utf8');
      assert.match(headers, /Cross-Origin-Embedder-Policy: credentialless/);
      return { ...success, stdout: 'Deployment complete! https://immutable.gen-agent.pages.dev' };
    },
  };
  return api;
}

test('source inputs are immutable, include binary assets, and skip dependency/build directories', async () => {
  const root = await fixture('input');
  await fs.mkdir(path.join(root, 'public'), { recursive: true });
  const binary = Buffer.from([0, 255, 31, 0, 128]);
  await fs.writeFile(path.join(root, 'public/model.glb'), binary);
  await fs.mkdir(path.join(root, 'node_modules'), { recursive: true });
  await fs.writeFile(path.join(root, 'node_modules/ignored.txt'), 'ignore');
  const input = await captureProjectInput(1, root);
  await fs.writeFile(path.join(root, 'src/main.js'), 'version B');
  assert.equal(await fs.readFile(path.join(input.directory, 'src/main.js'), 'utf8'), 'version A');
  assert.deepEqual(await fs.readFile(path.join(input.directory, 'public/model.glb')), binary);
  await assert.rejects(fs.access(path.join(input.directory, 'node_modules')));
  const changed = await captureProjectInput(1, root);
  assert.notEqual(input.revision, changed.revision);
  await input.dispose();
  await changed.dispose();
});

test('unchanged dependencies skip installation; a changed manifest invalidates the dependency cache', async () => {
  const root = await fixture('dependencies');
  const api = runners(2);
  const build = createBuildPipeline(api);
  const run = async () => {
    const input = await captureProjectInput(2, root);
    try { return await build({ projectId: 2, input, kind: 'preview', send: () => {} }); }
    finally { await input.dispose(); }
  };
  await run();
  await fs.writeFile(path.join(root, 'src/main.js'), 'version B');
  await run();
  assert.deepEqual(api.counts, { install: 1, build: 2, upload: 2 });
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  pkg.dependencies.vue = '3.5.34';
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify(pkg));
  await run();
  assert.deepEqual(api.counts, { install: 2, build: 3, upload: 3 });
  const artifacts = await fs.readdir(path.join(projectCacheRoot(2), 'artifacts'), { withFileTypes: true });
  assert.equal(artifacts.filter((entry) => entry.isDirectory()).length, 2);
});

test('upload retry reuses the compiled artifact even if node_modules no longer exists', async () => {
  const root = await fixture('upload-retry');
  const input = await captureProjectInput(3, root);
  const api = runners(3);
  let failUpload = true;
  const build = createBuildPipeline({ ...api, wrangler: async (...args) => {
    if (failUpload) { failUpload = false; return { ...success, success: false, stderr: 'network failed' }; }
    return api.wrangler(...args);
  } });
  const args = { projectId: 3, input, kind: 'preview', send: () => {} };
  await assert.rejects(build(args), /network failed/);
  const before = { ...api.counts };
  await fs.rm(path.join(projectCacheRoot(3), 'work/node_modules'), { recursive: true, force: true });
  const result = await build(args);
  assert.equal(result.link, 'https://immutable.gen-agent.pages.dev');
  assert.equal(api.counts.install, before.install);
  assert.equal(api.counts.build, before.build);
  await input.dispose();
});

function memoryStore() {
  const tasks = new Map();
  const list = (projectId, kind) => [...tasks.values()].filter((task) => task.projectId === projectId && task.kind === kind);
  return {
    tasks,
    save: async (task) => tasks.set(task.id, structuredClone(task)),
    latest: async (projectId, kind) => list(projectId, kind).sort((a, b) => b.requestedAt - a.requestedAt)[0] || null,
    ready: async (projectId, revision) => list(projectId, 'preview')
      .filter((task) => task.status === 'ready' && (!revision || task.revision === revision))
      .sort((a, b) => b.completedAt.localeCompare(a.completedAt) || b.requestedAt - a.requestedAt)[0] || null,
    recover: async () => {},
  };
}

test('service reuses successful links and keeps displayed/desired versions separate after later failures', async () => {
  const root = await fixture('service');
  const store = memoryStore();
  let builds = 0;
  let publishCount = 0;
  const service = createBuildService({ store, build: async ({ kind }) => {
    builds++;
    if (builds === 2) throw new Error('syntax error');
    assert.equal(kind, 'preview');
    return { link: 'https://old.gen-agent.pages.dev', completedAt: new Date().toISOString() };
  }, publish: async () => { publishCount++; } });
  const project = { id: 5, account: 'owner', dir_path: root };
  const first = await service.request(project, 'preview', {});
  await first.completion;
  for (let i = 0; i < 10 && service.scheduler.active; i++) await tick();
  assert.equal(await service.request(project, 'preview', {}), null);
  assert.equal(builds, 1);
  await fs.writeFile(path.join(root, 'src/main.js'), 'bad version');
  const second = await service.request(project, 'preview', {});
  await assert.rejects(second.completion, /syntax error/);
  const state = await service.previewState(project.id);
  assert.equal(state.latest.status, 'failed');
  assert.equal(state.lastReady.result.link, 'https://old.gen-agent.pages.dev');
  assert.notEqual(state.desiredRevision, state.lastReady.revision);
  assert.equal(publishCount, 0);
});

test('build environment strips business credentials and inherited executable NODE_OPTIONS', () => {
  const env = buildEnvironment({ PATH: 'runtime', HOME: 'profile', HTTPS_PROXY: 'proxy',
    CLOUDFLARE_API_TOKEN: 'secret', JWT_SECRET: 'secret', MYSQL_PASSWORD: 'secret',
    OPENAI_API_KEY: 'secret', NODE_OPTIONS: '--require untrusted.js', BUILD_MAX_OLD_SPACE_SIZE: '512' });
  assert.deepEqual(env, { PATH: 'runtime', HOME: 'profile', HTTPS_PROXY: 'proxy', NODE_OPTIONS: '--max-old-space-size=512',
    pnpm_config_verify_deps_before_run: 'false', RAYON_NUM_THREADS: '1', GOMAXPROCS: '1' });
});

test('failed source is not rebuilt on reopen, explicit retry and changed source can run', async () => {
  const root = await fixture('failure-guard');
  const store = memoryStore();
  let count = 0;
  const service = createBuildService({ store, build: async () => { count++; throw new Error('resource limit'); } });
  const project = { id: 18, account: 'owner', dir_path: root };
  const run = async (options) => {
    const job = await service.request(project, 'preview', {}, options);
    if (job) await assert.rejects(job.completion, /resource limit/);
    for (let i = 0; i < 100 && service.scheduler.active; i++) await tick();
    return job;
  };
  await run();
  assert.equal(await run(), null);
  assert.equal(count, 1);
  await run({ force: true });
  assert.equal(count, 2);
  await fs.writeFile(path.join(root, 'src/main.js'), 'changed');
  await run();
  assert.equal(count, 3);
  assert.equal((await store.latest(project.id, 'preview')).builderVersion, BUILD_PROFILE_VERSION);
});

test('preview and publish artifacts use distinct versioned keys', () => {
  const revision = 'a'.repeat(64);
  assert.match(artifactRevision(revision, 'preview'), /^[a-f0-9]{64}$/);
  assert.notEqual(artifactRevision(revision, 'preview'), artifactRevision(revision, 'publish'));
  assert.notEqual(artifactRevision(revision, 'preview'), revision);
});

test('admission includes projects still capturing input, before a sixth project reads files', async () => {
  let release;
  let captures = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const service = createBuildService({ store: memoryStore(),
    capture: async () => {
      captures++;
      await gate;
      return { revision: 'a'.repeat(64), dispose: async () => {} };
    },
    build: async () => ({ link: 'https://test.gen-agent.pages.dev' }),
  });
  const requests = Array.from({ length: 5 }, (_, id) =>
    service.request({ id: id + 1, account: 'owner', dir_path: '/unused' }, 'preview', {}));
  await assert.rejects(service.request({ id: 6, account: 'owner' }, 'preview', {}), /队列已满/);
  await tick();
  assert.equal(captures, 5);
  release();
  const jobs = await Promise.all(requests);
  await Promise.all(jobs.map((job) => job.completion));
});

test('real child-process timeout and cancellation both settle after termination', async () => {
  const timeout = await execCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], testRoot, { timeout: 100 });
  assert.equal(timeout.success, false);
  assert.equal(timeout.timedOut, true);
  const controller = new AbortController();
  const pending = execCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], testRoot,
    { timeout: 5000, signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  const result = await pending;
  assert.equal(result.success, false);
  assert.equal(result.code, 'ABORT_ERR');
});

test('the preview execution deadline reaches child processes', async () => {
  const root = await fixture('deadline');
  const input = await captureProjectInput(9, root);
  const build = createBuildPipeline({ previewTimeout: 150,
    validatePreviewBranch: async () => {},
    pnpm: (_args, cwd, timeout, options) => execCommand(process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'], cwd, { ...options, timeout }),
    wrangler: async () => assert.fail('must not upload after timeout'),
  });
  await assert.rejects(build({ projectId: 9, input, kind: 'preview', send: () => {} }));
  await input.dispose();
});

test('preview deployments reject production branch collisions and unreadable project metadata', async () => {
  const metadata = (productionBranch) => async () => ({ ok: true,
    json: async () => ({ success: true, result: { production_branch: productionBranch } }) });
  await assertPreviewBranch('preview-p1', { fetcher: metadata('main') });
  await assert.rejects(assertPreviewBranch('preview-p1', { fetcher: metadata('preview-p1') }), /生产分支冲突/);
  await assert.rejects(assertPreviewBranch('preview-p1', { fetcher: async () => ({ ok: false }) }), /凭据或网络/);
});
