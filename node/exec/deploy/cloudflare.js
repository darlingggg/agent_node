import { CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN } from '../../../key.js';

export const CF_PROJECT_NAME = 'gen-agent';

/**
 * 部署前读取 Pages 生产分支，确保 preview-p<项目ID> 不会被当成生产入口。
 * 通过则正常返回；配置不可读、分支冲突或查询超时则抛错，中止 pipeline。
 * 同时受外部构建取消信号与自身 10 秒查询期限控制，fetcher 可在测试中替换。
 */
export async function assertPreviewBranch(branch, { signal, fetcher = fetch } = {}) {
  const timeout = AbortSignal.timeout(10_000);
  const response = await fetcher(
    `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/pages/projects/${CF_PROJECT_NAME}`,
    { headers: { Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}` },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout },
  );
  if (!response.ok) throw new Error('无法读取 Cloudflare 项目配置，请检查部署凭据或网络');
  const payload = await response.json();
  if (!payload.success || !payload.result?.production_branch) {
    throw new Error('Cloudflare 未返回有效生产分支，已停止预览部署');
  }
  if (branch === payload.result.production_branch) {
    throw new Error('预览分支与 Cloudflare 生产分支冲突，请调整生产分支配置');
  }
}

/** 从 Wrangler 输出提取第一个 pages.dev 访问链接；找不到返回 null，由 pipeline 判失败。 */
export function extractDeployUrl(output) {
  const match = output.match(/https:\/\/[^\s]+\.pages\.dev/);
  return match ? match[0] : null;
}

/** 从部署列表 JSON 按链接匹配部署 ID，供正式发布记录和后续清理使用；无法匹配返回 null。 */
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
