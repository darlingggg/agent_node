import fs from 'node:fs/promises';
import connection from './index.js';

try {
  const source = await fs.readFile(
    new URL('./tool-calls.sql', import.meta.url),
    'utf8',
  );
  for (const sql of source
    .replace(/^--.*$/gm, '')
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean)) {
    await connection.query(sql);
  }
  console.log('工具调用记录迁移完成');
} finally {
  await connection.end();
}
