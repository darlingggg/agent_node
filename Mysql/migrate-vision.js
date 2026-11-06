import connection from './index.js';

try {
  const [columns] = await connection.query("SHOW COLUMNS FROM sessions LIKE 'image_context'");
  if (!columns.length) {
    await connection.query("ALTER TABLE sessions ADD COLUMN image_context JSON NULL COMMENT '图片引用及视觉工具观察，不包含图片二进制'");
  }
  console.log('视觉上下文迁移完成');
} finally {
  await connection.end();
}
