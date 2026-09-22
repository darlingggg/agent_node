import path from 'path';
import { acquireBuildSlot } from './build-queue.js';
import { formatDuration, runBuildStep, trimOutput } from './build-step.js';
import {
  CF_PROJECT_NAME,
  extractDeploymentIdByLink,
  extractDeployUrl,
} from './cloudflare.js';
import {
  BUILD_TIMEOUT_MS,
  DEPLOY_TIMEOUT_MS,
  INSTALL_TIMEOUT_MS,
  runPnpm,
  runWrangler,
} from './process-runner.js';

export async function buildCommand(projectPath, send = () => {}) {
  const releaseBuildSlot = await acquireBuildSlot(projectPath, send);
  try {
    const startedAt = Date.now();
    const distPath = path.join(projectPath, 'dist');
    const deployArgs = ['pages', 'deploy', distPath, `--project-name=${CF_PROJECT_NAME}`];
    const deploymentListArgs = [
      'pages',
      'deployment',
      'list',
      `--project-name=${CF_PROJECT_NAME}`,
      '--json',
    ];

    send({
      event: 'step',
      data: {
        key: 'prepare',
        title: '准备构建',
        status: 'running',
        message: '正在初始化构建环境...',
        projectPath,
        projectName: CF_PROJECT_NAME,
      },
    });

    const installArgs = [
      'install',
      '--no-frozen-lockfile',
      '--prefer-offline',
      '--child-concurrency=1',
      '--network-concurrency=4',
      '--config.optional=true',
      '--config.confirmModulesPurge=false',
    ];
    const installResult = await runBuildStep({
      key: 'install',
      title: '安装依赖',
      command: `pnpm ${installArgs.join(' ')}`,
      execute: () => runPnpm(installArgs, projectPath, INSTALL_TIMEOUT_MS),
      send,
    });
    const buildResult = await runBuildStep({
      key: 'build',
      title: '构建项目',
      command: 'pnpm build',
      execute: () => runPnpm(['build'], projectPath, BUILD_TIMEOUT_MS),
      send,
    });
    const deployResult = await runBuildStep({
      key: 'deploy',
      title: '部署上线',
      command: `wrangler ${deployArgs.join(' ')}`,
      execute: () => runWrangler(deployArgs, projectPath, DEPLOY_TIMEOUT_MS),
      send,
    });

    const link = extractDeployUrl(deployResult.stdout);
    let deploymentId = null;
    if (link) {
      const listResult = await runWrangler(deploymentListArgs, projectPath);
      if (listResult.success) {
        deploymentId = extractDeploymentIdByLink(listResult.stdout, link);
      }
    }

    const duration = Date.now() - startedAt;
    const result = {
      success: true,
      code: 0,
      summary: link
        ? `部署成功，项目已上线（总耗时 ${formatDuration(duration)}）`
        : `部署命令已执行，但未解析到访问链接（总耗时 ${formatDuration(duration)}）`,
      link,
      deploymentId,
      projectName: CF_PROJECT_NAME,
      projectPath,
      distPath,
      completedAt: new Date().toISOString(),
      duration,
      durationText: formatDuration(duration),
      steps: [installResult.step, buildResult.step, deployResult.step],
      deploy: {
        url: link,
        deploymentId,
        projectName: CF_PROJECT_NAME,
        stdout: trimOutput(deployResult.stdout),
        stderr: trimOutput(deployResult.stderr),
      },
    };
    send({ event: 'done', data: result });
    return result;
  } finally {
    releaseBuildSlot();
  }
}

export async function deleteOnlineVersion(projectPath, deploymentId) {
  return runWrangler([
    'pages',
    'deployment',
    'delete',
    deploymentId,
    `--project-name=${CF_PROJECT_NAME}`,
    '--force',
  ], projectPath);
}
