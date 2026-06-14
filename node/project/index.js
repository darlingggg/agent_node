import { copyDir, deleteDir, updateProjectIndexHtml } from '../file/index.js';
import connection from '../../Mysql/index.js';

const sourceDir = 'C:/pro_self/projectTemp';

/** 创建项目 */
export const createProject = async (user, body) => {
  let targetDir = 'C:/pro_self/copyPro';
  targetDir = targetDir + '/' + Math.random().toString(36).substring(2, 15)+ '_' + (+Date.now());
  const { dirPath } = await copyDir(sourceDir, targetDir);
  await updateProjectIndexHtml(dirPath, body.title, body.desc);
  const [result] = await connection.query(
    'INSERT INTO projects (account, dir_path, title, `desc`) VALUES (?, ?, ?, ?)',
    [user.account, dirPath, body.title, body.desc]
  );
  if (result.affectedRows !== 1) {
    throw new Error('创建项目失败，请稍后重试');
  }
  return {id: result.insertId, dirPath}
}

/** 获取项目列表 */
export const getProjectList = async (user) => {
  const [result] = await connection.query(
    'SELECT * FROM projects WHERE account = ?',
    [user.account]
  );
  return result;
}

/** 删除项目 */
export const deleteProject = async (id, user) => {
  const [rows] = await connection.query(
    'SELECT * FROM projects WHERE id = ? AND account = ?',
    [id, user.account]
  );
  if (rows.length === 0) throw new Error('项目不存在');
  const dirPath = rows[0].dir_path;
  const [result] = await connection.query(
    'DELETE FROM projects WHERE id = ? AND account = ?',
    [id, user.account]
  );
  await deleteDir(dirPath);
  if (result.affectedRows !== 1) {
    throw new Error('删除项目失败，请稍后重试');
  }
  return {content: '删除成功'};
}

/** 修改项目配置 */
export const updateProject = async (body,user) => {
  const [rows] = await connection.query(
    'SELECT * FROM projects WHERE id = ? AND account = ?',
    [body.id, user.account]
  );
  if (rows.length === 0) throw new Error('项目不存在');
  const dirPath = rows[0].dir_path;
  await updateProjectIndexHtml(dirPath, body.title, body.desc ?? "");
  const [result] = await connection.query(
    'UPDATE projects SET title = ?, `desc` = ? WHERE id = ? AND account = ?',
    [body.title, body.desc ?? "", body.id, user.account]
  );
  if (result.affectedRows !== 1) {
    throw new Error('修改项目失败，请稍后重试');
  }
  return {content: '修改成功'}; 
}