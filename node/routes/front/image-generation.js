import express from 'express';
import authJWT from '../../middleware/authJWT.js';
import {
  createImageGenerationTask,
  getPublicImageGenerationTask,
  listImageGenerationTasks,
  subscribeImageGenerationTask,
} from '../../imageGeneration.js';
import { markUserActive } from '../../utils/activity.js';
import { prepareSse, writeSse } from './sse.js';

const router = express.Router();
const isNumericId = (value) => /^\d+$/.test(value);

router.post('/agent/image-gen', authJWT, async (req, res) => {
  if (!req.body.prompt) return res.cc(1, 'prompt 不能为空');
  try {
    const result = await createImageGenerationTask({
      account: req.user.account,
      storageKey: req.user.storage_key,
      prompt: req.body.prompt,
      imageUrls: req.body.imageUrls ?? [],
      negativePrompt: req.body.negativePrompt ?? '',
      size: req.body.size ?? 'auto',
      projectId: req.body.projectId ?? null,
      conversationId: req.body.conversationId ?? null,
    });
    await markUserActive(req.user.id);
    res.status(202);
    res.cc(0, '图片生成任务已创建', result);
  } catch (error) {
    res.cc(1, error.message);
  }
});

router.get('/agent/image-gen/tasks', authJWT, async (req, res) => {
  try {
    const result = await listImageGenerationTasks({
      account: req.user.account,
      projectId: req.query.projectId,
      conversationId: req.query.conversationId,
      assistantSessionId: req.query.assistantSessionId,
      page: req.query.page,
      pageSize: req.query.pageSize,
    });
    res.cc(0, '获取成功', result);
  } catch (error) {
    res.cc(1, error.message);
  }
});

router.get('/agent/image-gen/tasks/:taskId', authJWT, async (req, res) => {
  if (!isNumericId(req.params.taskId)) return res.cc(1, 'taskId 格式不正确');
  try {
    const result = await getPublicImageGenerationTask(req.params.taskId, req.user.account);
    if (!result) return res.cc(1, '图片生成任务不存在');
    res.cc(0, '获取成功', result);
  } catch (error) {
    res.cc(1, error.message);
  }
});

router.get('/agent/image-gen/tasks/:taskId/stream', authJWT, async (req, res) => {
  if (!isNumericId(req.params.taskId)) return res.cc(1, 'taskId 格式不正确');
  prepareSse(res);
  res.write('retry: 3000\n\n');
  try {
    await subscribeImageGenerationTask({
      taskId: req.params.taskId,
      account: req.user.account,
      storageKey: req.user.storage_key,
      res,
      observeOnly: req.query.observeOnly === '1',
    });
  } catch (error) {
    if (!res.writableEnded) {
      writeSse(res, {
        event: 'error',
        data: { taskId: Number(req.params.taskId), message: error.message },
      });
      res.end();
    }
  }
});

export default router;
