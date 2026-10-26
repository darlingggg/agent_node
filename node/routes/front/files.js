import express from 'express';
import multer from 'multer';
import authJWT from '../../middleware/authJWT.js';
import {
  copyDir,
  deleteFileContent,
  deletePublicAsset,
  getFileContent,
  getFileMeta,
  getProjectTempFiles,
  importFilesToPublic,
  resolvePublicAssetFile,
  writeFileContent,
} from '../../file/index.js';
import { markProjectFileActivity } from '../../utils/activity.js';

const router = express.Router();
const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024, files: 20 },
});

export function parseStringList(raw, { preserveEmpty = false } = {}) {
  if (raw == null || raw === '') return [];
  let values = raw;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return [];
    if (text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text);
        values = Array.isArray(parsed) ? parsed : [text];
      } catch {
        values = [text];
      }
    } else {
      values = [text];
    }
  } else if (!Array.isArray(raw)) {
    values = [raw];
  }

  const normalized = values.map((item) => (item == null ? '' : String(item).trim()));
  return preserveEmpty ? normalized : normalized.filter(Boolean);
}

router.post('/file/copy', async (req, res) => {
  try {
    const { sourceDir, targetDir } = req.body;
    res.cc(0, '拷贝成功', await copyDir(sourceDir, targetDir));
  } catch (error) {
    res.cc(1, error.message);
  }
});

router.get('/files', async (req, res) => {
  try {
    res.cc(0, '获取成功', await getProjectTempFiles(req.query.dir));
  } catch (error) {
    res.cc(1, error.message);
  }
});

router.get('/file/content', async (req, res) => {
  try {
    const { dir, path: filePath } = req.query;
    if (!filePath) return res.cc(1, 'path 不能为空');
    res.cc(0, '获取成功', await getFileContent(filePath, dir));
  } catch (error) {
    res.cc(1, error.message);
  }
});

router.post('/file/write', async (req, res) => {
  try {
    const { dir, path: filePath, content = '' } = req.body;
    if (!filePath) return res.cc(1, 'path 不能为空');
    const result = await writeFileContent(filePath, content, dir);
    await markProjectFileActivity(dir);
    res.cc(0, '写入成功', result);
  } catch (error) {
    res.cc(1, error.message);
  }
});

router.post('/file/delete', async (req, res) => {
  const { dir, path: filePath } = req.body;
  if (!filePath) return res.cc(1, '文件路径不能为空');
  if (!dir) return res.cc(1, '项目根目录不能为空');
  try {
    const result = await deleteFileContent(filePath, dir);
    await markProjectFileActivity(dir);
    res.cc(0, '删除成功', result);
  } catch (error) {
    res.cc(1, error.message);
  }
});

router.post('/file/meta', async (req, res) => {
  const { dir, path: filePath } = req.body;
  if (!filePath) return res.cc(1, '文件路径不能为空');
  if (!dir) return res.cc(1, '项目根目录不能为空');
  try {
    res.cc(0, '获取成功', await getFileMeta(filePath, dir));
  } catch (error) {
    res.cc(1, error.message);
  }
});

router.post('/file/download', authJWT, memoryUpload.array('files', 20), async (req, res) => {
  try {
    const dirPath = req.body.dirPath;
    const urls = [...parseStringList(req.body.urls), ...parseStringList(req.body.url)];
    const files = Array.isArray(req.files) ? req.files : [];
    const saveNames = parseStringList(
      req.body.saveNames ?? req.body.fileNames ?? req.body.fileName,
      { preserveEmpty: true },
    );

    if (!dirPath) return res.cc(1, '项目根路径 dirPath 不能为空');
    if (urls.length === 0 && files.length === 0) {
      return res.cc(1, '请至少提供一个 url 或上传文件');
    }

    const result = await importFilesToPublic({
      dirPath,
      path: req.body.path ?? '/',
      urls,
      files,
      saveNames,
    });
    const failed = result.results.filter((item) => !item.success);
    if (failed.length === result.results.length) return res.cc(1, '全部文件处理失败', result);

    await markProjectFileActivity(dirPath);
    if (failed.length > 0) return res.cc(0, `部分成功，失败 ${failed.length} 个`, result);
    res.cc(0, '处理成功', result);
  } catch (error) {
    res.cc(1, error.message);
  }
});

router.post('/file/asset/delete', authJWT, async (req, res) => {
  try {
    const { dirPath, path: filePath } = req.body;
    if (!dirPath) return res.cc(1, '项目根路径 dirPath 不能为空');
    if (!filePath) return res.cc(1, '文件路径 path 不能为空');
    const result = await deletePublicAsset(filePath, dirPath);
    await markProjectFileActivity(dirPath);
    res.cc(0, '删除成功', result);
  } catch (error) {
    res.cc(1, error.message);
  }
});

router.get('/file/asset', authJWT, async (req, res) => {
  try {
    const { dirPath, path: filePath } = req.query;
    if (!dirPath) return res.cc(1, '项目根路径 dirPath 不能为空');
    if (!filePath) return res.cc(1, '文件路径 path 不能为空');
    const result = await resolvePublicAssetFile(String(filePath), String(dirPath));
    res.sendFile(result.path, (error) => {
      if (error && !res.headersSent) res.cc(1, error.message || '文件读取失败');
    });
  } catch (error) {
    res.cc(1, error.message);
  }
});

export default router;
