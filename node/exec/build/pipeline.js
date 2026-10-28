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

/**
 * 创建构建执行函数；由 service 登记为 job.run 的工作，scheduler 决定执行时机。
 * pnpm/wrangler/分支检查可替换为测试实现；此层负责步骤顺序、缓存和总期限，不管理排队。
 */
export function createBuildPipeline({ pnpm = runPnpm, wrangler = runWrangler,
  validatePreviewBranch = assertPreviewBranch, previewTimeout = 300_000 } = {}) {
  /**
   * input 是已固定的源码副本，kind 区分 preview/publish，send 将进度回传调度器。
   * 成功返回含 link、revision、steps 的结果；失败抛错，由 scheduler 统一标记任务失败。
   * 预览默认总期限为 5 分钟，从本函数开始计时，不含此前的源码复制和排队。
   */
  return async function build({ projectId, input, kind, send }) {
    const started = Date.now();
    const deadline = started + (kind === 'preview' ? previewTimeout : INSTALL_TIMEOUT_MS + BUILD_TIMEOUT_MS + DEPLOY_TIMEOUT_MS);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deadline - started);
    timer.unref?.();
    const steps = [];
    // 单步骤最多使用自身上限与总期限剩余时间的较小值，不能每个步骤重新获得完整预算。
    const remaining = (limit) => {
      controller.signal.throwIfAborted();
      return Math.max(1, Math.min(limit, deadline - Date.now()));
    };
    // execute 是延迟执行的命令回调；统一发送阶段事件，并把步骤结果收集进最终结果。
    const step = async (key, title, execute) => {
      const result = await runBuildStep({ key, title, command: title, execute, send });
      steps.push(result.step);
      return result;
    };

    try {
      const root = projectCacheRoot(projectId);
      // 命令共用取消信号，stage 和 auditDirectory 用于资源统计及执行诊断日志。
      const commandOptions = (stage) => ({ signal: controller.signal, stage, auditDirectory: root });
      send({ event: 'step', data: { key: 'prepare', title: '准备构建', status: 'running', message: '正在准备独立构建目录' } });
      if (kind === 'preview') {
        await validatePreviewBranch(`preview-p${projectId}`, { signal: controller.signal });
      }
      const artifacts = path.join(root, 'artifacts');
      // 源码版本不等于产物版本：预览/发布配置以及构建策略版本也参与缓存键。
      const artifact = artifactRevision(input.revision, kind);
      const distPath = path.join(artifacts, artifact);
      const buildMarker = path.join(artifacts, `${artifact}.json`);
      const cachedBuild = await readCacheJson(buildMarker);
      const hasIndex = await fs.stat(path.join(distPath, 'index.html')).then((stat) => stat.isFile(), () => false);
      // 产物命中时可直接上传，即使 node_modules 已被删除，也不必重装或重新构建。
      if (!cachedBuild || !hasIndex) {
        const workspace = await prepareWorkspace(projectId, input);
        const dependencies = await dependencyRevision(input.directory);
        const dependencyFile = path.join(root, 'dependencies.json');
        const installed = await readCacheJson(dependencyFile);
        const hasModules = await fs.stat(path.join(workspace, 'node_modules')).then((stat) => stat.isDirectory(), () => false);
        // 只有依赖指纹匹配且依赖目录存在，才允许跳过安装。
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
        // 生成合并原项目配置的 Vite 配置；预览关闭压缩以降低构建开销。
        const config = await writeBuildConfig(workspace, kind);
        await step('build', '构建项目', () => pnpm(['run', 'build', '--config', config, '--outDir', distPath], workspace,
          remaining(BUILD_TIMEOUT_MS), commandOptions('build')));
        await fs.access(path.join(distPath, 'index.html'));
        for (const name of ['_worker.js', 'functions']) {
          const exists = await fs.stat(path.join(distPath, name)).then(() => true, () => false);
          if (exists) throw new Error('临时预览和静态发布不支持 Pages Functions 或 _worker.js');
        }
        // 标记只在构建和静态产物检查通过后写入；上传失败仍可复用这些产物重试。
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
        // 只修改上传副本，保留原始缓存产物；响应头用于跨域嵌入兼容。
        const headersPath = path.join(uploadPath, '_headers');
        const headers = await fs.readFile(headersPath, 'utf8').catch((error) => {
          if (error.code === 'ENOENT') return '';
          throw error;
        });
        const cleaned = headers.replace(/^\s*Cross-Origin-(?:Embedder|Opener|Resource)-Policy:.*$/gim, '');
        await fs.writeFile(headersPath, cleaned + PREVIEW_HEADERS);
        const indexPath = path.join(uploadPath, 'index.html');
        const html = await fs.readFile(indexPath, 'utf8');
        // 与前端 handleReady 配合：页面 load 后回报源码版本，结束 waitForFrame 的等待。
        const readyScript = `<script>window.addEventListener('load',function(){parent.postMessage({type:'agent-preview-ready',revision:'${input.revision}'},'*')})</script>`;
        const document = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${readyScript}</head>`) : html + readyScript;
        await fs.writeFile(indexPath, document);
      }
      const args = ['pages', 'deploy', uploadPath, `--project-name=${CF_PROJECT_NAME}`];
      // 临时预览使用项目专属分支；正式发布不附加该参数。
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

// 生产环境共享的构建函数，service 默认使用它；不会在模块加载时立即执行构建。
export const runProjectBuild = createBuildPipeline();
