import mysql from 'mysql2/promise';
const connection = await mysql.createConnection({
  host: 'localhost',
  port: 3306,
  user: 'root',
  password: '123456',          // 本机 root 目前是空密码
  database: 'gameAgent'
});
const [rows] = await connection.query('SELECT * FROM users');
console.log(rows);
connection.end();