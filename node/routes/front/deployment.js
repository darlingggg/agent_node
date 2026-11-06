import express from 'express';
import authJWT from '../../middleware/authJWT.js';
import buildRouter from './build.js';
import {
  getAllTemplateVersionFiles,
  getCurrentProjectTemplateVersion,
  getLatestTemplateVersion,
  updateProjectTemplateVersion,
} from '../../project.js';
import { getCurrentVision } from '../../snapshot.js';
import { markUserActive } from '../../utils/activity.js';

const router = express.Router();

router.use(buildRouter);

router.get('/project/version', authJWT, async (req, res) => {
  if (!req.query.projectId) return res.cc(1, '项目id不能为空');
  try {
    res.cc(0, '获取成功', await getCurrentVision(req.query.projectId));
  } catch (error) {
    res.cc(1, error.message);
  }
});

router.get('/temp/latest', async (req, res) => {
  if (!req.query.type) return res.cc(1, '类型不能为空');
  try {
    res.cc(0, '获取成功', await getLatestTemplateVersion(req.query.type));
  } catch (error) {
    res.cc(1, error.message);
  }
});

router.get('/temp/current', authJWT, async (req, res) => {
  if (!req.query.projectId) return res.cc(1, '项目id不能为空');
  try {
    res.cc(0, '获取成功', await getCurrentProjectTemplateVersion(req.query.projectId));
  } catch (error) {
    res.cc(1, error.message);
  }
});

router.post('/temp/update', authJWT, async (req, res) => {
  const { projectId, upToVersion = null } = req.body;
  if (!projectId) return res.cc(1, '项目id不能为空');
  try {
    const result = await updateProjectTemplateVersion(projectId, upToVersion, req.user);
    await markUserActive(req.user.id);
    res.cc(0, '更新成功', result);
  } catch (error) {
    res.cc(1, error.message);
  }
});

router.get('/temp/list', async (req, res) => {
  if (!req.query.type) return res.cc(1, '类型不能为空');
  try {
    res.cc(0, '获取成功', await getAllTemplateVersionFiles(req.query.type));
  } catch (error) {
    res.cc(1, error.message);
  }
});

export default router;
