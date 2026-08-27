import express from 'express';
import { getAdminProjectDetail, getAllProjects } from '../../admin/projects.js';
import { createPageResult, parsePagination } from '../../utils/pagination.js';

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const pagination = parsePagination(req.query);
    const { rows, total } = await getAllProjects({
      ...pagination,
      userId: req.query.userId,
      account: req.query.account,
    });
    res.cc(0, '获取成功', createPageResult(rows, { ...pagination, total }));
  } catch (error) {
    res.cc(1, error.message);
  }
});

router.get('/:id', async (req, res) => {
  try {
    const pagination = parsePagination(req.query);
    const result = await getAdminProjectDetail(req.params.id, pagination);
    res.cc(0, '获取成功', {
      ...result.project,
      conversations: createPageResult(result.conversations, {
        ...pagination,
        total: result.conversationTotal,
      }),
    });
  } catch (error) {
    res.cc(1, error.message);
  }
});

export default router;
