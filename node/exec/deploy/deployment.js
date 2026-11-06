import { CF_PROJECT_NAME } from './cloudflare.js';
import { runWrangler } from '../process-runner.js';

export async function deleteOnlineVersion(projectPath, deploymentId) {
  return runWrangler(
    ['pages', 'deployment', 'delete', deploymentId, `--project-name=${CF_PROJECT_NAME}`, '--force'],
    projectPath,
  );
}
