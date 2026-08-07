import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parsePatch } from 'diff';
import { normalizePatchHunkCounts, upsertFileByPatch } from './index.js';

test('自动修正 hunk 行数并应用截图中的补丁', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-node-patch-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));

  const appPath = path.join(rootDir, 'src', 'App.vue');
  await fs.mkdir(path.dirname(appPath), { recursive: true });
  await fs.writeFile(appPath, [
    '        block',
    '          @click="initGame"',
    '        class="!bg-[#8f7a66] !text-white !border-none !py-2 !text-base"',
    '        >',
    '          新游戏',
    '        </van-button>',
    '      </div>',
    '    </div>',
  ].join('\n'));

  const patch = [
    '--- a/src/App.vue',
    '+++ b/src/App.vue',
    '@@ -1,7 +1,7 @@',
    '         block',
    '           @click="initGame"',
    '         class="!bg-[#8f7a66] !text-white !border-none !py-2 !text-base"',
    '         >',
    '-          新游戏',
    '+          重新开始',
    '         </van-button>',
    '       </div>',
    '     </div>',
  ].join('\n');

  await upsertFileByPatch(patch, rootDir);

  const updated = await fs.readFile(appPath, 'utf8');
  assert.match(updated, /重新开始/);
  assert.doesNotMatch(updated, /新游戏/);
});

test('能分别修正多文件补丁中的 hunk', () => {
  const patch = [
    '--- a/src/a.txt',
    '+++ b/src/a.txt',
    '@@ -1,1 +1,1 @@',
    '-old a',
    '+new a',
    ' context a',
    '--- a/src/b.txt',
    '+++ b/src/b.txt',
    '@@ -1,3 +1,3 @@',
    '-old b',
    '+new b',
  ].join('\n');

  const normalized = normalizePatchHunkCounts(patch);
  const parsed = parsePatch(normalized.patch);

  assert.equal(normalized.correctedHunks, 2);
  assert.equal(parsed.length, 2);
  assert.deepEqual(
    parsed.map((item) => [item.hunks[0].oldLines, item.hunks[0].newLines]),
    [[2, 2], [1, 1]],
  );
});

test('合法补丁保持不变', () => {
  const patch = [
    '--- /dev/null',
    '+++ b/src/new.txt',
    '@@ -0,0 +1,2 @@',
    '+first',
    '+second',
  ].join('\n');

  const normalized = normalizePatchHunkCounts(patch);

  assert.equal(normalized.correctedHunks, 0);
  assert.equal(normalized.patch, patch);
  assert.doesNotThrow(() => parsePatch(normalized.patch));
});

test('合法的单行 hunk 简写保持不变', () => {
  const patch = [
    '--- a/src/a.txt',
    '+++ b/src/a.txt',
    '@@ -1 +1 @@',
    '-old',
    '+new',
  ].join('\n');

  const normalized = normalizePatchHunkCounts(patch);

  assert.equal(normalized.correctedHunks, 0);
  assert.equal(normalized.patch, patch);
});

test('不会吞掉非法的 hunk 正文', () => {
  const patch = [
    '--- a/src/a.txt',
    '+++ b/src/a.txt',
    '@@ -1,1 +1,1 @@',
    '-old',
    '+new',
    'missing diff prefix',
  ].join('\n');

  assert.throws(() => normalizePatchHunkCounts(patch), /contained invalid line/);
});
