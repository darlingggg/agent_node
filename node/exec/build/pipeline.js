import fs from 'node:fs/promises';
import path from 'node:path';
import { runPnpm, runWrangler, INSTALL_TIMEOUT_MS, BUILD_TIMEOUT_MS, DEPLOY_TIMEOUT_MS } from '../process-runner.js';
import { CF_PROJECT_NAME, assertPreviewBranch, extractDeployUrl, extractDeploymentIdByLink } from '../deploy/cloudflare.js';
import { dependencyRevision, prepareWorkspace, projectCacheRoot, pruneBuildArtifacts, readCacheJson,
  artifactRevision, writeBuildConfig } from './project-input.js';

const INSTALL_ARGS = ['install', '--no-frozen-lockfile', '--prefer-offline', '--child-concurrency=1',
  '--network-concurrency=4', '--config.optional=true', '--config.confirmModulesPurge=false'];
const PREVIEW_HEADERS = '\n/*\n  Cross-Origin-Embedder-Policy: credentialless\n  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Resource-Policy: cross-origin\n';

/**
 * 安装、构建、上传的顺序执行器，由 ProjectBuildService.executeBuild 调用。
 * 每次 build 使用独立 context 保存期限/路径/步骤；进度直接调用 scheduler.reportProgress。
 * 只执行工作并返回结果，排队、状态持久化和源码清理由 scheduler 负责。
 */
export class BuildPipeline {
  /** 生产命令在 process-runner.js 实现；测试可替换命令和分支查询，避免真实部署。 */
  constructor({ commands = {}, previewBranchCheck = assertPreviewBranch, previewTimeout = 300_000 } = {}) {
    this.commands = { runPnpm, runWrangler, ...commands };
    this.previewBranchCheck = previewBranchCheck;
    this.previewTimeout = previewTimeout;
  }

  /**
   * 完整执行入口：校验分支 -> 准备产物 -> 准备上传副本 -> 部署 -> 返回含 link 的结果。
   * job.source 是固定源码副本。预览共用 300 秒期限，不含此前的源码复制和排队。
   * 任一步骤失败直接抛错，由 scheduler.execute 统一保存失败状态。
   * @param {import('./scheduler.js').BuildJob} job
   * @param {import('./scheduler.js').BuildScheduler} scheduler
   */
  async build(job, scheduler) {
    const started = Date.now();
    const timeout = job.kind === 'preview'
      ? this.previewTimeout
      : INSTALL_TIMEOUT_MS + BUILD_TIMEOUT_MS + DEPLOY_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    timer.unref?.();
    try {
      const context = {
        job, scheduler, deadline: started + timeout,
        signal: controller.signal, steps: [], root: projectCacheRoot(job.projectId),
      };
      scheduler.reportProgress(job, {
        event: 'step', data: { key: 'prepare', title: '准备构建', status: 'running', message: '正在准备独立构建目录' },
      });
      if (job.kind === 'preview') {
        await this.previewBranchCheck(`preview-p${job.projectId}`, { signal: context.signal });
      }

      // 产物缓存同时区分源码、预览/发布类型和构建策略。
      context.artifact = artifactRevision(job.source.revision, job.kind);
      context.artifacts = path.join(context.root, 'artifacts');
      context.distPath = path.join(context.artifacts, context.artifact);

      await this.prepareArtifacts(context);
      await pruneBuildArtifacts(job.projectId, context.artifact);
      const upload = await this.prepareUpload(context);
      const { link, deploymentId } = await this.deploy(context, upload);

      const duration = Date.now() - started;
      return {
        success: true, code: 0, link, deploymentId, revision: job.source.revision,
        projectName: CF_PROJECT_NAME, distPath: context.distPath,
        duration, durationText: formatDuration(duration),
        completedAt: new Date().toISOString(), steps: context.steps,
        summary: job.kind === 'preview' ? '兼容预览已更新' : '部署成功，项目已上线',
        deploy: { url: link, deploymentId, projectName: CF_PROJECT_NAME },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 优先复用构建产物；未命中时准备 work 目录，按依赖指纹决定是否安装，再构建静态页面。
   * 产物检查通过后才写缓存标记，因此上传失败仍可复用本次构建；原项目目录不被修改。
   */
  async prepareArtifacts(context) {
    const { job, scheduler, root, artifact, artifacts, distPath } = context;
    const marker = path.join(artifacts, `${artifact}.json`);
    const cached = await readCacheJson(marker);
    const hasIndex = await fs.stat(path.join(distPath, 'index.html')).then((stat) => stat.isFile(), () => false);
    if (cached && hasIndex) {
      scheduler.reportProgress(job, {
        event: 'step', data: { key: 'install', title: '安装依赖', status: 'done', message: '已有构建产物，无需安装依赖' },
      });
      scheduler.reportProgress(job, {
        event: 'step', data: { key: 'build', title: '构建项目', status: 'done', message: '复用成功构建产物' },
      });
      return;
    }

    const workspace = await prepareWorkspace(job.projectId, job.source);
    const dependencies = await dependencyRevision(job.source.directory);
    const dependencyFile = path.join(root, 'dependencies.json');
    const installed = await readCacheJson(dependencyFile);
    const hasModules = await fs.stat(path.join(workspace, 'node_modules')).then((stat) => stat.isDirectory(), () => false);
    if (installed?.revision !== dependencies || !hasModules) {
      await fs.rm(dependencyFile, { force: true });
      await this.runCommand(context, {
        key: 'install', title: '安装依赖', args: INSTALL_ARGS, directory: workspace, timeout: INSTALL_TIMEOUT_MS,
      });
      await fs.writeFile(dependencyFile, JSON.stringify({ revision: dependencies }));
    } else {
      scheduler.reportProgress(job, {
        event: 'step', data: { key: 'install', title: '安装依赖', status: 'done', message: '依赖未变化，复用已安装依赖' },
      });
    }

    await fs.rm(distPath, { recursive: true, force: true });
    await fs.mkdir(artifacts, { recursive: true });
    const config = await writeBuildConfig(workspace, job.kind);
    await this.runCommand(context, {
      key: 'build', title: '构建项目',
      args: ['run', 'build', '--config', config, '--outDir', distPath],
      directory: workspace, timeout: BUILD_TIMEOUT_MS,
    });
    await fs.access(path.join(distPath, 'index.html'));
    for (const name of ['_worker.js', 'functions']) {
      const exists = await fs.stat(path.join(distPath, name)).then(() => true, () => false);
      if (exists) throw new Error('临时预览和静态发布不支持 Pages Functions 或 _worker.js');
    }
    await fs.writeFile(marker, JSON.stringify({ revision: job.source.revision }));
  }

  /**
   * 从缓存复制到独立 upload/dist，隔离生成项目中的 Wrangler 配置和云函数。
   * 仅预览副本附加跨域响应头和加载确认脚本，缓存产物保持原样；返回上传工作目录和路径。
   */
  async prepareUpload(context) {
    const { job, root, distPath } = context;
    const directory = path.join(root, 'upload');
    const dist = path.join(directory, 'dist');
    await fs.mkdir(directory, { recursive: true });
    await fs.rm(dist, { recursive: true, force: true });
    await fs.cp(distPath, dist, { recursive: true, dereference: false });
    if (job.kind === 'preview') {
      const headersPath = path.join(dist, '_headers');
      const headers = await fs.readFile(headersPath, 'utf8').catch((error) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      });
      const cleaned = headers.replace(/^\s*Cross-Origin-(?:Embedder|Opener|Resource)-Policy:.*$/gim, '');
      await fs.writeFile(headersPath, cleaned + PREVIEW_HEADERS);
      const indexPath = path.join(dist, 'index.html');
      const html = await fs.readFile(indexPath, 'utf8');
      const readyScript = `<script>window.addEventListener('load',function(){parent.postMessage({type:'agent-preview-ready',revision:'${job.source.revision}'},'*')})</script>`;
      const document = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${readyScript}</head>`) : html + readyScript;
      await fs.writeFile(indexPath, document);
    }
    return { directory, dist };
  }

  /**
   * 上传 Pages 并从 Wrangler stdout 提取访问链接；没有链接视为失败。
   * 预览使用 preview-p<项目ID> 分支；正式发布另外查询 deploymentId，供发布记录及清理使用。
   */
  async deploy(context, upload) {
    const { job } = context;
    const args = ['pages', 'deploy', upload.dist, `--project-name=${CF_PROJECT_NAME}`];
    if (job.kind === 'preview') args.push(`--branch=preview-p${job.projectId}`);
    const deployed = await this.runCommand(context, {
      key: 'deploy', title: job.kind === 'preview' ? '上传预览' : '部署上线',
      args, directory: upload.directory, timeout: DEPLOY_TIMEOUT_MS,
    });
    const link = extractDeployUrl(deployed.stdout);
    if (!link) throw new Error('部署未返回有效访问链接，请重试');

    let deploymentId = null;
    if (job.kind === 'publish') {
      const listed = await this.commands.runWrangler(
        ['pages', 'deployment', 'list', `--project-name=${CF_PROJECT_NAME}`, '--json'],
        upload.directory, this.remainingTime(context, 60_000),
        { signal: context.signal, stage: 'deployment-list', auditDirectory: context.root },
      );
      if (listed.success) deploymentId = extractDeploymentIdByLink(listed.stdout, link);
    }
    return { link, deploymentId };
  }

  /**
   * 直接执行安装/构建的 pnpm 或部署的 Wrangler，同时报告阶段、耗时和日志。
   * 不接收“下一步”回调；命令失败在此转成异常，调用方的 await 自然停止后续步骤。
   * 成功步骤追加到 context.steps，返回原命令结果供部署步骤读取 stdout。
   */
  async runCommand(context, { key, title, args, directory, timeout }) {
    const { job, scheduler } = context;
    const startedAt = Date.now();
    const command = title;
    scheduler.reportProgress(job, {
      event: 'step', data: { key, title, status: 'running', command, message: `正在${title}...` },
    });
    scheduler.reportProgress(job, { event: 'text', data: `▶ ${title}：正在执行 ${command}` });
    const remaining = this.remainingTime(context, timeout);
    const options = { signal: context.signal, stage: key, auditDirectory: context.root };
    const result = key === 'deploy'
      ? await this.commands.runWrangler(args, directory, remaining, options)
      : await this.commands.runPnpm(args, directory, remaining, options);
    const duration = Date.now() - startedAt;
    const durationText = formatDuration(duration);
    if (!result.success) {
      const errorMessage = result.timedOut
        ? `${title}执行超时，已终止相关子进程`
        : result.stderr || result.stdout || '未知错误';
      scheduler.reportProgress(job, {
        event: 'step',
        data: {
          key, title, status: 'error', command, duration, durationText,
          message: `${title}失败`, error: trimOutput(errorMessage, 1000),
          code: result.code, signal: result.signal, resources: result.resources,
        },
      });
      scheduler.reportProgress(job, {
        event: 'text', data: `✗ ${title}失败（${durationText}）\n${trimOutput(errorMessage, 500)}`,
      });
      throw new Error(`【${title}】失败: ${errorMessage}`);
    }

    const step = {
      key, title, status: 'done', command, duration, durationText,
      message: `${title}完成`, stdout: trimOutput(result.stdout), stderr: trimOutput(result.stderr),
      resources: result.resources,
    };
    scheduler.reportProgress(job, { event: 'step', data: step });
    scheduler.reportProgress(job, { event: 'text', data: `✓ ${title}完成（耗时 ${durationText}）` });
    context.steps.push(step);
    return result;
  }

  /** 每条命令只获得自身上限与总期限剩余时间的较小值；总期限已取消则直接抛错。 */
  remainingTime(context, limit) {
    context.signal.throwIfAborted();
    return Math.max(1, Math.min(limit, context.deadline - Date.now()));
  }
}

/** 将毫秒转为日志和接口使用的耗时文本。 */
function formatDuration(milliseconds) {
  if (milliseconds < 1000) return `${milliseconds}ms`;
  if (milliseconds < 60000) return `${(milliseconds / 1000).toFixed(1)}s`;
  return `${Math.floor(milliseconds / 60000)}m${Math.round((milliseconds % 60000) / 1000)}s`;
}

/** 限制写入任务结果和事件的日志长度，保留尾部错误信息。 */
function trimOutput(text, maxLength = 2000) {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return `...(省略 ${text.length - maxLength} 字符)\n${text.slice(-maxLength)}`;
}
