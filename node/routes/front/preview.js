import express from 'express';
import authJWT from '../../middleware/authJWT.js';
import { getProjectInfo } from '../../project.js';
import { projectBuilds } from '../../exec/build/index.js';

export function createPreviewRouter({ builds = projectBuilds, authorize = authJWT, findProject = getProjectInfo } = {}) {
  const router = express.Router();

  async function handle(req, res) {
    const projectId = Number(req.method === 'POST' ? req.body.projectId : req.query.projectId);
    if (!Number.isSafeInteger(projectId) || projectId < 1) return res.cc(1, '项目 id 无效');
    try {
      const project = await findProject(projectId, req.user);
      if (req.method === 'POST') await builds.request(project, 'preview', req.user);
      res.cc(0, '获取成功', await builds.previewState(projectId));
    } catch (error) {
      res.cc(1, error.message);
    }
  }

  router.get('/project/preview', authorize, handle);
  router.post('/project/preview', authorize, handle);
  return router;
}

export default createPreviewRouter();
