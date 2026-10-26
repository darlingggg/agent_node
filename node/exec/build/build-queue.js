import path from 'path';

const MAX_BUILD_QUEUE_SIZE = 5;
let buildQueueTail = Promise.resolve();
let pendingBuildCount = 0;
const pendingProjectPaths = new Set();

export async function acquireBuildSlot(projectPath, send) {
  const normalizedPath = path.resolve(projectPath);
  if (pendingProjectPaths.has(normalizedPath)) {
    throw new Error('该项目已有构建部署任务正在执行，请勿重复提交');
  }
  if (pendingBuildCount >= MAX_BUILD_QUEUE_SIZE) {
    throw new Error('服务器构建队列已满，请稍后重试');
  }

  const hasTasksAhead = pendingBuildCount > 0;
  pendingBuildCount += 1;
  pendingProjectPaths.add(normalizedPath);

  let releaseQueue;
  const previousTask = buildQueueTail;
  buildQueueTail = new Promise((resolve) => {
    releaseQueue = resolve;
  });
  if (hasTasksAhead) {
    send({
      event: 'step',
      data: {
        key: 'queue',
        title: '等待部署队列',
        status: 'running',
        message: `前方有 ${pendingBuildCount - 1} 个任务，正在等待服务器资源...`,
      },
    });
  }

  await previousTask;
  if (hasTasksAhead) {
    send({
      event: 'step',
      data: {
        key: 'queue',
        title: '等待部署队列',
        status: 'done',
        message: '已获取构建资源',
      },
    });
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    pendingBuildCount -= 1;
    pendingProjectPaths.delete(normalizedPath);
    releaseQueue();
  };
}
