import express from 'express';
import authJWT from '../../middleware/authJWT.js';
import { getCredential } from '../../cos/index.js';
import { markUserActive } from '../../utils/activity.js';

const router = express.Router();

router.get('/', (_req, res) => {
  res.cc(0, 'Express 服务运行正常');
});

router.get('/cos/credential', authJWT, async (req, res) => {
  try {
    const result = await getCredential(req.user.storage_key);
    await markUserActive(req.user.id);
    res.cc(0, '获取成功', result);
  } catch (error) {
    res.cc(1, error.message);
  }
});

export default router;
