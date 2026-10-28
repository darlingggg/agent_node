import express from 'express';
import cors from 'cors';
import resCC from './middleware/resCC.js';
import frontRouter from './routes/front.js';
import adminRouter from './routes/admin.js';
import { startStorageMetricsScheduler } from './cos/storageMetrics.js';
import { startModelSyncScheduler } from './models/scheduler.js';
import { recoverPendingImageGenerationTasks } from './imageGeneration.js';
import { recoverOrphanedChatStreams } from './chatStream.js';
import { projectBuilds } from './exec/build/index.js';
import { clearAbandonedBuildInputs } from './exec/build/project-input.js';

const PORT = process.env.PORT || 5000;
const app = express();

const allowOrigin = ['http://localhost:5173', 'https://darling.xin', 'https://www.darling.xin'];

// 接口返回 JSON，关闭 ETag 避免浏览器缓存导致 304。
app.set('etag', false);

app.use(
  cors({
    origin: allowOrigin,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(resCC);

// 前台接口保持原路径；后台接口统一使用 /admin 前缀。
app.use(frontRouter);
app.use('/admin', adminRouter);

try {
  await recoverOrphanedChatStreams();
} catch (error) {
  console.error('[startup] 收束失联聊天流失败:', error);
}
try {
  await projectBuilds.recover();
  // 重启后原队列与回调已丢失：先标记任务中断，再清理输入副本；依赖/产物/成功链接保留。
  await clearAbandonedBuildInputs();
} catch (error) {
  console.error('[startup] 恢复构建任务失败，请运行 pnpm db:migrate:builds:', error.message);
}
try {
  await recoverPendingImageGenerationTasks();
} catch (error) {
  console.error('[startup] 恢复未完成图片任务失败:', error);
}

app.listen(PORT, () => {
  console.log(`Express 服务已启动: http://localhost:${PORT}`);
  startStorageMetricsScheduler();
  startModelSyncScheduler();
});
