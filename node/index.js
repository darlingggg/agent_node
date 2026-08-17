import express from 'express';
import cors from 'cors';
import resCC from './middleware/resCC.js';
import frontRouter from './routes/front.js';
import adminRouter from './routes/admin.js';

const PORT = process.env.PORT || 3000;
const app = express();

const allowOrigin = [
  'http://localhost:5173',
  'https://darling.xin',
  'https://www.darling.xin',
];

// 接口返回 JSON，关闭 ETag 避免浏览器缓存导致 304。
app.set('etag', false);

app.use(cors({
  origin: allowOrigin,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(resCC);

// 前台接口保持原路径；后台接口统一使用 /admin 前缀。
app.use(frontRouter);
app.use('/admin', adminRouter);

app.listen(PORT, () => {
  console.log(`Express 服务已启动: http://localhost:${PORT}`);
});
