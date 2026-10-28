import { BuildScheduler } from './scheduler.js';
import { buildTaskStore } from './task-store.js';
import { captureProjectInput } from './project-input.js';
import { runProjectBuild } from './pipeline.js';
import { BUILD_PROFILE_VERSION } from './profile.js';

/** 将持久化和输入副本准备与调度规则分离，便于独立测试。 */
export function createBuildService({ store = buildTaskStore, capture = captureProjectInput,
  build = runProjectBuild, publish = async () => {} } = {}) {
  const scheduler = new BuildScheduler({ save: (task) => store.save(task) });
  const projectRequests = new Map();

  function serialized(projectId, action) {
    const result = (projectRequests.get(projectId) || Promise.resolve()).then(action);
    const settled = result.catch(() => {});
    projectRequests.set(projectId, settled);
    void settled.then(() => {
      if (projectRequests.get(projectId) === settled) projectRequests.delete(projectId);
    });
    return result;
  }

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

  async function request(project, kind, user, { force = false } = {}) {
    scheduler.assertCapacity(project.id, projectRequests.keys());
    return serialized(project.id, async () => {
      const existing = scheduler.find(project.id, kind)[0];
      if (kind === 'publish' && existing) return existing;
      const input = await capture(project.id, project.dir_path);
      let scheduled = false;
      try {
        const latest = await store.latest(project.id, kind);
        scheduler.nextRequest(latest?.requestedAt || 0);
        if (kind === 'preview') {
          const cached = await store.ready(project.id, input.revision);
          if (cached) {
            await scheduler.cancelQueued(project.id, kind);
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
          run: async (send, task) => {
            const result = await build({ projectId: project.id, input, kind, send });
            if (kind === 'publish') await publish({ project, user, input, result, job: task, send });
            return result;
          } });
        scheduled = true;
        return job;
      } finally {
        if (!scheduled) await input.dispose();
      }
    });
  }

  return { scheduler, previewState, request, recover: () => store.recover() };
}
