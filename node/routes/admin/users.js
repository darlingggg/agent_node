import express from 'express';
import {
  getAdminUserDetail,
  getAdminUserList,
  updateAdminUser,
} from '../../admin/users.js';
import { createPageResult, parsePagination } from '../../utils/pagination.js';

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const pagination = parsePagination(req.query);
    const { rows, total } = await getAdminUserList(pagination);
    res.cc(0, '获取成功', createPageResult(rows, { ...pagination, total }));
  } catch (error) {
    res.cc(1, error.message);
  }
});

router.get('/:id', async (req, res) => {
  try {
    const user = await getAdminUserDetail(req.params.id);
    res.cc(0, '获取成功', user);
  } catch (error) {
    res.cc(1, error.message);
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const user = await updateAdminUser(req.user, req.params.id, req.body);
    res.cc(0, '修改成功', user);
  } catch (error) {
    res.cc(1, error.message);
  }
});

export default router;
