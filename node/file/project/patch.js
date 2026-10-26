import fs from 'fs/promises';
import path from 'path';
import { applyPatch, parsePatch } from 'diff';
import {
  assertWithinRoot,
  isProtectedPublicAsset,
  isUnderAgentBase,
  isUnderPublic,
  isUnderSrc,
  resolveRootDir,
  resolveTargetPath,
  touchProjectUpdateTime,
} from './path-utils.js';

const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const MAX_PATCH_HUNK_LINES = 120;
const MAX_PATCH_CHANGE_RATIO = 0.4;

function isPatchBoundary(lines, index) {
  const line = lines[index];
  if (/^@@\s/.test(line) || /^(?:diff --git |Index:|={3,}$)/.test(line)) return true;
  return (
    /^---\s/.test(line) &&
    /^\+\+\+\s/.test(lines[index + 1] || '') &&
    /^@@\s/.test(lines[index + 2] || '')
  );
}

export function normalizePatchHunkCounts(patch) {
  if (typeof patch !== 'string' || !patch.trim()) throw new Error('patch 不能为空');
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  let correctedHunks = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index].match(HUNK_HEADER_PATTERN);
    if (!header) continue;
    let oldLines = 0;
    let newLines = 0;
    for (let bodyIndex = index + 1; bodyIndex < lines.length; bodyIndex += 1) {
      if (isPatchBoundary(lines, bodyIndex)) break;
      const line = lines[bodyIndex];
      if (line === '' && bodyIndex === lines.length - 1) break;
      const operation = line === '' ? ' ' : line[0];
      if (operation === ' ') {
        oldLines += 1;
        newLines += 1;
      } else if (operation === '-') {
        oldLines += 1;
      } else if (operation === '+') {
        newLines += 1;
      } else if (operation !== '\\') {
        throw new Error(`Hunk at line ${index + 1} contained invalid line ${line}`);
      }
    }

    const declaredOldLines = header[2] === undefined ? 1 : Number(header[2]);
    const declaredNewLines = header[4] === undefined ? 1 : Number(header[4]);
    if (declaredOldLines !== oldLines || declaredNewLines !== newLines) {
      lines[index] = `@@ -${header[1]},${oldLines} +${header[3]},${newLines} @@${header[5]}`;
      correctedHunks += 1;
    }
  }
  return { patch: lines.join('\n'), correctedHunks };
}

function countTextLines(text) {
  if (!text) return 0;
  const lines = text.split(/\r\n|\n|\r/);
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

function assertPatchSize(patchItem, oldText, relativePath, isCreate, isDelete) {
  if (isCreate || isDelete) return;
  let addedLines = 0;
  let removedLines = 0;
  let largestHunkLines = 0;
  for (const hunk of patchItem.hunks) {
    largestHunkLines = Math.max(
      largestHunkLines,
      hunk.lines.filter((line) => !line.startsWith('\\')).length,
    );
    for (const line of hunk.lines) {
      if (line.startsWith('+')) addedLines += 1;
      if (line.startsWith('-')) removedLines += 1;
    }
  }

  const sourceLines = countTextLines(oldText);
  const changedLines = Math.max(addedLines, removedLines);
  const changeRatio = sourceLines === 0 ? 0 : changedLines / sourceLines;
  if (changeRatio >= MAX_PATCH_CHANGE_RATIO) {
    const percent = Math.round(changeRatio * 100);
    throw new Error(
      `PATCH_TOO_LARGE: ${relativePath} 预计变更 ${percent}%（${changedLines}/${sourceLines} 行），` +
        `达到 ${MAX_PATCH_CHANGE_RATIO * 100}% 全量写入阈值；请改用 write_file_content 并传入完整文件内容`,
    );
  }
  if (largestHunkLines > MAX_PATCH_HUNK_LINES) {
    throw new Error(
      `HUNK_TOO_LARGE: ${relativePath} 的单个 hunk 包含 ${largestHunkLines} 行，` +
        `超过 ${MAX_PATCH_HUNK_LINES} 行限制；请拆成多个小 hunk，每个仅保留 3-5 行上下文`,
    );
  }
}

export async function upsertFileByPatch(patch, dirPath) {
  const rootDir = resolveRootDir(dirPath);
  const patches = parsePatch(normalizePatchHunkCounts(patch).patch);
  const results = [];
  for (const patchItem of patches) {
    const isCreate = patchItem.oldFileName === '/dev/null';
    const isDelete = patchItem.newFileName === '/dev/null';
    const fileName = isDelete ? patchItem.oldFileName : patchItem.newFileName;
    if (!fileName || fileName === '/dev/null') throw new Error('patch 缺少有效文件路径');

    const relativePath = fileName.replace(/^a[\\/]/, '').replace(/^b[\\/]/, '');
    const fullPath = resolveTargetPath(relativePath, rootDir);
    assertWithinRoot(fullPath, rootDir);
    if (isUnderAgentBase(fullPath, rootDir)) {
      throw new Error('不允许修改 agent_base 项目底座下的文件');
    }
    if (
      (isCreate || isDelete) &&
      !isUnderSrc(fullPath, rootDir) &&
      !isUnderPublic(fullPath, rootDir)
    ) {
      throw new Error('新增或删除文件仅允许在 src 或 public 目录下进行');
    }

    if (isCreate) {
      try {
        await fs.access(fullPath);
        throw new Error('目标文件已存在，无法按新增文件 patch 覆盖');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }

    const oldText = isCreate ? '' : await fs.readFile(fullPath, 'utf-8');
    assertPatchSize(patchItem, oldText, relativePath, isCreate, isDelete);
    const newText = applyPatch(oldText, patchItem, {
      autoConvertLineEndings: true,
      fuzzFactor: 1,
    });
    if (newText === false) throw new Error(`patch 应用失败: ${relativePath}`);

    if (isCreate) {
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, newText, 'utf-8');
    } else if (isDelete) {
      if (isProtectedPublicAsset(fullPath, rootDir)) {
        throw new Error('不允许删除 public/favicon.ico，可通过上传同名文件替换');
      }
      await fs.unlink(fullPath);
    } else {
      await fs.writeFile(fullPath, newText, 'utf-8');
    }
    await touchProjectUpdateTime(rootDir);
    console.log(`${relativePath} 增量更新成功`);
    results.push({
      path: fullPath,
      relativePath: path.relative(rootDir, fullPath),
      action: isCreate ? 'create' : isDelete ? 'delete' : 'update',
    });
  }
  return results;
}
