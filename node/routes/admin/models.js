import express from 'express';
import { listModels, setDefaultModel, setModelAvailability } from '../../models/service.js';
import { getModelSyncState, nextModelSyncTime, runModelSync } from '../../models/scheduler.js';

const router = express.Router();

router.get('/', async (_req, res) => {
  try {
    res.cc(0, '获取成功', {
      list: await listModels({ includeDisabled: true }),
      sync: getModelSyncState(),
      nextSyncAt: nextModelSyncTime(),
    });
  } catch (error) {
    res.cc(1, error.message);
  }
});

router.post('/sync', async (_req, res) => {
  try {
    const result = await runModelSync();
    res.cc(0, result.skipped ? result.reason : '模型同步完成', result);
  } catch (error) {
    res.cc(1, `模型同步失败：${error.message}`);
  }
});

router.patch('/availability', async (req, res) => {
  try {
    const result = await setModelAvailability(req.body?.model, req.body?.enabled);
    res.cc(0, result.enabled ? '模型已启用' : '模型已禁用', result);
  } catch (error) {
    res.cc(1, error.message);
  }
});

router.patch('/default', async (req, res) => {
  try {
    res.cc(0, '默认模型已更新', await setDefaultModel(req.body?.model));
  } catch (error) {
    res.cc(1, error.message);
  }
});

export default router;
