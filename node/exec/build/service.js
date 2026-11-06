import { BuildScheduler } from './scheduler.js';
import { buildTaskStore } from './task-store.js';
import { captureProjectInput, removeProjectInput, BUILD_PROFILE_VERSION } from './project-input.js';
import { BuildPipeline } from './pipeline.js';
import { addSnapshot } from '../../snapshot.js';
import { buildProject, getProjectInfo } from '../../project.js';
import { markUserActive } from '../../utils/activity.js';
import { deleteOnlineVersion } from '../deploy/deployment.js';

/**
 * 预览/发布的业务入口。
 * 提交：路由 -> request -> prepareRequest -> scheduler.submit（只等待入队）。
 * 执行：scheduler.execute -> executeBuild -> pipeline.build -> finalizePublication。
 * 查询：previewState 合并内存队列与数据库历史，返回前端轮询需要的状态。
 */
export class ProjectBuildService {
  /** 默认使用真实数据库和构建器；测试仅在这两个外部依赖边界替换实现。 */
  constructor({ store = buildTaskStore, pipeline = new BuildPipeline() } = {}) {
    this.store = store;
    this.pipeline = pipeline;
    this.scheduler = new BuildScheduler({ store, service: this });
    // 同项目的源码准备和提交串行化；准备中的项目也占用接单容量。
    this.projectRequests = new Map();
  }

  /**
   * 提交已通过归属校验的项目。返回 BuildJob；复用成功链接或抑制失败重试时返回 null。
   * 此处只等待复制源码、检查缓存和入队；构建结果由 job.completion 或 GET 查询取得。
   */
  async request(project, kind, user, { force = false } = {}) {
    this.scheduler.assertCapacity(project.id, this.projectRequests.keys());
    const previous = this.projectRequests.get(project.id) || Promise.resolve();
    const pending = this.prepareRequest(previous, project, kind, user, force);
    // 当前请求的错误返回给调用者，但不能阻断同项目后续提交。
    const settled = pending.catch(() => {});
    this.projectRequests.set(project.id, settled);
    try {
      return await pending;
    } finally {
      if (this.projectRequests.get(project.id) === settled) this.projectRequests.delete(project.id);
    }
  }

  /**
   * 等前一次提交准备结束，固定本次源码，然后决定复用、跳过或入队。
   * source 是 { directory, revision }；入队后由 scheduler 负责删除这份源码副本。
   */
  async prepareRequest(previous, project, kind, user, force) {
    await previous;
    const existing = this.scheduler.find(project.id, kind)[0];
    if (kind === 'publish' && existing) return existing;

    const source = await this.captureSource(project);
    let scheduled = false;
    try {
      const latest = await this.store.latest(project.id, kind);
      this.scheduler.nextRequest(latest?.requestedAt || 0);
      if (kind === 'preview') {
        const cached = await this.store.ready(project.id, source.revision);
        if (cached) {
          await this.scheduler.cancelQueued(project.id, kind);
          await this.store.save({ ...cached, requestedAt: this.scheduler.nextRequest() });
          return null;
        }
        if (!force && latest?.status === 'failed' && latest.revision === source.revision
          && latest.builderVersion === BUILD_PROFILE_VERSION) return null;
      }

      // 任务仅携带数据；统一由本类 executeBuild 执行，不再为每次提交创建 run 闭包。
      const job = await this.scheduler.submit({
        projectId: project.id,
        account: project.account,
        kind,
        builderVersion: BUILD_PROFILE_VERSION,
        revision: source.revision,
        project,
        user,
        source,
      });
      scheduled = true;
      return job;
    } finally {
      if (!scheduled) await removeProjectInput(source);
    }
  }

  /** 从数据库确认的项目目录固定源码；后续编辑不会改变本次任务的输入。 */
  captureSource(project) {
    return captureProjectInput(project.id, project.dir_path);
  }

  /**
   * 由 scheduler.execute 在取得执行槽后调用。返回含 link 的构建结果。
   * 正式发布必须完成快照和发布记录保存才返回；兼容预览直接返回部署结果。
   */
  async executeBuild(job) {
    const result = await this.pipeline.build(job, this.scheduler);
    if (job.kind === 'publish') await this.finalizePublication(job, result);
    return result;
  }

  /**
   * 部署成功后的正式发布收尾：从任务源码副本生成快照、更新正式链接、清理旧部署。
   * 仍占用构建执行槽；保存失败会交给 scheduler 标为失败，预览不会调用本方法。
   */
  async finalizePublication(job, result) {
    const { project, user, source } = job;
    const current = await getProjectInfo(project.id, user);
    this.scheduler.reportProgress(job, {
      event: 'step', data: { key: 'save', title: '保存发布记录', status: 'running' },
    });
    const version = `构建${job.id}`;
    const { id } = await addSnapshot(project.id, version, project.dir_path, '', user, 0,
      project.temp_version, source.directory);
    await buildProject(project.id, result.link, id, result.deploymentId);
    await markUserActive(user.id);
    this.scheduler.reportProgress(job, {
      event: 'step', data: { key: 'save', title: '保存发布记录', status: 'done' },
    });
    if (current.cloudflare_id) {
      await deleteOnlineVersion(project.dir_path, current.cloudflare_id).catch((error) =>
        console.warn('[build] 清理旧部署失败:', error.message));
    }
  }

  /**
   * GET/POST 共用的状态查询，不创建任务。active/pending 来自内存，latest/lastReady 来自数据库。
   * lastReady 优先匹配目标版本，否则保留最近成功页面；新版本失败时仍可展示旧链接。
   */
  async previewState(projectId) {
    const latest = await this.store.latest(projectId, 'preview');
    const live = this.scheduler.find(projectId, 'preview');
    const matching = latest ? await this.store.ready(projectId, latest.revision) : null;
    const ready = matching || await this.store.ready(projectId);
    return {
      desiredRevision: latest?.revision || '',
      active: this.scheduler.view(live.find((task) => task.status === 'running')),
      pending: this.scheduler.view(live.find((task) => task.status === 'queued')),
      lastReady: ready,
      latest,
    };
  }

  /** 服务重启时将遗留任务标为失败；保留成功记录，不自动恢复执行或重复发布。 */
  recover() {
    return this.store.recover();
  }
}

// 路由直接导入此实例。整个进程共用一个调度器，预览与发布合计只有一个构建执行槽。
export const projectBuilds = new ProjectBuildService();
