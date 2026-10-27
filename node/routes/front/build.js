import express from 'express';
import authJWT from '../../middleware/authJWT.js';
import { getProjectInfo } from '../../project.js';
import { projectBuilds } from '../../exec/build/index.js';
import { prepareSse, writeSse } from './sse.js';

export function createBuildRouter({ builds = projectBuilds, authorize = authJWT, findProject = getProjectInfo } = {}) {
  const router = express.Router();
  router.post('/project/build', authorize, async (req, res) => {
    const projectId = Number(req.body.projectId);
    if (!Number.isSafeInteger(projectId) || projectId < 1) return res.cc(1, '项目 id 无效');
    let project;
    try {
      project = await findProject(projectId, req.user);
    } catch (error) {
      return res.cc(1, error.message);
    }

    prepareSse(res);
    let clientClosed = false;
    let unsubscribe = () => {};
    let job;
    const send = (event) => {
      if (!clientClosed) writeSse(res, event);
    };
    const heartbeat = setInterval(() => {
      if (!clientClosed) res.write(': heartbeat\n\n');
    }, 15_000);
    res.on('close', () => {
      clientClosed = true;
      unsubscribe();
      clearInterval(heartbeat);
    });

    try {
      job = await builds.request(project, 'publish', req.user);
      if (!clientClosed) unsubscribe = builds.scheduler.subscribe(job, send);
      await job.completion;
    } catch (error) {
      if (!job) send({ event: 'error', data: error.message });
    } finally {
      unsubscribe();
      clearInterval(heartbeat);
      if (!clientClosed) res.end();
    }
  });
  return router;
}

export default createBuildRouter();
