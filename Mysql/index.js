import mysql from 'mysql2/promise';

/**
 * 创建 MySQL 数据库连接
 */
const connection = await mysql.createConnection({
  host: 'localhost',
  port: 3306,
  user: 'root',
  // user:'agent',
  password: '123456',
  database: 'gameAgent'
});

export default connection;
