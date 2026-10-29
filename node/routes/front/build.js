import express from 'express';
import authJWT from '../../middleware/authJWT.js';
import { getProjectInfo } from '../../project.js';
import { projectBuilds } from '../../exec/build/service.js';
import { prepareSse, writeSse } from './sse.js';

const router = express.Router();

/**
 * 校验项目后通过 SSE 推送发布进度；重复发布订阅已有任务，不追加构建。
 * 任务完成并保存发布记录后结束响应；客户端断开仅取消订阅，后台继续运行。
 */
router.post('/project/build', authJWT, async (req, res) => {
  const projectId = Number(req.body.projectId);
  if (!Number.isSafeInteger(projectId) || projectId < 1) return res.cc(1, '项目 id 无效');
  let project;
  try {
    project = await getProjectInfo(projectId, req.user);
  } catch (error) {
    return res.cc(1, error.message);
  }

  prepareSse(res);
  let clientClosed = false;
  let unsubscribe = () => {};
  let job;
  // 这里只负责向 HTTP 连接写事件；构建阶段通过 scheduler.reportProgress 上报，两者经订阅相连。
  const send = (event) => {
    if (!clientClosed) writeSse(res, event);
  };
  const heartbeat = setInterval(() => {
    if (!clientClosed) res.write(': heartbeat\n\n');
  }, 15_000);
  res.on('close', () => {
    // 浏览器离开只断开订阅与心跳，不终止后台构建或发布收尾。
    clientClosed = true;
    unsubscribe();
    clearInterval(heartbeat);
  });

  try {
    // request 只等提交完成，completion 才等待部署及快照/正式记录保存结束。
    job = await projectBuilds.request(project, 'publish', req.user);
    if (!clientClosed) unsubscribe = projectBuilds.scheduler.subscribe(job, send);
    await job.completion;
  } catch (error) {
    // job 已存在时，运行失败事件由 scheduler 广播；此处仅补发提交阶段的错误。
    if (!job) send({ event: 'error', data: error.message });
  } finally {
    unsubscribe();
    clearInterval(heartbeat);
    if (!clientClosed) res.end();
  }
});

export default router;
