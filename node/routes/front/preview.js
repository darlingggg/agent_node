import express from 'express';
import authJWT from '../../middleware/authJWT.js';
import { getProjectInfo } from '../../project.js';
import { projectBuilds } from '../../exec/build/index.js';

/** 创建兼容预览接口；默认使用共享构建服务，参数可替换以独立测试鉴权和提交行为。 */
export function createPreviewRouter({ builds = projectBuilds, authorize = authJWT, findProject = getProjectInfo } = {}) {
  const router = express.Router();

  /**
   * GET 只查询；POST 先提交更新，再返回当前状态，不等待构建部署完成。
   * findProject 校验所属账号并读取可信源码目录；force=true 允许手动重试相同版本的失败。
   * 前端根据 active/pending 继续轮询，成功链接放在 lastReady.result.link。
   */
  async function handle(req, res) {
    const projectId = Number(req.method === 'POST' ? req.body.projectId : req.query.projectId);
    if (!Number.isSafeInteger(projectId) || projectId < 1) return res.cc(1, '项目 id 无效');
    if (req.method === 'POST' && req.body.force !== undefined && typeof req.body.force !== 'boolean') {
      return res.cc(1, 'force 必须为布尔值');
    }
    try {
      const project = await findProject(projectId, req.user);
      if (req.method === 'POST') await builds.request(project, 'preview', req.user, { force: req.body.force === true });
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
