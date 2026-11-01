import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import sharp from 'sharp';
import { chat } from '../node/openai/chat.js';
import { client } from '../node/openai/client.js';
import { visionClient } from '../node/openai/media/image-desc.js';
import { buildModelMessages, createImageRuntime, imageObservationMessage, readImageContext, restoreImageHistory, uploadedImages } from '../node/openai/media/image-input.js';
import { countContextTokens, createUsageTracker } from '../node/openai/context/usage.js';
import { compressContext } from '../node/openai/context/context-compression.js';
import { resolveModelConfig } from '../node/models/config.js';
import { functionMap } from '../node/openai/tools/tool-handlers.js';
import connection from '../Mysql/index.js';
import { createUserChatSession, createStreamingAssistantSession, saveSessionImageContext } from '../node/session/records.js';
import { keepContext } from '../node/openai/context/history.js';

after(() => connection.end());

const model = (supportsVision) => ({ model: 'test-model', supportsVision, contextLimit: 128000 });
const chunks = (delta, usage) => (async function* () {
  yield { choices: [{ delta }] };
  if (usage) yield { choices: [], usage };
})();
const calls = (names) => names.map((name, index) => ({
  index, id: `call-${index}`, type: 'function', function: { name, arguments: JSON.stringify(name === 'view_image' ? { paths: ['sample.png'], question: '读取颜色' } : {}) },
}));
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vision-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('agent-vision-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  await sharp({ create: { width: 96, height: 64, channels: 3, background: '#ff0000' } }).png().toFile(path.join(root, 'sample.png'));
  return root;
}
function imageParts(request) {
  return request.messages.flatMap((item) => Array.isArray(item.content) ? item.content.filter((part) => part.type === 'image_url') : []);
}

test('模型只根据 input_modalities 的 image 判断，内部标志不进入请求参数', () => {
  for (const value of [undefined, null, 'image', [], ['text']]) {
    assert.equal(resolveModelConfig({ model_key: 'a', capabilities: { input_modalities: value, output_modalities: ['image'] } }).supportsVision, false);
  }
  assert.equal(resolveModelConfig({ model_key: 'a', capabilities: JSON.stringify({ input_modalities: ['text', 'image'] }) }).supportsVision, true);
});

test('原生中途看图：全批 tool 配对后附图，可再次看图且外接服务零调用', async (t) => {
  const root = await fixture(t);
  const external = t.mock.method(visionClient.chat.completions, 'create', () => assert.fail('原生不能调用外接'));
  t.mock.method(functionMap, 'get_file_list', async () => '{"success":true}');
  const requests = [];
  t.mock.method(client.chat.completions, 'create', async (request) => {
    requests.push(request);
    assert.equal(request.model, 'test-model');
    assert.equal(Object.hasOwn(request, 'supportsVision'), false);
    if (requests.length === 1) return chunks({ tool_calls: calls(['view_image', 'get_file_list']) });
    const previous = request.messages.findLastIndex((item) => item.tool_calls);
    const count = requests.length === 2 ? 2 : 1;
    assert.ok(request.messages.slice(previous + 1, previous + 1 + count).every((item) => item.role === 'tool'));
    assert.equal(request.messages[previous + 1 + count].role, 'user');
    const result = JSON.parse(request.messages[previous + 1].content);
    assert.equal(result.data.mode, 'native');
    assert.equal(result.data.analysis, undefined);
    assert.equal(imageParts(request).length, 1);
    assert.match(imageParts(request)[0].image_url.url, /^data:image\/webp;base64,/);
    if (requests.length === 2) return chunks({ tool_calls: calls(['view_image']) });
    return chunks({ content: '红色' });
  });
  const context = [{ role: 'system', content: '' }];
  const saved = [];
  const events = [];
  await chat('检查图片颜色', (event) => events.push(event), context, root, [], '', {
    modelConfig: model(true), assistantSessionId: 9, toolContext: { persistImageContext: async (value) => saved.push(value) },
  });
  assert.equal(requests.length, 3);
  assert.equal(external.mock.callCount(), 0);
  assert.equal(saved.at(-1).observations.length, 2);
  assert.equal(saved.at(-1).images.length, 1);
  assert.doesNotMatch(JSON.stringify(saved), /base64/);
  assert.equal(events.filter((item) => item.event === 'tool_end' && item.data.name === 'view_image').length, 2);
});

test('首次原生附图无需工具；恢复为文本模型时只保留引用与分析', async (t) => {
  const root = await fixture(t);
  const runtime = createImageRuntime([], root);
  const images = await runtime.resolve({ paths: ['sample.png'] });
  t.mock.method(visionClient.chat.completions, 'create', () => assert.fail('不应外接分析'));
  t.mock.method(client.chat.completions, 'create', async (request) => {
    assert.equal(imageParts(request).length, 1);
    return chunks({ content: '红色' });
  });
  const context = [{ role: 'system', content: '' }];
  await chat('', () => {}, context, root, [], '', { modelConfig: model(true), images });
  const restored = restoreImageHistory([{ id: 1, role: 'user', content: '参考图', image_context: JSON.stringify({ images }) }]);
  assert.equal(imageParts({ messages: await buildModelMessages(restored, model(false), runtime) }).length, 0);
  assert.equal(imageParts({ messages: await buildModelMessages(restored, model(true), runtime) }).length, 1);
});

test('外接工具返回文字、计入 usage，按需识图且不向文本模型发送图片', async (t) => {
  const root = await fixture(t);
  const runtime = createImageRuntime([], root);
  const images = await runtime.resolve({ paths: ['sample.png'] });
  const external = t.mock.method(visionClient.chat.completions, 'create', async (request) => {
    assert.match(request.messages[1].content[0].image_url.url, /^data:image/);
    assert.doesNotMatch(request.messages[1].content.at(-1).text, /base64/);
    return chunks({ content: '红色矩形' }, { prompt_tokens: 10, completion_tokens: 4 });
  });
  let count = 0;
  t.mock.method(client.chat.completions, 'create', async (request) => {
    count++;
    assert.equal(imageParts(request).length, 0);
    if (count === 1) {
      assert.equal(request.tool_choice, 'auto');
      return chunks({ tool_calls: calls(['view_image']) }, { prompt_tokens: 2, completion_tokens: 1 });
    }
    assert.equal(request.tool_choice, 'auto');
    const result = JSON.parse(request.messages.find((item) => item.role === 'tool').content);
    assert.equal(result.data.analysis, '红色矩形');
    return chunks({ content: '是红色' }, { prompt_tokens: 3, completion_tokens: 1 });
  });
  const usage = await chat('检查参考图', () => {}, [{ role: 'system', content: '' }], root, [], '', { modelConfig: model(false), images });
  assert.equal(external.mock.callCount(), 1);
  assert.equal(usage.modelCalls, 3);
  assert.equal(usage.totalTokens, 21);
});

test('错误、越界、伪图片和取消不被当作成功识图', async (t) => {
  const root = await fixture(t);
  const runtime = createImageRuntime([], root);
  const binaryRead = JSON.parse(await functionMap.get_file_content({ path: 'sample.png', dirPath: root }));
  assert.equal(binaryRead.success, false);
  assert.match(binaryRead.message, /view_image/);
  await assert.rejects(runtime.resolve({ paths: ['sample.png'], imageIds: ['unknown'] }), /恰好/);
  await assert.rejects(runtime.resolve({ paths: ['../outside.png'] }));
  await assert.rejects(runtime.resolve({ imageIds: ['unknown'] }), /不存在/);
  await fs.writeFile(path.join(root, 'fake.png'), '<svg/>');
  const fake = await functionMap.view_image({ paths: ['fake.png'], question: '查看图片' }, { images: runtime, modelConfig: model(true) });
  assert.equal(JSON.parse(fake.modelContent).success, false);
  assert.equal(fake.observation, undefined);
  const controller = new AbortController();
  controller.abort();
  const cancelled = await functionMap.view_image({ paths: ['sample.png'], question: '查看' }, {
    images: createImageRuntime([], root, { signal: controller.signal }), modelConfig: model(true), signal: controller.signal,
  });
  assert.equal(JSON.parse(cancelled.modelContent).success, false);
  assert.throws(() => uploadedImages(['https://example.com/x.png'], 'user'), /当前账号/);
});

test('压缩保留图片引用且不传 Base64，工具附图不计为真实用户轮次', async (t) => {
  const image = { imageId: 'img_test', source: 'project_file', path: 'sample.png', version: 'v1' };
  const context = [{ role: 'system', content: '' }, { role: 'user', content: '任务', _images: [image], _imageInput: true, _sessionId: 1 }];
  for (let index = 0; index < 6; index++) context.push(imageObservationMessage({ images: [image], question: '细节' }, 2));
  const create = t.mock.method(client.chat.completions, 'create', () => assert.fail('只有一个用户轮次无需压缩'));
  await compressContext(context, createUsageTracker(context), undefined, () => {}, { ...model(true), contextLimit: 4096 });
  assert.equal(create.mock.callCount(), 0);
  for (let index = 0; index < 4; index++) context.push({ role: 'user', content: '下一轮'.repeat(300), _sessionId: index + 3 });
  context[1].content = [{ type: 'image_url', image_url: { url: 'data:image/png;base64,SECRET_IMAGE_BYTES' } }];
  create.mock.mockImplementation(async (request) => {
    assert.doesNotMatch(JSON.stringify(request.messages), /SECRET_IMAGE_BYTES/);
    assert.match(request.messages[1].content, /img_test/);
    return { choices: [{ message: { content: '参考图片 img_test，细节需重新查看' } }] };
  });
  await compressContext(context, createUsageTracker(context), undefined, () => {}, { ...model(true), contextLimit: 4096 });
  assert.equal(context[1]._images[0].imageId, 'img_test');
  const small = countContextTokens([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }]);
  const large = countContextTokens([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x'.repeat(100000) } }] }]);
  assert.equal(small, large);
  assert.deepEqual(readImageContext(null), { images: [], observations: [] });
});

test('真实 MySQL 临时表：图片与观察持久化、缓存清除恢复、摘要后仍可取回引用', {
  skip: process.env.AI_MODELS_DB_TEST !== '1',
}, async (t) => {
  const db = await connection.getConnection();
  try {
    for (const table of ['sessions', 'messages']) {
      const [[schema]] = await db.query(`SHOW CREATE TABLE ${table}`);
      await db.query(schema['Create Table'].replace('CREATE TABLE', 'CREATE TEMPORARY TABLE'));
    }
    const query = t.mock.method(connection, 'query', (...args) => db.query(...args));
    const user = { account: 'vision-test-only' };
    const image = { imageId: 'img_saved', source: 'project_file', path: 'sample.png', version: 'v1' };
    const config = { title: '视觉测试', projectId: 9999, conversationId: 9999, model: 'test', reasoningEffort: null };
    await createUserChatSession({ ...config, content: '看图', images: [image] }, user);
    const assistant = await createStreamingAssistantSession(config, user);
    await saveSessionImageContext(assistant.sessionId, { images: [image], observations: [{ images: [image], question: '颜色', mode: 'external', analysis: '红色', sourceToolCallId: 'call_original' }] }, user);
    await saveSessionImageContext(assistant.sessionId, {}, { account: 'wrong-owner' });
    const { result } = await keepContext(user.account, 9999, config.title, 9999, 0);
    const restored = restoreImageHistory(result);
    assert.equal(restored[0]._images[0].imageId, 'img_saved');
    assert.equal(restored.at(-1)._origin, 'tool_attachment');
    assert.match(restored.at(-1).content, /红色/);
    const { archivedImages } = await keepContext(user.account, 9999, config.title, 9999, assistant.sessionId);
    assert.equal(archivedImages.length, 1);
    assert.equal(archivedImages[0].imageId, 'img_saved');
    query.mock.restore();
  } finally {
    db.release();
  }
});
