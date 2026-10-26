import express from 'express';
import authJWT from '../../middleware/authJWT.js';
import { listModels } from '../../models/service.js';

const router = express.Router();

router.get('/models', authJWT, async (_req, res) => {
  try {
    res.cc(0, '获取成功', await listModels());
  } catch (error) {
    res.cc(1, error.message);
  }
});

export default router;
