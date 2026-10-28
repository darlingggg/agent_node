import fs from 'node:fs/promises';
import path from 'node:path';
import { runPnpm, runWrangler, INSTALL_TIMEOUT_MS, BUILD_TIMEOUT_MS, DEPLOY_TIMEOUT_MS } from '../process-runner.js';
import { CF_PROJECT_NAME, assertPreviewBranch, extractDeployUrl, extractDeploymentIdByLink } from '../deploy/cloudflare.js';
import { runBuildStep, formatDuration } from './build-step.js';
import { dependencyRevision, prepareWorkspace, projectCacheRoot, pruneBuildArtifacts, readCacheJson } from './project-input.js';
import { artifactRevision, writeBuildConfig } from './profile.js';

const INSTALL_ARGS = ['install', '--no-frozen-lockfile', '--prefer-offline', '--child-concurrency=1',
  '--network-concurrency=4', '--config.optional=true', '--config.confirmModulesPurge=false'];
const PREVIEW_HEADERS = '\n/*\n  Cross-Origin-Embedder-Policy: credentialless\n  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Resource-Policy: cross-origin\n';

export function createBuildPipeline({ pnpm = runPnpm, wrangler = runWrangler,
  validatePreviewBranch = assertPreviewBranch, previewTimeout = 300_000 } = {}) {
  return async function build({ projectId, input, kind, send }) {
    const started = Date.now();
    const deadline = started + (kind === 'preview' ? previewTimeout : INSTALL_TIMEOUT_MS + BUILD_TIMEOUT_MS + DEPLOY_TIMEOUT_MS);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deadline - started);
    timer.unref?.();
    const steps = [];
    const remaining = (limit) => {
      controller.signal.throwIfAborted();
      return Math.max(1, Math.min(limit, deadline - Date.now()));
    };
    const step = async (key, title, execute) => {
      const result = await runBuildStep({ key, title, command: title, execute, send });
      steps.push(result.step);
      return result;
    };

    try {
      const root = projectCacheRoot(projectId);
      const commandOptions = (stage) => ({ signal: controller.signal, stage, auditDirectory: root });
      send({ event: 'step', data: { key: 'prepare', title: '准备构建', status: 'running', message: '正在准备独立构建目录' } });
      if (kind === 'preview') {
        await validatePreviewBranch(`preview-p${projectId}`, { signal: controller.signal });
      }
      const artifacts = path.join(root, 'artifacts');
      const artifact = artifactRevision(input.revision, kind);
      const distPath = path.join(artifacts, artifact);
      const buildMarker = path.join(artifacts, `${artifact}.json`);
      const cachedBuild = await readCacheJson(buildMarker);
      const hasIndex = await fs.stat(path.join(distPath, 'index.html')).then((stat) => stat.isFile(), () => false);
      if (!cachedBuild || !hasIndex) {
        const workspace = await prepareWorkspace(projectId, input);
        const dependencies = await dependencyRevision(input.directory);
        const dependencyFile = path.join(root, 'dependencies.json');
        const installed = await readCacheJson(dependencyFile);
        const hasModules = await fs.stat(path.join(workspace, 'node_modules')).then((stat) => stat.isDirectory(), () => false);
        if (installed?.revision !== dependencies || !hasModules) {
          await fs.rm(dependencyFile, { force: true });
          await step('install', '安装依赖', () => pnpm(INSTALL_ARGS, workspace,
            remaining(INSTALL_TIMEOUT_MS), commandOptions('install')));
          await fs.writeFile(dependencyFile, JSON.stringify({ revision: dependencies }));
        } else {
          send({ event: 'step', data: { key: 'install', title: '安装依赖', status: 'done', message: '依赖未变化，复用已安装依赖' } });
        }
        await fs.rm(distPath, { recursive: true, force: true });
        await fs.mkdir(artifacts, { recursive: true });
        const config = await writeBuildConfig(workspace, kind);
        await step('build', '构建项目', () => pnpm(['run', 'build', '--config', config, '--outDir', distPath], workspace,
          remaining(BUILD_TIMEOUT_MS), commandOptions('build')));
        await fs.access(path.join(distPath, 'index.html'));
        for (const name of ['_worker.js', 'functions']) {
          const exists = await fs.stat(path.join(distPath, name)).then(() => true, () => false);
          if (exists) throw new Error('临时预览和静态发布不支持 Pages Functions 或 _worker.js');
        }
        await fs.writeFile(buildMarker, JSON.stringify({ revision: input.revision }));
      } else {
        send({ event: 'step', data: { key: 'install', title: '安装依赖', status: 'done', message: '已有构建产物，无需安装依赖' } });
        send({ event: 'step', data: { key: 'build', title: '构建项目', status: 'done', message: '复用成功构建产物' } });
      }
      await pruneBuildArtifacts(projectId, artifact);

      // 从受控的独立目录上传，避免读取生成项目中的部署配置和云函数。
      const uploadDirectory = path.join(root, 'upload');
      await fs.mkdir(uploadDirectory, { recursive: true });
      const uploadPath = path.join(uploadDirectory, 'dist');
      await fs.rm(uploadPath, { recursive: true, force: true });
      await fs.cp(distPath, uploadPath, { recursive: true, dereference: false });
      if (kind === 'preview') {
        const headersPath = path.join(uploadPath, '_headers');
        const headers = await fs.readFile(headersPath, 'utf8').catch((error) => {
          if (error.code === 'ENOENT') return '';
          throw error;
        });
        const cleaned = headers.replace(/^\s*Cross-Origin-(?:Embedder|Opener|Resource)-Policy:.*$/gim, '');
        await fs.writeFile(headersPath, cleaned + PREVIEW_HEADERS);
        const indexPath = path.join(uploadPath, 'index.html');
        const html = await fs.readFile(indexPath, 'utf8');
        const readyScript = `<script>window.addEventListener('load',function(){parent.postMessage({type:'agent-preview-ready',revision:'${input.revision}'},'*')})</script>`;
        const document = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${readyScript}</head>`) : html + readyScript;
        await fs.writeFile(indexPath, document);
      }
      const args = ['pages', 'deploy', uploadPath, `--project-name=${CF_PROJECT_NAME}`];
      if (kind === 'preview') args.push(`--branch=preview-p${projectId}`);
      const deployed = await step('deploy', kind === 'preview' ? '上传预览' : '部署上线', () =>
        wrangler(args, uploadDirectory, remaining(DEPLOY_TIMEOUT_MS), commandOptions('deploy')));
      const link = extractDeployUrl(deployed.stdout);
      if (!link) throw new Error('部署未返回有效访问链接，请重试');
      let deploymentId = null;
      if (kind === 'publish') {
        const listed = await wrangler(['pages', 'deployment', 'list', `--project-name=${CF_PROJECT_NAME}`, '--json'],
          uploadDirectory, remaining(60_000), commandOptions('deployment-list'));
        if (listed.success) deploymentId = extractDeploymentIdByLink(listed.stdout, link);
      }
      const duration = Date.now() - started;
      return { success: true, code: 0, link, deploymentId, revision: input.revision,
        projectName: CF_PROJECT_NAME, distPath, duration, durationText: formatDuration(duration),
        completedAt: new Date().toISOString(), steps,
        summary: kind === 'preview' ? '兼容预览已更新' : '部署成功，项目已上线',
        deploy: { url: link, deploymentId, projectName: CF_PROJECT_NAME } };
    } finally {
      clearTimeout(timer);
    }
  };
}

export const runProjectBuild = createBuildPipeline();
