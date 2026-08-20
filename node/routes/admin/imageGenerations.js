import express from 'express';
import { getAdminImageGeneration, getAdminImageGenerations } from '../../admin/imageGenerations.js';
import { createPageResult, parsePagination } from '../../utils/pagination.js';

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const pagination = parsePagination(req.query);
    const result = await getAdminImageGenerations({
      ...pagination,
      account: req.query.account,
      projectId: req.query.projectId,
      status: req.query.status,
      origin: req.query.origin,
      keyword: req.query.keyword,
      dateFrom: req.query.dateFrom,
      dateTo: req.query.dateTo,
    });
    res.cc(0, '获取成功', {
      ...createPageResult(result.rows, { ...pagination, total: result.total }),
      summary: result.summary,
    });
  } catch (error) {
    res.cc(1, error.message);
  }
});

router.get('/:taskId', async (req, res) => {
  try {
    res.cc(0, '获取成功', await getAdminImageGeneration(req.params.taskId));
  } catch (error) {
    res.cc(1, error.message);
  }
});

export default router;
