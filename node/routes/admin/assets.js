import express from 'express';
import { getUploadedAssets } from '../../admin/assets.js';
import { createPageResult, parsePagination } from '../../utils/pagination.js';

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const pagination = parsePagination(req.query);
    const result = await getUploadedAssets({
      ...pagination,
      marker: String(req.query.marker || ''),
      userId: req.query.userId,
    });
    res.cc(0, '获取成功', createPageResult(result.rows, {
      ...pagination,
      total: null,
      hasMore: result.hasMore,
      nextMarker: result.nextMarker,
    }));
  } catch (error) {
    res.cc(1, error.message);
  }
});

export default router;
