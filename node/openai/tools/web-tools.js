import { key } from "../../../key.js"

const SEARCH_BASE_URL = 'https://api.deepseek.com/v1/tools';
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CHARS = 20_000;

const returnJson = (data, success, message) => JSON.stringify({ success, message, data });

async function requestWebTool(endpoint, body, signal) {
  signal?.throwIfAborted();
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim() || key;
  if (!apiKey) throw new Error('请在服务端配置 DEEPSEEK_API_KEY');  

  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const response = await fetch(`${SEARCH_BASE_URL}/${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: requestSignal,
    redirect: 'error',
  });

  if (!response.ok) {
    const messages = {
      401: '搜索服务密钥无效',
      402: '搜索服务余额不足',
      403: '网页访问被搜索服务拒绝',
      404: '未获取到可用网页正文',
      429: '搜索服务请求过于频繁，请稍后重试',
    };
    throw new Error(messages[response.status] || `搜索服务请求失败（HTTP ${response.status}）`);
  }
  return response.json();
}

function toolFailure(error, signal, message) {
  // 用户取消必须继续抛出，由聊天循环收束为 cancelled，不能作为搜索失败继续回答。
  signal?.throwIfAborted();
  const reason = error.name === 'TimeoutError' ? '请求超时，请稍后重试' : error.message;
  return returnJson(null, false, `${message}: ${reason}`);
}

/** 使用独立搜索服务，供任意支持 Function Calling 的聊天模型调用。 */
export async function searchWebTool({ query, count = 5 } = {}, { signal } = {}) {
  try {
    if (typeof query !== 'string' || !query.trim() || [...query.trim()].length > 128) {
      throw new Error('query 必须为 1-128 个字符的搜索词');
    }
    if (!Number.isInteger(count) || count < 1 || count > 10) {
      throw new Error('count 必须为 1-10 的整数');
    }
    const normalizedQuery = query.trim();
    const response = await requestWebTool(
      'search',
      { query: normalizedQuery, count, need_content: false },
      signal,
    );
    if (!Array.isArray(response?.results) || response.results.some(
      (item) => !item || typeof item.title !== 'string' || typeof item.url !== 'string' ||
        typeof item.summary !== 'string',
    )) {
      throw new Error('搜索服务返回了无效结果');
    }
    const results = response.results.slice(0, count).map((item) => ({
      title: item.title,
      url: item.url,
      summary: item.summary,
      snippet: item.snippet,
      date: item.date,
      siteName: item.site_name,
    }));
    return returnJson(
      { query: normalizedQuery, results },
      true,
      results.length ? `找到 ${results.length} 条网页结果` : '未找到相关网页',
    );
  } catch (error) {
    return toolFailure(error, signal, '搜索网页失败');
  }
}

/** 通过服务商抓取网页，返回带来源 URL 的 Markdown 正文。 */
export async function fetchPageTool(
  { url, maxChars = DEFAULT_MAX_CHARS } = {},
  { signal } = {},
) {
  try {
    if (typeof url !== 'string' || !url.trim() || [...url.trim()].length > 8192) {
      throw new Error('url 必须为不超过 8192 个字符的 HTTP/HTTPS 地址');
    }
    const pageUrl = new URL(url.trim());
    if (!['http:', 'https:'].includes(pageUrl.protocol) || pageUrl.username || pageUrl.password) {
      throw new Error('url 仅支持不含用户名或密码的 HTTP/HTTPS 地址');
    }
    if (!Number.isInteger(maxChars) || maxChars < 1000 || maxChars > 50_000) {
      throw new Error('maxChars 必须为 1000-50000 的整数');
    }
    const response = await requestWebTool('fetch', { url: pageUrl.href }, signal);
    if (typeof response?.title !== 'string' || typeof response?.content !== 'string' ||
      !response.content.trim()) {
      throw new Error('搜索服务未返回有效网页正文');
    }
    const characters = Array.from(response.content);
    return returnJson({
      url: pageUrl.href,
      title: response.title,
      content: characters.slice(0, maxChars).join(''),
      truncated: characters.length > maxChars,
      originalLength: characters.length,
    }, true, '获取网页信息成功');
  } catch (error) {
    return toolFailure(error, signal, '获取网页信息失败');
  }
}
