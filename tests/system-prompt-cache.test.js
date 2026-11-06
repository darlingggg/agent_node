import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildSystemPrompt } from '../node/openai/prompt/prompt.js';

async function createProject(t, skills) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentnode-prompt-cache-'));
  t.after(async () => {
    // 仅清理由本测试创建、位于临时目录中的独立项目。
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('agentnode-prompt-cache-'));
    await fsp.rm(root, { recursive: true, force: true });
  });
  const promptPath = path.join(root, 'agent_base', 'skills', 'system-prompt.md');
  if (skills !== undefined) {
    await fsp.mkdir(path.dirname(promptPath), { recursive: true });
    await fsp.writeFile(promptPath, skills);
  }
  return { root, promptPath };
}

test('固定提示词首次读取后复用，开关切换不再访问文件系统', async (t) => {
  const { root, promptPath } = await createProject(t, '项目固定规则 CACHE_ORIGINAL');
  const disabled = buildSystemPrompt(root, false);
  await fsp.writeFile(promptPath, '项目规则已修改 CACHE_UPDATED');
  const exists = t.mock.method(fs, 'existsSync', () => assert.fail('缓存命中时不应检查文件'));
  const read = t.mock.method(fs, 'readFileSync', () => assert.fail('缓存命中时不应重新读取文件'));

  const enabled = buildSystemPrompt(root, true);
  const disabledAgain = buildSystemPrompt(path.join(root, '.') + path.sep, false);
  assert.match(disabled, /联网搜索未开启/);
  assert.match(enabled, /联网搜索已开启/);
  assert.match(enabled, /CACHE_ORIGINAL/);
  assert.doesNotMatch(enabled, /CACHE_UPDATED/);
  assert.equal(enabled.split('# 当前联网搜索状态')[0], disabled.split('# 当前联网搜索状态')[0]);
  assert.equal(disabledAgain, disabled);
  assert.equal(exists.mock.callCount(), 0);
  assert.equal(read.mock.callCount(), 0);
});

test('不同项目固定规则独立缓存，联网状态仍按本次调用拼接', async (t) => {
  const first = await createProject(t, '规则 PROJECT_ALPHA');
  const second = await createProject(t, '规则 PROJECT_BETA');
  const firstPrompt = buildSystemPrompt(first.root, true);
  const secondPrompt = buildSystemPrompt(second.root, false);
  assert.match(firstPrompt, /PROJECT_ALPHA/);
  assert.doesNotMatch(firstPrompt, /PROJECT_BETA/);
  assert.match(secondPrompt, /PROJECT_BETA/);
  assert.doesNotMatch(secondPrompt, /PROJECT_ALPHA/);
  assert.match(buildSystemPrompt(first.root, false), /联网搜索未开启/);
  assert.match(buildSystemPrompt(second.root, true), /联网搜索已开启/);
});

test('项目缺少提示词时缓存默认规则，后续不重新探测新文件', async (t) => {
  const { root, promptPath } = await createProject(t);
  const first = buildSystemPrompt(root);
  await fsp.mkdir(path.dirname(promptPath), { recursive: true });
  await fsp.writeFile(promptPath, '后来新增的规则 LATE_PROMPT');
  const later = buildSystemPrompt(root, true);
  assert.doesNotMatch(later, /LATE_PROMPT/);
  assert.equal(later.split('# 当前联网搜索状态')[0], first.split('# 当前联网搜索状态')[0]);
  assert.match(later, /联网搜索已开启/);
});
