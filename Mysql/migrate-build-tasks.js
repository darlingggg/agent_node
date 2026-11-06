import fs from 'node:fs/promises';
import connection from './index.js';

try {
  const sql = await fs.readFile(new URL('./build-tasks.sql', import.meta.url), 'utf8');
  await connection.query(sql);
  console.log('构建预览任务迁移完成');
} finally {
  await connection.end();
}
