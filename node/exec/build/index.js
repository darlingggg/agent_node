import { createBuildService } from './service.js';
import { addSnapshot } from '../../snapshot.js';
import { buildProject, getProjectInfo } from '../../project.js';
import { markUserActive } from '../../utils/activity.js';
import { deleteOnlineVersion } from '../deploy/deployment.js';

/**
 * 仅正式发布在部署成功后调用：从同一输入副本创建快照、更新正式链接并清理旧部署。
 * 仍处于 job.run 内，保存完成前不会将任务标为 ready；预览跳过此步骤。
 * result 是 pipeline 的部署结果，job.id 用于快照名称，send 用于报告保存进度。
 */
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

// 模块加载时组装一次；预览、发布接口共用同一服务及调度器，保证全局只有一个构建执行槽。
export const projectBuilds = createBuildService({ publish: finalizePublication });
