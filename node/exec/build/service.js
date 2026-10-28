import { BuildScheduler } from './scheduler.js';
import { buildTaskStore } from './task-store.js';
import { captureProjectInput } from './project-input.js';
import { runProjectBuild } from './pipeline.js';
import { BUILD_PROFILE_VERSION } from './profile.js';

/**
 * 创建预览与正式发布共用的服务：接口 -> request -> scheduler -> build。
 * store 负责数据库，capture 准备源码副本，build 执行构建部署，publish 做正式发布收尾。
 * 默认参数用于生产运行；测试可传入替身，避免连接数据库或实际部署。
 * 返回的对象及其 scheduler 会被 build/index.js 保存为进程内共享的 projectBuilds。
 */
export function createBuildService({ store = buildTaskStore, capture = captureProjectInput,
  build = runProjectBuild, publish = async () => {} } = {}) {
  const scheduler = new BuildScheduler({ save: (task) => store.save(task) });
  // projectId -> 最近一次提交准备的 Promise；也用于把准备源码中的项目计入容量。
  const projectRequests = new Map();

  /**
   * 同项目的“复制源码 -> 查缓存 -> 提交任务”依次处理，不等待构建本身结束。
   * action 失败仍向当前调用方抛错，但不会阻断该项目后续请求。
   */
  function serialized(projectId, action) {
    const result = (projectRequests.get(projectId) || Promise.resolve()).then(action);
    const settled = result.catch(() => {});
    projectRequests.set(projectId, settled);
    void settled.then(() => {
      // 只有自己仍是队尾时才移除，避免旧请求删掉新请求的占位。
      if (projectRequests.get(projectId) === settled) projectRequests.delete(projectId);
    });
    return result;
  }

  /**
   * 组合数据库历史和内存队列，供 POST 响应与 GET 轮询共用；不会扫描源码或创建任务。
   * desiredRevision/latest 表示最近请求的版本，active/pending 表示当前运行/排队任务。
   * lastReady 优先选择目标版本的成功记录，否则保留最近成功页面，避免新构建失败后白屏。
   */
  async function previewState(projectId) {
    const latest = await store.latest(projectId, 'preview');
    const live = scheduler.find(projectId, 'preview');
    const matching = latest ? await store.ready(projectId, latest.revision) : null;
    const ready = matching || await store.ready(projectId);
    return { desiredRevision: latest?.revision || '',
      active: scheduler.view(live.find((task) => task.status === 'running')),
      pending: scheduler.view(live.find((task) => task.status === 'queued')),
      lastReady: ready, latest };
  }

  /**
   * 提交一次构建意图。project 必须已通过所属账号校验，源码目录取 project.dir_path。
   * kind 为 preview 或 publish；force 只绕过相同源码、相同构建策略的失败重试抑制。
   * 成功链接仍优先复用，force 并不表示无条件重新安装、构建或部署。
   * 返回已提交/复用的 job，或在命中成功缓存、抑制失败重试时返回 null。
   * await request() 只等待提交准备完成；等待实际结果需 await job.completion。
   */
  async function request(project, kind, user, { force = false } = {}) {
    scheduler.assertCapacity(project.id, projectRequests.keys());
    return serialized(project.id, async () => {
      const existing = scheduler.find(project.id, kind)[0];
      if (kind === 'publish' && existing) return existing;
      const input = await capture(project.id, project.dir_path);
      let scheduled = false;
      try {
        const latest = await store.latest(project.id, kind);
        // 请求顺序必须超过持久化记录，服务重启后也能正确识别用户最近想看的版本。
        scheduler.nextRequest(latest?.requestedAt || 0);
        if (kind === 'preview') {
          const cached = await store.ready(project.id, input.revision);
          if (cached) {
            await scheduler.cancelQueued(project.id, kind);
            // 用户又请求了历史成功版本：将其标为最新意图，不需要再创建构建任务。
            await store.save({ ...cached, requestedAt: scheduler.nextRequest() });
            return null;
          }
          // 相同源码失败后不因重新打开页面继续重跑；显式刷新才绕过抑制。
          if (!force && latest?.status === 'failed' && latest.revision === input.revision
            && latest.builderVersion === BUILD_PROFILE_VERSION) return null;
        }
        const job = await scheduler.submit({ projectId: project.id, account: project.account, kind,
          builderVersion: BUILD_PROFILE_VERSION,
          revision: input.revision, dispose: input.dispose,
          // 这里只登记回调。闭包保留本次 input；调度器取得执行槽后才调用 run(send, task)。
          run: async (send, task) => {
            const result = await build({ projectId: project.id, input, kind, send });
            if (kind === 'publish') await publish({ project, user, input, result, job: task, send });
            return result;
          } });
        scheduled = true;
        return job;
      } finally {
        // 未交给调度器的副本由服务清理；已提交副本由调度器在完成、替换或超时后清理。
        if (!scheduled) await input.dispose();
      }
    });
  }

  // recover 只把重启遗留任务标为失败，不恢复内存队列，也不自动重新发布。
  return { scheduler, previewState, request, recover: () => store.recover() };
}
