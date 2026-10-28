import { randomUUID } from 'node:crypto';

/** 正式发布和预览共用一个执行槽，排队中的预览仅保留最新输入。 */
export class BuildScheduler {
  constructor({ save = async () => {}, maxProjects = 5, queueTimeout = 60_000 } = {}) {
    this.save = save;
    this.maxProjects = maxProjects;
    this.queueTimeout = queueTimeout;
    this.active = null;
    this.queue = [];
    this.requests = Promise.resolve();
    this.requestClock = Date.now();
  }

  locked(action) {
    const result = this.requests.then(action);
    this.requests = result.catch(() => {});
    return result;
  }

  nextRequest(after = 0) {
    this.requestClock = Math.max(this.requestClock + 1, after + 1, Date.now());
    return this.requestClock;
  }

  assertCapacity(projectId, reserved = []) {
    const projects = new Set([...reserved,
      ...[this.active, ...this.queue].filter(Boolean).map((job) => job.projectId)]);
    if (!projects.has(projectId) && projects.size >= this.maxProjects) {
      throw new Error('服务器构建队列已满，请稍后重试');
    }
  }

  emit(job, event) {
    job.events.push(event);
    if (job.events.length > 40) job.events.shift();
    for (const listener of job.listeners) {
      try { listener(event); } catch { job.listeners.delete(listener); }
    }
  }

  view(job) {
    if (!job) return null;
    const { id, projectId, account, kind, revision, builderVersion, status, phase, error, result,
      queuedAt, requestedAt, startedAt, completedAt } = job;
    return { id, projectId, account, kind, revision, builderVersion, status, phase, error, result,
      queuedAt, requestedAt, startedAt, completedAt,
      queuePosition: status === 'queued' ? this.orderedQueue().indexOf(job) + 1 : 0 };
  }

  orderedQueue() {
    return [...this.queue.filter((job) => job.kind === 'publish'),
      ...this.queue.filter((job) => job.kind === 'preview')];
  }

  find(projectId, kind) {
    return [this.active, ...this.queue].filter((job) =>
      job && job.projectId === projectId && job.kind === kind);
  }

  record(job, event) {
    const snapshot = this.view(job);
    job.persistence = job.persistence.then(() => this.save(snapshot));
    void job.persistence.catch(() => {});
    if (event) this.emit(job, event);
    return job.persistence;
  }

  subscribe(job, listener) {
    listener({ event: 'task', data: this.view(job) });
    for (const event of job.events) listener(event);
    job.listeners.add(listener);
    return () => job.listeners.delete(listener);
  }

  async discard(job) {
    clearTimeout(job.timer);
    this.queue = this.queue.filter((item) => item !== job);
    job.status = 'superseded';
    job.completedAt = new Date().toISOString();
    try {
      await this.record(job);
    } finally {
      await job.dispose().catch((error) => console.error('[build-queue] 清理失败:', error.message));
      job.resolve(null);
    }
  }

  cancelQueued(projectId, kind) {
    return this.locked(async () => {
      const job = this.queue.find((item) => item.projectId === projectId && item.kind === kind);
      if (job) await this.discard(job);
    });
  }

  /** 提交任务：优先复用已有任务，其次替换排队输入，最后创建新任务。 */
  submit(input) {
    // 串行修改调度状态，避免多个异步请求交错操作同一个任务或队列。
    return this.locked(async () => {
      const matches = this.find(input.projectId, input.kind);
      const running = matches.find((job) => job.status === 'running');
      const queued = matches.find((job) => job.status === 'queued');
      // 重复正式发布复用现有任务；预览仅复用源码指纹相同的任务。
      const reusable = input.kind === 'publish' ? matches[0]
        : matches.find((job) => job.revision === input.revision);
      const requestedAt = this.nextRequest();

      if (reusable) {
        // 最新内容恢复为执行中的版本时，取消已经不需要的下一次预览。
        if (reusable === running && queued) await this.discard(queued);
        reusable.requestedAt = requestedAt;
        // 已有任务持有自己的输入副本，本次新准备的副本可以直接删除。
        await input.dispose();
        await this.record(reusable);
        return reusable;
      }
      if (queued) {
        // 替换内容及其执行、清理回调，保留任务编号、排队位置和原超时计时器。
        await queued.dispose();
        Object.assign(queued, { revision: input.revision, run: input.run,
          dispose: input.dispose, requestedAt });
        await this.record(queued);
        return queued;
      }

      // 新建任务前检查项目容量；拒绝接单时也要清理本次输入副本。
      try {
        this.assertCapacity(input.projectId);
      } catch (error) {
        await input.dispose();
        throw error;
      }
      const job = { ...input, id: randomUUID(), status: 'queued', phase: 'queue',
        queuedAt: new Date().toISOString(), requestedAt, startedAt: null, completedAt: null,
        error: '', result: null, events: [], listeners: new Set(), persistence: Promise.resolve() };
      // 提交只返回任务对象，调用方通过 completion 等待实际执行结果。
      job.completion = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
      // 预先处理未被订阅的拒绝，原 completion 仍会向等待它的调用方抛出错误。
      void job.completion.catch(() => {});
      this.queue.push(job);
      // 先持久化再触发执行，保存失败时撤销入队并清理输入副本。
      try {
        await this.record(job);
      } catch (error) {
        this.queue = this.queue.filter((item) => item !== job);
        await job.dispose();
        throw error;
      }
      if (input.kind === 'preview') {
        // 仅限制预览的排队时长；开始执行时会清除此计时器。
        job.timer = setTimeout(() => void this.expire(job), this.queueTimeout);
        // 计时器本身不阻止 Node.js 进程正常退出。
        job.timer.unref?.();
      }
      // 通知调度器尝试执行任务；已有任务运行时，新任务继续排队。
      this.pump();
      return job;
    });
  }

  async expire(job) {
    await this.locked(async () => {
      if (job.status !== 'queued') return;
      this.queue = this.queue.filter((item) => item !== job);
      job.status = 'failed';
      job.error = '等待预览队列超时，请稍后重试';
      job.completedAt = new Date().toISOString();
      try {
        await this.record(job);
      } finally {
        await job.dispose().catch((error) => console.error('[build-queue] 清理失败:', error.message));
        job.reject(new Error(job.error));
      }
    }).catch((error) => console.error('[build-queue]', error));
  }

  pump() {
    void this.locked(() => {
      if (this.active) return;
      const job = this.orderedQueue()[0];
      if (!job) return;
      this.queue = this.queue.filter((item) => item !== job);
      clearTimeout(job.timer);
      this.active = job;
      job.status = 'running';
      job.phase = 'prepare';
      job.startedAt = new Date().toISOString();
      void this.execute(job);
    });
  }

  async execute(job) {
    const send = (event) => {
      if (event.event === 'step') job.phase = event.data.key;
      void this.record(job, event);
    };
    try {
      await this.record(job);
      job.result = await job.run(send, job);
      job.status = 'ready';
      job.phase = 'ready';
      job.completedAt = new Date().toISOString();
      await this.record(job);
      const event = { event: 'done', data: { ...job.result, taskId: job.id } };
      this.emit(job, event);
      job.resolve(job.result);
    } catch (error) {
      job.status = 'failed';
      job.error = String(error.message || error).slice(-2000);
      job.completedAt = new Date().toISOString();
      job.persistence = job.persistence.catch(() => {});
      await this.record(job, { event: 'error', data: job.error }).catch((failure) =>
        console.error('[build-queue] 保存失败状态失败:', failure.message));
      job.reject(error);
    } finally {
      await job.dispose().catch((error) => console.error('[build-queue] 清理失败:', error.message));
      await this.locked(() => { this.active = null; });
      this.pump();
    }
  }
}
