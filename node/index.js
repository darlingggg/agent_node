import express from 'express';
import cors from 'cors';
import connection from '../Mysql/index.js';
import resCC from './middleware/resCC.js';
import { getProjectTempFiles, getFileContent, writeFileContent } from '../file/index.js';

/** 默认服务端口 */
const PORT = 3000;

/** 创建 Express 应用实例 */
const app = express();

// 接口返回 JSON，关闭 ETag 避免浏览器缓存导致 304
app.set('etag', false);

// 开启跨域支持，允许所有来源（开发环境）
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// 解析 JSON 和表单请求体
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 统一响应结构中间件
app.use(resCC);

/** 健康检查接口 */
app.get('/', (req, res) => {
  res.cc(0, 'Express 服务运行正常');
});

/** 查询用户列表 */
app.get('/users', async (req, res) => {
  try {
    const [rows] = await connection.query('SELECT * FROM users');
    res.cc(0, '获取成功', rows);
  } catch (err) {
    res.cc(1, err.message);
  }
});

/** 获取文件目录，dir 为项目根目录 */
app.get('/files', async (req, res) => {
  try {
    const { dir } = req.query;
    const files = await getProjectTempFiles(dir);
    res.cc(0, '获取成功', files);
  } catch (err) {
    res.cc(1, err.message);
  }
});

/** 获取文件内容，dir 为项目根目录，path 为文件路径 */
app.get('/file/content', async (req, res) => {
  try {
    const { dir, path: filePath } = req.query;
    if (!filePath) {
      res.cc(1, 'path 不能为空');
      return;
    }
    const content = await getFileContent(filePath, dir);
    res.cc(0, '获取成功', content);
  } catch (err) {
    res.cc(1, err.message);
  }
});

/** 写入文件内容，dir 为项目根目录，path 为文件路径 */
app.post('/file/write', async (req, res) => {
  try {
    const { dir, path: filePath, content = '' } = req.body;
    if (!filePath) {
      res.cc(1, 'path 不能为空');
      return;
    }
    const result = await writeFileContent(filePath, content, dir);
    res.cc(0, '写入成功', result);
  } catch (err) {
    res.cc(1, err.message);
  }
});

/** 启动 HTTP 服务 */
app.listen(PORT, () => {
  console.log(`Express 服务已启动: http://localhost:${PORT}`);
});

export default app;
