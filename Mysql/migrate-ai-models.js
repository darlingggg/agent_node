import fs from 'node:fs/promises';
import connection from './index.js';

/** 独立、可重复运行的增量迁移，不执行 sql.sql 中历史迁移。 */
try {
  const source = await fs.readFile(new URL('./ai-models.sql', import.meta.url), 'utf8');
  const statements = source
    .replace(/^--.*$/gm, '')
    .split(';')
    .map((sql) => sql.trim())
    .filter(Boolean);
  for (const sql of statements) {
    const alter = sql.match(
      /^ALTER TABLE (ai_models|conversations|sessions)\s+(ADD COLUMN[\s\S]+)/i,
    );
    if (!alter) {
      await connection.query(sql);
      continue;
    }
    const [columns] = await connection.query(
      'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
      [alter[1]],
    );
    const existing = new Set(columns.map((column) => column.COLUMN_NAME));
    const additions = alter[2]
      .split(/,\s*(?=ADD COLUMN)/i)
      .filter((addition) => !existing.has(addition.match(/ADD COLUMN (\w+)/i)[1]));
    if (additions.length) await connection.query(`ALTER TABLE ${alter[1]} ${additions.join(', ')}`);
  }
  const [defaults] = await connection.query(
    'SELECT id FROM ai_models WHERE is_default = 1 AND enabled = 1',
  );
  if (!defaults.length) {
    const [models] = await connection.query(
      'SELECT id FROM ai_models WHERE enabled = 1 ORDER BY model_key = ? DESC, id LIMIT 1',
      [process.env.AI_CHAT_MODEL || ''],
    );
    await connection.query('UPDATE ai_models SET is_default = 0 WHERE is_default = 1');
    if (models.length)
      await connection.query('UPDATE ai_models SET is_default = 1 WHERE id = ?', [models[0].id]);
  }
  console.log('模型目录及会话配置迁移完成');
} finally {
  await connection.end();
}
