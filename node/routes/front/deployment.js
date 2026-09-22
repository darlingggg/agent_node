import express from 'express';
import authJWT from '../../middleware/authJWT.js';
import { buildCommand, deleteOnlineVersion } from '../../exec/index.js';
import {
  buildProject,
  getAllTemplateVersionFiles,
  getCurrentProjectTemplateVersion,
  getLatestTemplateVersion,
  getProjectInfo,
  updateProjectTemplateVersion,
} from '../../project/index.js';
import { addSnapshot, getCurrentVision } from '../../snapshot/index.js';
import { markUserActive } from '../../utils/activity.js';
import { prepareSse, writeSse } from './sse.js';

const router = express.Router();

router.post('/project/build', authJWT, async (req, res) => {
  const { dir, projectId } = req.body;
  if (!dir) return res.cc(1, '项目根目录不能为空');
  if (!projectId) return res.cc(1, '项目id不能为空');

  prepareSse(res);
  let clientClosed = false;
  const send = (event) => {
    if (!clientClosed) writeSse(res, event);
  };
  res.on('close', () => {
    if (!res.writableEnded) clientClosed = true;
  });

  try {
    const { link, deploymentId } = await buildCommand(dir, send);
    const oldDeploymentId = (await getProjectInfo(projectId, req.user)).cloudflare_id;
    const version = `构建${Math.random().toString(36).substring(2, 15)}`;
    const { id: snapshotId } = await addSnapshot(projectId, version, dir, '', req.user);
    await buildProject(projectId, link, snapshotId, deploymentId);
    await markUserActive(req.user.id);
    if (oldDeploymentId) await deleteOnlineVersion(dir, oldDeploymentId);
    if (!clientClosed) res.end();
  } catch (error) {
    if (!clientClosed) {
      send({ event: 'error', data: `错误信息: \n${error.message}` });
      res.end();
    }
  }
});

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
