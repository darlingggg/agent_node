import mysql from 'mysql2/promise';

/**
 * 创建 MySQL 数据库连接
 */
const connection = await mysql.createPool({
  host: 'localhost',
  port: 3306,
  user: 'root',
  // user:'agent',
  password: '123456',
  database: 'gameAgent',
  timezone: 'Z',
});

// 统一以 UTC 读写时间戳；业务日期由代码显式按北京时间（UTC+8）换算。
connection.on('connection', (db) => {
  db.query("SET SESSION time_zone = '+00:00'");
});

export default connection;
