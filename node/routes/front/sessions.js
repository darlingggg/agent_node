import express from 'express';
import authJWT from '../../middleware/authJWT.js';
import {
  createSession,
  deleteConversation,
  deleteSession,
  getConversationList,
  getConversationMessages,
  getConversationStats,
  getSessionDetail,
  getSessionList,
  updateConversation,
  updateSession,
} from '../../session/index.js';
import { contextCache } from './context.js';

const router = express.Router();
const isNumericId = (value) => /^\d+$/.test(value);

router.post('/session/create', authJWT, async (req, res) => {
  if (!req.body.role) return res.cc(1, '角色不能为空');
  if (!req.body.projectId) return res.cc(1, '项目id不能为空');
  if (!req.body.content) return res.cc(1, '内容不能为空');
  try {
    res.cc(0, '创建成功', await createSession(req.body, req.user));
  } catch (error) {
    res.cc(1, error.message);
  }
});

router.get('/session/list', authJWT, async (req, res) => {
  const { projectId, title } = req.query;
  if (!projectId) return res.cc(1, '项目id不能为空');
  try {
    res.cc(0, '获取成功', await getSessionList(projectId, title || undefined, req.user));
  } catch (error) {
    res.cc(1, error.message);
  }
});

router.get('/conversation/list', authJWT, async (req, res) => {
  const { projectId, keyword, page, pageSize } = req.query;
  if (!projectId) return res.cc(1, '项目id不能为空');
  try {
    res.cc(0, '获取成功', await getConversationList({ projectId, keyword, page, pageSize }, req.user));
  } catch (error) {
    res.cc(1, error.message);
  }
});

router.get('/conversation/:conversationId/messages', authJWT, async (req, res) => {
  if (!isNumericId(req.params.conversationId)) return res.cc(1, 'conversationId格式不正确');
  try {
    const result = await getConversationMessages({
      conversationId: req.params.conversationId,
      beforeId: req.query.beforeId,
      limit: req.query.limit,
    }, req.user);
    res.cc(0, '获取成功', result);
  } catch (error) {
    res.cc(1, error.message);
  }
});

router.patch('/conversation/:conversationId', authJWT, async (req, res) => {
  if (!isNumericId(req.params.conversationId)) return res.cc(1, 'conversationId格式不正确');
  if (!req.body.title?.trim()) return res.cc(1, '新标题不能为空');
  try {
    const result = await updateConversation({
      conversationId: req.params.conversationId,
      title: req.body.title,
    }, req.user);
    res.cc(0, '修改成功', result);
  } catch (error) {
    res.cc(1, error.message);
  }
});

router.delete('/conversation/:conversationId', authJWT, async (req, res) => {
  if (!isNumericId(req.params.conversationId)) return res.cc(1, 'conversationId格式不正确');
  try {
    const result = await deleteConversation(req.params.conversationId, req.user);
    contextCache.delete(String(req.params.conversationId));
    res.cc(0, '删除成功', result);
  } catch (error) {
    res.cc(1, error.message);
  }
});

router.patch('/session/update', authJWT, async (req, res) => {
  const { title, oldTitle, projectId } = req.body;
  if (!title) return res.cc(1, '新标题不能为空');
  if (!oldTitle) return res.cc(1, '旧标题不能为空');
  if (!projectId) return res.cc(1, '项目id不能为空');
  try {
    res.cc(0, '修改成功', await updateSession(req.body, req.user));
  } catch (error) {
    res.cc(1, error.message);
  }
});

router.post('/session/delete', authJWT, async (req, res) => {
  const { title, projectId } = req.body;
  if (!title) return res.cc(1, '标题不能为空');
  if (!projectId) return res.cc(1, '项目id不能为空');
  try {
    res.cc(0, '删除成功', await deleteSession(req.body, req.user));
  } catch (error) {
    res.cc(1, error.message);
  }
});

router.get('/session/detail', authJWT, async (req, res) => {
  if (!req.query.id) return res.cc(1, 'id不能为空');
  try {
    res.cc(0, '获取成功', await getSessionDetail(req.query.id));
  } catch (error) {
    res.cc(1, error.message);
  }
});

router.get('/conversation/stats', authJWT, async (req, res) => {
  const { conversationId, projectId, title } = req.query;
  if (!conversationId && (!projectId || !title)) {
    return res.cc(1, 'conversationId 或 projectId + title 不能为空');
  }
  try {
    res.cc(0, '获取成功', await getConversationStats({ conversationId, projectId, title }, req.user));
  } catch (error) {
    res.cc(1, error.message);
  }
});

export default router;
