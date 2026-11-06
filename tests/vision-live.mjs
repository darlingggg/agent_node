// 显式手工运行：VISION_LIVE_TEST=1 VISION_MAX_TOKENS=128 node tests/vision-live.mjs。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import connection from '../Mysql/index.js';
import { client } from '../node/openai/client.js';
import { chat } from '../node/openai/chat.js';
import { selectChatModel } from '../node/models/service.js';
import { functionMap } from '../node/openai/tools/tool-handlers.js';
import { createImageRuntime } from '../node/openai/media/image-input.js';

if (process.env.VISION_LIVE_TEST !== '1') {
  await connection.end();
  console.log('跳过真实视觉 API 测试；显式设置 VISION_LIVE_TEST=1 才会发送请求');
  process.exit(0);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vision-live-'));
const originalCreate = client.chat.completions.create.bind(client.chat.completions);
let requests = 0;
try {
  // 两种颜色，需真实图片才能回答；没有生产图片或代码文件。
  const left = await sharp({ create: { width: 48, height: 64, channels: 3, background: '#ff0000' } }).png().toBuffer();
  const right = await sharp({ create: { width: 48, height: 64, channels: 3, background: '#0000ff' } }).png().toBuffer();
  await sharp({ create: { width: 96, height: 64, channels: 3, background: '#ffffff' } })
    .composite([{ input: left, left: 0, top: 0 }, { input: right, left: 48, top: 0 }]).png().toFile(path.join(root, 'sample.png'));
  const config = await selectChatModel({ model: 'deepseek-flash', reasoningEffort: 'low' });
  assert.equal(config.supportsVision, true);
  const events = [];
  client.chat.completions.create = (request, options) => {
    assert.ok(++requests <= 2, '禁止额外真实主模型请求');
    const messages = request.messages.map((message, index) => index === 0
      ? { role: 'system', content: '这是最小识图测试，只查看 sample.png，不操作任何文件。工具完成后只回答左右颜色。' } : message);
    const images = messages.flatMap((item) => Array.isArray(item.content) ? item.content.filter((part) => part.type === 'image_url') : []);
    assert.equal(images.length, requests === 1 ? 0 : 1);
    return originalCreate({ ...request, messages,
      tools: request.tools.filter((tool) => tool.function.name === 'view_image'),
      tool_choice: 'auto',
      max_tokens: 512,
    }, options);
  };
  const signal = AbortSignal.timeout(60_000);
  const usage = await chat('请调用 view_image，paths 为 ["sample.png"]，question 为“只说明左半边和右半边分别是什么颜色”。然后只回答左右颜色。',
    (event) => events.push(event), [{ role: 'system', content: '' }], root, [], '', { modelConfig: config, signal });
  const nativeText = events.filter((item) => item.event === 'text').map((item) => item.data).join('');
  assert.match(nativeText, /红/);
  assert.match(nativeText, /蓝/);
  assert.equal(events.find((item) => item.event === 'tool_end')?.data.result.data.mode, 'native');
  console.log(JSON.stringify({ native: { model: config.model, requests, text: nativeText, totalTokens: usage.totalTokens } }));

  const external = await functionMap.view_image({ paths: ['sample.png'], question: '只回答左半边和右半边分别是什么颜色，不要添加其他分析。' }, {
    images: createImageRuntime([], root, { signal }), modelConfig: { supportsVision: false }, signal, toolCallId: 'live-external',
  });
  const parsed = JSON.parse(external.modelContent);
  assert.equal(parsed.success, true, parsed.message);
  assert.equal(parsed.data.mode, 'external');
  assert.match(parsed.data.analysis, /红/);
  assert.match(parsed.data.analysis, /蓝/);
  console.log(JSON.stringify({ external: { requests: 1, text: parsed.data.analysis, usage: external.usage?.usage } }));
} catch (error) {
  console.error('视觉最小真实测试失败：', error.message);
  process.exitCode = 1;
} finally {
  client.chat.completions.create = originalCreate;
  await connection.end();
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('agent-vision-live-'));
  await fs.rm(root, { recursive: true, force: true });
}
