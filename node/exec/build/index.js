import { createBuildService } from './service.js';
import { addSnapshot } from '../../snapshot.js';
import { buildProject, getProjectInfo } from '../../project.js';
import { markUserActive } from '../../utils/activity.js';
import { deleteOnlineVersion } from '../deploy/deployment.js';

export async function finalizePublication({ project, user, input, result, job, send }) {
  const current = await getProjectInfo(project.id, user);
  send({ event: 'step', data: { key: 'save', title: '保存发布记录', status: 'running' } });
  const version = `构建${job.id}`;
  const { id } = await addSnapshot(project.id, version, project.dir_path, '', user, 0,
    project.temp_version, input.directory);
  await buildProject(project.id, result.link, id, result.deploymentId);
  await markUserActive(user.id);
  send({ event: 'step', data: { key: 'save', title: '保存发布记录', status: 'done' } });
  if (current.cloudflare_id) {
    await deleteOnlineVersion(project.dir_path, current.cloudflare_id).catch((error) =>
      console.warn('[build] 清理旧部署失败:', error.message));
  }
}

export const projectBuilds = createBuildService({ publish: finalizePublication });
