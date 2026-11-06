import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { fetchPageTool, searchWebTool } from '../node/openai/tools/web-tools.js';
import { key } from '../key.js';

let previousKey;
beforeEach(() => {
  previousKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'test-search-key';
});
afterEach(() => {
  if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = previousKey;
});

test('搜索使用独立鉴权和固定端点，并保留来源、摘要和发布时间', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/v1/tools/search');
    assert.equal(options.headers.Authorization, 'Bearer test-search-key');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(JSON.parse(options.body), {
      query: 'Node.js site:nodejs.org', count: 5, need_content: false,
    });
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({ results: [{
      title: 'Node.js', url: 'https://nodejs.org/', summary: '官方文档',
      snippet: '文档', date: '2026-10-26T00:00:00Z', site_name: 'Node.js',
      content: '搜索时不将全文带入上下文',
    }] });
  });
  const result = JSON.parse(await searchWebTool({ query: ' Node.js site:nodejs.org ' }));
  assert.equal(result.success, true);
  assert.deepEqual(result.data.results, [{
    title: 'Node.js', url: 'https://nodejs.org/', summary: '官方文档',
    snippet: '文档', date: '2026-10-26T00:00:00Z', siteName: 'Node.js',
  }]);
});

test('搜索无结果为成功，支持按 Unicode 字符校验搜索词', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(JSON.parse(options.body).query, '🎮'.repeat(128));
    return Response.json({ results: [] });
  });
  const result = JSON.parse(await searchWebTool({ query: '🎮'.repeat(128), count: 1 }));
  assert.equal(result.success, true);
  assert.deepEqual(result.data.results, []);
});

test('读取网页保留来源，并按字符截断 Markdown，不拆分 emoji', async (t) => {
  const content = '🎮'.repeat(1001);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/v1/tools/fetch');
    assert.deepEqual(JSON.parse(options.body), { url: 'https://example.com/article' });
    return Response.json({ title: '游戏', content });
  });
  const result = JSON.parse(await fetchPageTool({
    url: 'https://example.com/article', maxChars: 1000,
  }));
  assert.equal(result.success, true);
  assert.deepEqual(result.data, {
    url: 'https://example.com/article', title: '游戏', content: '🎮'.repeat(1000),
    truncated: true, originalLength: 1001,
  });
});

test('短网页全文返回，空标题合法', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ title: '', content: '# 正文' }));
  const result = JSON.parse(await fetchPageTool({ url: 'http://example.com' }));
  assert.equal(result.success, true);
  assert.equal(result.data.content, '# 正文');
  assert.equal(result.data.truncated, false);
});

test('无效搜索参数、网页地址和长度限制在发出请求前被拒绝', async (t) => {
  const request = t.mock.method(globalThis, 'fetch', async () => assert.fail('不应请求外部服务'));
  for (const args of [undefined, {}, { query: ' ' }, { query: 'a'.repeat(129) },
    { query: 'x', count: 0 }, { query: 'x', count: 11 }, { query: 'x', count: '5' }]) {
    assert.equal(JSON.parse(await searchWebTool(args)).success, false);
  }
  for (const args of [undefined, {}, { url: 'file:///etc/passwd' }, { url: 'not-a-url' },
    { url: 'https://user:password@example.com/' }, { url: 'https://example.com', maxChars: 999 },
    { url: 'https://example.com', maxChars: 50001 }, { url: 'https://example.com', maxChars: '1000' },
    { url: `https://example.com/${'a'.repeat(8192)}` }]) {
    assert.equal(JSON.parse(await fetchPageTool(args)).success, false);
  }
  assert.equal(request.mock.callCount(), 0);
});

test('未配置环境密钥时使用本地配置，配置均缺失时不发出请求', async (t) => {
  delete process.env.DEEPSEEK_API_KEY;
  const request = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.ok(Boolean(key), '没有可用密钥时不应发出请求');
    assert.ok(options.headers.Authorization === `Bearer ${key}`, '应使用本地配置中的密钥');
    return Response.json(url.endsWith('/search') ? { results: [] } : { title: '页面', content: '正文' });
  });
  for (const result of [
    await searchWebTool({ query: 'test' }),
    await fetchPageTool({ url: 'https://example.com/' }),
  ]) {
    const parsed = JSON.parse(result);
    assert.equal(parsed.success, Boolean(key));
    if (!key) assert.match(parsed.message, /DEEPSEEK_API_KEY/);
  }
  assert.equal(request.mock.callCount(), key ? 2 : 0);
});

test('HTTP 失败、无效响应与超时均不能误报成功，不暴露服务商原始错误', async (t) => {
  const cases = [
    () => new Response('secret-provider-error', { status: 401 }),
    () => new Response('secret-provider-error', { status: 429 }),
    () => new Response('secret-provider-error', { status: 503 }),
    () => new Response('not-json'),
    () => Response.json({}),
    () => Response.json({ results: [null] }),
    () => { throw new DOMException('timeout', 'TimeoutError'); },
  ];
  const request = t.mock.method(globalThis, 'fetch');
  for (const makeResponse of cases) {
    request.mock.mockImplementation(async () => makeResponse());
    const result = JSON.parse(await searchWebTool({ query: 'test' }));
    assert.equal(result.success, false);
    assert.equal(result.data, null);
    assert.doesNotMatch(result.message, /secret-provider-error/);
  }
  for (const body of [{ title: '页面' }, { title: '', content: ' ' }]) {
    request.mock.mockImplementation(async () => Response.json(body));
    assert.equal(JSON.parse(await fetchPageTool({ url: 'https://example.com/' })).success, false);
  }
});

test('取消正在执行的网页请求向上传递 AbortError，而非返回普通失败', async (t) => {
  const request = t.mock.method(globalThis, 'fetch', async (_url, { signal }) => {
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  for (const [tool, args] of [
    [searchWebTool, { query: 'test' }],
    [fetchPageTool, { url: 'https://example.com/' }],
  ]) {
    const controller = new AbortController();
    const pending = tool(args, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
  }
  assert.equal(request.mock.callCount(), 2);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(searchWebTool({ query: 'test' }, { signal: controller.signal }), {
    name: 'AbortError',
  });
  assert.equal(request.mock.callCount(), 2);
});
