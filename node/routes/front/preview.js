import express from 'express';
import authJWT from '../../middleware/authJWT.js';
import { getProjectInfo } from '../../project.js';
import { projectBuilds } from '../../exec/build/service.js';

const router = express.Router();

/** 查询当前预览任务和上一次成功链接；只读状态，不扫描源码、不创建构建任务。 */
router.get('/project/preview', authJWT, async (req, res) => {
  const projectId = Number(req.query.projectId);
  if (!Number.isSafeInteger(projectId) || projectId < 1) return res.cc(1, '项目 id 无效');
  try {
    await getProjectInfo(projectId, req.user);
    res.cc(0, '获取成功', await projectBuilds.previewState(projectId));
  } catch (error) {
    res.cc(1, error.message);
  }
});

/**
 * 校验项目归属后提交兼容预览，源码目录只取数据库中的 dir_path。
 * 等待源码准备和入队后即返回状态；前端继续 GET 轮询 lastReady.result.link。
 * force 只允许重试相同源码的失败，成功链接、依赖和构建产物仍可复用。
 */
router.post('/project/preview', authJWT, async (req, res) => {
  const projectId = Number(req.body.projectId);
  if (!Number.isSafeInteger(projectId) || projectId < 1) return res.cc(1, '项目 id 无效');
  if (req.body.force !== undefined && typeof req.body.force !== 'boolean') {
    return res.cc(1, 'force 必须为布尔值');
  }
  try {
    const project = await getProjectInfo(projectId, req.user);
    await projectBuilds.request(project, 'preview', req.user, { force: req.body.force === true });
    res.cc(0, '获取成功', await projectBuilds.previewState(projectId));
  } catch (error) {
    res.cc(1, error.message);
  }
});

export default router;
