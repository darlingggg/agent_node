import { randomUUID } from 'node:crypto';
import { removeProjectInput } from './project-input.js';

/**
 * @typedef {Object} BuildJob
 * @property {string} id 任务 UUID；同一次排队更新保留 ID。
 * @property {number} projectId 项目 ID。
 * @property {string} account 所属账号。
 * @property {'preview'|'publish'} kind 兼容预览或正式发布。
 * @property {string} revision 源码指纹。
 * @property {string} builderVersion 构建策略版本。
 * @property {Object} project 已校验归属的项目资料，仅在内存中供发布收尾使用。
 * @property {Object} user 发起用户，仅在内存中供发布收尾使用。
 * @property {{directory: string, revision: string}} source 固定源码副本，任务结束后删除。
 * @property {'queued'|'running'|'ready'|'failed'|'superseded'} status 任务整体状态。
 * @property {string} phase 当前步骤，如 install/build/deploy。
 * @property {string} queuedAt 入队时间（ISO 字符串）。
 * @property {number} requestedAt 严格递增的请求顺序；复用、替换时更新。
 * @property {string|null} startedAt 开始执行时间。
 * @property {string|null} completedAt 结束时间。
 * @property {string} error 失败信息。
 * @property {Object|null} result pipeline 的完整结果，预览链接在 result.link。
 * @property {Array<Object>} events 最近 40 条进度事件，供 SSE 订阅重放。
 * @property {Set<Function>} listeners SSE 订阅者。
 * @property {Promise<void>} persistence 顺序写入数据库的 Promise 链。
 * @property {Promise<Object|null>} completion 最终结果；丢弃任务时返回 null。
 * @property {Function} resolve 完成 completion。
 * @property {Function} reject 拒绝 completion。
 * @property {ReturnType<typeof setTimeout>|null} timer 预览排队期限，不是执行期限。
 */

/**
 * 进程内构建调度器：正式发布和预览共用一个执行槽，排队中的预览仅保留最新输入。
 * 只管理任务生命周期；实际工作调用 ProjectBuildService.executeBuild，数据库调用 store.save。
 * queue/active 不跨进程共享，因此不能据此协调多个后端实例。
 */
export class BuildScheduler {
  /**
   * service 执行构建，store 保存状态；queueTimeout 只限制预览排队。
   * @param {{service: import('./service.js').ProjectBuildService,
   *   store: typeof import('./task-store.js').buildTaskStore,
   *   maxProjects?: number, queueTimeout?: number}} options
   */
  constructor({ service, store, maxProjects = 5, queueTimeout = 60_000 }) {
    this.service = service;
    this.store = store;
    this.maxProjects = maxProjects;
    this.queueTimeout = queueTimeout;
    this.active = null; // 正在执行的唯一任务；直到执行收尾和输入清理后才释放。
    this.queue = []; // 等待任务；同项目预览至多保留一个下一次目标。
    this.requests = Promise.resolve(); // 队列状态修改的串行链，不是构建执行链。
    this.requestClock = Date.now();
  }

  /** 串行修改共享队列，避免 await 交错；构建本身在锁外执行，允许新请求继续入队。 */
  locked(action) {
    const result = this.requests.then(action);
    this.requests = result.catch(() => {});
    return result;
  }

  /** 生成严格递增的请求顺序值；after 可接数据库旧记录，避免重启或同毫秒请求顺序混乱。 */
  nextRequest(after = 0) {
    this.requestClock = Math.max(this.requestClock + 1, after + 1, Date.now());
    return this.requestClock;
  }

  /** 检查去重后的项目容量；reserved 是 service 正在准备输入的项目，已有项目可继续更新。 */
  assertCapacity(projectId, reserved = []) {
    const projects = new Set([...reserved,
      ...[this.active, ...this.queue].filter(Boolean).map((job) => job.projectId)]);
    if (!projects.has(projectId) && projects.size >= this.maxProjects) {
      throw new Error('服务器构建队列已满，请稍后重试');
    }
  }

  /** 缓存最近 40 条事件并通知订阅者；监听器用于发布 SSE，预览进度主要靠 GET 查询。 */
  emit(job, event) {
    job.events.push(event);
    if (job.events.length > 40) job.events.shift();
    for (const listener of job.listeners) {
      try { listener(event); } catch { job.listeners.delete(listener); }
    }
  }

  /** 提取接口/数据库可用的状态，排除源码目录、用户资料、Promise 和监听器等内部对象。 */
  view(job) {
    if (!job) return null;
    const { id, projectId, account, kind, revision, builderVersion, status, phase, error, result,
      queuedAt, requestedAt, startedAt, completedAt } = job;
    return { id, projectId, account, kind, revision, builderVersion, status, phase, error, result,
      queuedAt, requestedAt, startedAt, completedAt,
      queuePosition: status === 'queued' ? this.orderedQueue().indexOf(job) + 1 : 0 };
  }

  /** 返回实际调度顺序：发布优先，同类型保持原顺序；不打断 active，也不修改原数组。 */
  orderedQueue() {
    return [...this.queue.filter((job) => job.kind === 'publish'),
      ...this.queue.filter((job) => job.kind === 'preview')];
  }

  /** 查找某项目、某类型的活跃任务，返回顺序为正在运行的任务在前、排队任务在后。 */
  find(projectId, kind) {
    return [this.active, ...this.queue].filter((job) =>
      job && job.projectId === projectId && job.kind === kind);
  }

  /**
   * 将当前状态快照追加到该任务的数据库写入链，保证 queued/running/ready 不会乱序落库。
   * 可同时广播事件；广播不等待写库完成，返回的 Promise 可用于关键状态的持久化确认。
   */
  record(job, event) {
    const snapshot = this.view(job);
    job.persistence = job.persistence.then(() => this.store.save(snapshot));
    void job.persistence.catch(() => {});
    if (event) this.emit(job, event);
    return job.persistence;
  }

  /** 先发送当前状态并重放缓存事件，再监听新事件；返回取消订阅函数，不会取消任务。 */
  subscribe(job, listener) {
    listener({ event: 'task', data: this.view(job) });
    for (const event of job.events) listener(event);
    job.listeners.add(listener);
    return () => job.listeners.delete(listener);
  }

  /** 丢弃不再需要的排队任务，标为 superseded 并清理输入；由持有队列锁的调用方调用。 */
  async discard(job) {
    clearTimeout(job.timer);
    this.queue = this.queue.filter((item) => item !== job);
    job.status = 'superseded';
    job.completedAt = new Date().toISOString();
    try {
      await this.record(job);
    } finally {
      await removeProjectInput(job.source).catch((error) => console.error('[build-queue] 清理失败:', error.message));
      job.resolve(null);
    }
  }

  /** 取消该项目该类型的排队目标；用于复用成功链接，不会中断正在执行的任务。 */
  cancelQueued(projectId, kind) {
    return this.locked(async () => {
      const job = this.queue.find((item) => item.projectId === projectId && item.kind === kind);
      if (job) await this.discard(job);
    });
  }

  /**
   * 接收 service 提供的任务数据：project/user/source 等字段由 createJob 集中定义。
   * 优先复用已有任务，其次替换排队输入，最后创建新任务；不等待任务执行结束。
   * 返回 job；job.completion 才表示构建及正式发布收尾的最终结果。
   */
  submit(request) {
    // 串行修改调度状态，避免多个异步请求交错操作同一个任务或队列。
    return this.locked(async () => {
      const matches = this.find(request.projectId, request.kind);
      const running = matches.find((job) => job.status === 'running');
      const queued = matches.find((job) => job.status === 'queued');
      // 重复正式发布复用现有任务；预览仅复用源码指纹相同的任务。
      const reusable = request.kind === 'publish' ? matches[0]
        : matches.find((job) => job.revision === request.revision);
      const requestedAt = this.nextRequest();

      if (reusable) {
        // 最新内容恢复为执行中的版本时，取消已经不需要的下一次预览。
        if (reusable === running && queued) await this.discard(queued);
        reusable.requestedAt = requestedAt;
        // 已有任务持有自己的输入副本，本次新准备的副本可以直接删除。
        await removeProjectInput(request.source);
        await this.record(reusable);
        return reusable;
      }
      if (queued) {
        // 替换固定源码与发布资料，保留任务编号、排队位置和原超时计时器。
        await removeProjectInput(queued.source);
        Object.assign(queued, {
          revision: request.revision, source: request.source,
          project: request.project, user: request.user, requestedAt,
        });
        await this.record(queued);
        return queued;
      }

      // 新建任务前检查项目容量；拒绝接单时也要清理本次输入副本。
      try {
        this.assertCapacity(request.projectId);
      } catch (error) {
        await removeProjectInput(request.source);
        throw error;
      }
      const job = this.createJob(request, requestedAt);
      this.queue.push(job);
      // 先持久化再触发执行，保存失败时撤销入队并清理输入副本。
      try {
        await this.record(job);
      } catch (error) {
        this.queue = this.queue.filter((item) => item !== job);
        await removeProjectInput(job.source);
        throw error;
      }
      if (request.kind === 'preview') {
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

  /**
   * 集中初始化 BuildJob 的全部属性。任务仅携带执行数据，不包含自定义 run/dispose。
   * completion 用于等待结果；预览路由只等待 submit 返回，再通过 GET 查询状态。
   * @returns {BuildJob}
   */
  createJob(request, requestedAt) {
    const { promise, resolve, reject } = Promise.withResolvers();
    // 预览没有人 await completion 时，也不产生未处理拒绝；原 Promise 仍保留失败结果。
    void promise.catch(() => {});
    return {
      id: randomUUID(),
      projectId: request.projectId,
      account: request.account,
      kind: request.kind,
      revision: request.revision,
      builderVersion: request.builderVersion,
      project: request.project,
      user: request.user,
      source: request.source,
      status: 'queued',
      phase: 'queue',
      queuedAt: new Date().toISOString(),
      requestedAt,
      startedAt: null,
      completedAt: null,
      error: '',
      result: null,
      events: [],
      listeners: new Set(),
      persistence: Promise.resolve(),
      completion: promise,
      resolve,
      reject,
      timer: null,
    };
  }

  /** 预览排队超时回调：仍处于 queued 才标记失败、清理副本并拒绝 completion。 */
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
        await removeProjectInput(job.source).catch((error) => console.error('[build-queue] 清理失败:', error.message));
        job.reject(new Error(job.error));
      }
    }).catch((error) => console.error('[build-queue]', error));
  }

  /**
   * 尝试启动一个任务：槽位空闲才出队，切换到 running 后异步执行。
   * 不在 locked 中等待 execute，否则构建期间其他请求无法提交或更新队列。
   */
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

  /** pipeline 和 service 直接调用此方法报告进度；更新阶段并顺序落库、通知 SSE 订阅者。 */
  reportProgress(job, event) {
    if (event.event === 'step') job.phase = event.data.key;
    void this.record(job, event);
  }

  /**
   * 执行完整生命周期：service.executeBuild -> 保存结果 -> 通知等待者 -> 清理源码 -> 下一项。
   * service 中的正式发布收尾也占用执行槽，避免构建已结束但发布记录尚未保存就开始下一项。
   */
  async execute(job) {
    try {
      await this.record(job);
      job.result = await this.service.executeBuild(job);
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
      // 即便先前写库失败，也重新建立可继续写入的链，尽力记录最终失败原因。
      job.persistence = job.persistence.catch(() => {});
      await this.record(job, { event: 'error', data: job.error }).catch((failure) =>
        console.error('[build-queue] 保存失败状态失败:', failure.message));
      job.reject(error);
    } finally {
      await removeProjectInput(job.source).catch((error) => console.error('[build-queue] 清理失败:', error.message));
      await this.locked(() => { this.active = null; });
      this.pump();
    }
  }
}
