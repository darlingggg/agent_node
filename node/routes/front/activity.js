import express from 'express';
import authJWT from '../../middleware/authJWT.js';
import { addLog, getLogList } from '../../log/index.js';
import { addSnapshot, changeSnapshot, deleteSnapshot, getSnapshotList } from '../../snapshot/index.js';

const router = express.Router();

router.post('/log/add', authJWT, async (req, res) => {
  const { content, projectId, title } = req.body;
  if (!content) return res.cc(1, '日志内容不能为空');
  if (!projectId) return res.cc(1, '项目id不能为空');
  if (!title) return res.cc(1, '会话标题不能为空');
  try {
    res.cc(0, '添加成功', await addLog(content, projectId, title, req.user));
  } catch (error) {
    res.cc(1, error.message);
  }
});

router.get('/log/list', authJWT, async (req, res) => {
  const { projectId, title } = req.query;
  if (!projectId) return res.cc(1, '项目id不能为空');
  try {
    res.cc(0, '获取成功', await getLogList(projectId, title || undefined, req.user));
  } catch (error) {
    res.cc(1, error.message);
  }
});

router.post('/snapshot/add', authJWT, async (req, res) => {
  const { projectId, version, dirPath, desc } = req.body;
  if (!version) return res.cc(1, '版本号不能为空');
  if (!projectId) return res.cc(1, '关联项目不能为空');
  if (!dirPath) return res.cc(1, '项目根路径不能为空');
  try {
    res.cc(0, '添加成功', await addSnapshot(projectId, version, dirPath, desc, req.user));
  } catch (error) {
    res.cc(1, error.message);
  }
});

router.get('/snapshot/list', authJWT, async (req, res) => {
  if (!req.query.projectId) return res.cc(1, '项目id不能为空');
  try {
    res.cc(0, '获取成功', await getSnapshotList(req.query.projectId));
  } catch (error) {
    res.cc(1, error.message);
  }
});

router.post('/snapshot/delete', authJWT, async (req, res) => {
  const { projectId, version } = req.body;
  if (!projectId) return res.cc(1, '项目id不能为空');
  if (!version) return res.cc(1, '版本号不能为空');
  try {
    res.cc(0, '删除成功', await deleteSnapshot(projectId, version));
  } catch (error) {
    res.cc(1, error.message);
  }
});

router.patch('/snapshot/change', authJWT, async (req, res) => {
  const { projectId, version, oldVersion, desc } = req.body;
  if (!projectId) return res.cc(1, '项目id不能为空');
  if (!version) return res.cc(1, '版本号不能为空');
  if (!oldVersion) return res.cc(1, '旧版本号不能为空');
  if (version === oldVersion) return res.cc(1, '新旧版本号不能相同');
  try {
    res.cc(0, '修改成功', await changeSnapshot(projectId, version, oldVersion, desc));
  } catch (error) {
    res.cc(1, error.message);
  }
});

export default router;
