export const CF_PROJECT_NAME = 'gen-agent';

export function extractDeployUrl(output) {
  const match = output.match(/https:\/\/[^\s]+\.pages\.dev/);
  return match ? match[0] : null;
}

export function extractDeploymentIdByLink(listOutput, link) {
  if (!listOutput || !link) return null;
  try {
    const deployments = JSON.parse(listOutput);
    if (!Array.isArray(deployments)) return null;
    const normalizedLink = link.replace(/\/$/, '');
    const matched = deployments.find((item) => {
      const deploymentUrl = (item.Deployment || item.deployment || '').replace(/\/$/, '');
      return deploymentUrl === normalizedLink;
    });
    return matched?.Id || matched?.id || null;
  } catch {
    return null;
  }
}
