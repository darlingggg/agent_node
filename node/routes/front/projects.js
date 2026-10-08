import express from 'express';
import authJWT from '../../middleware/authJWT.js';
import {
  createProject,
  deleteProject,
  getProjectInfo,
  getProjectList,
  updateProject,
} from '../../project/index.js';
import { markUserActive } from '../../utils/activity.js';

const router = express.Router();

router.post('/project/create', authJWT, async (req, res) => {
  if (!req.body.title) return res.cc(1, '标题不能为空');
  if (!req.body.type) return res.cc(1, '类型不能为空');
  try {
    const result = await createProject(req.user, req.body);
    await markUserActive(req.user.id);
    res.cc(0, '创建成功', result);
  } catch (error) {
    res.cc(1, error.message);
  }
});

router.get('/project/list', authJWT, async (req, res) => {
  try {
    res.cc(0, '获取成功', await getProjectList(req.user));
  } catch (error) {
    res.cc(1, error.message);
  }
});

router.post('/project/delete', authJWT, async (req, res) => {
  if (!req.body.id) return res.cc(1, 'id 不能为空');
  try {
    const result = await deleteProject(req.body.id, req.user);
    await markUserActive(req.user.id);
    res.cc(0, '删除成功', result);
  } catch (error) {
    res.cc(1, error.message);
  }
});

router.patch('/project/update', authJWT, async (req, res) => {
  if (!req.body.id) return res.cc(1, 'id 不能为空');
  if (!req.body.title) return res.cc(1, '标题不能为空');
  try {
    const result = await updateProject(req.body, req.user);
    await markUserActive(req.user.id);
    res.cc(0, '修改成功', result);
  } catch (error) {
    res.cc(1, error.message);
  }
});

router.get('/project/usage', authJWT, async (req, res) => {
  if (!req.query.projectId) return res.cc(1, '项目id不能为空');
  try {
    const project = await getProjectInfo(req.query.projectId, req.user);
    res.cc(0, '获取成功', {
      projectId: project.id,
      promptTokens: Number(project.ai_prompt_tokens) || 0,
      completionTokens: Number(project.ai_completion_tokens) || 0,
      totalTokens: Number(project.ai_total_tokens) || 0,
    });
  } catch (error) {
    res.cc(1, error.message);
  }
});

export default router;
