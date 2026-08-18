import express from 'express';
import { getDashboardOverview, parseDashboardDays } from '../../admin/dashboard.js';
import { requestStorageMetricsSync } from '../../cos/storageMetrics.js';
import { requireSuper } from '../../middleware/adminAuth.js';

const router = express.Router();

router.get('/overview', async (req, res) => {
  try {
    const days = parseDashboardDays(req.query.days);
    res.cc(0, '获取成功', await getDashboardOverview(days));
  } catch (error) {
    res.cc(1, error.message);
  }
});

router.post('/storage-sync', requireSuper, (req, res) => {
  const result = requestStorageMetricsSync('manual');
  res.cc(0, result.started ? '同步任务已启动' : '同步任务正在运行', result);
});

export default router;
