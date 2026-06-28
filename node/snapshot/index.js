import connection from '../../Mysql/index.js';
import { getProjectTempFiles, getFileContent,getFileBytes } from '../file/index.js';
import { countFileLines } from '../file/index.js';

export const addSnapshot = async (projectId, version, dirPath, desc, user) => {
  const files = await getProjectTempFiles(dirPath);
  const snapList = [];
  for (const file of files) {
    const filePath = file.path;
    const fileContent = await getFileContent(filePath, dirPath);
    const bytes = (await getFileBytes(filePath)).size;
    const length = await countFileLines(filePath);
    snapList.push({projectId, account:user.account, version, desc:desc||'',filePath, fileContent, bytes, length});
  }
  if(snapList.length === 0) throw new Error('项目下没有文件，无法添加快照');
  const [result] = await connection.query(`select * from snapshots where project_id = ? and version = ?`, [projectId, version]);
  if (result.length > 0) {
    await connection.query(`delete from snapshots where project_id = ? and version = ?`, [projectId, version]);
  }
  const values = snapList.map((snap)=>(Object.values(snap)));
  const [insertResult] = await connection.query('insert into snapshots (project_id, account, version, `desc`, file_path, file_content, bytes, length) values ?', [values]);
  return {content:"保存成功",id: insertResult.insertId};
}

export const getSnapshotList = async (projectId) => {
  const [result] = await connection.query(`select * from snapshots where project_id = ?`, [projectId]);
  return result;
}

export const deleteSnapshot = async (projectId, version) => {
  const [result] = await connection.query(`delete from snapshots where project_id = ? and version = ?`, [projectId, version]);
  return {content:"删除成功",affectedRows: result.affectedRows};
}

export const changeSnapshot = async (projectId, version,oldVersion,desc) => {
  const [result1] = await connection.query(`select * from snapshots where project_id = ? and version = ?`, [projectId, version]);
  if(result1.length !== 0) throw new Error('新版本号已存在，无法修改');
  const [result2] = await connection.query(`select * from snapshots where project_id = ? and version = ?`, [projectId, oldVersion]);
  if(result2.length === 0) throw new Error('旧版本号不存在，无法修改');
  let result = null;
  if(!desc) [result] = await connection.query(`update snapshots set version = ? where project_id = ? and version = ?`, [version, projectId, oldVersion]);
  else [result] = await connection.query('update snapshots set version = ?, `desc` = ? where project_id = ? and version = ?', [version, desc, projectId, oldVersion]);
  return {content:"修改成功",affectedRows: result.affectedRows};
}

export const getSnapshotNum = async (projectId,user) => {
  const [result] = await connection.query(`select count(distinct version) from snapshots where project_id = ? and account = ?`, [projectId, user.account]);
  return result[0]['count(distinct version)'];
}

export const getCurrentVision = async (projectId) => {
  const [result] = await connection.query(`select current_vision from projects where id = ?`, [projectId]);
  if(result.length === 0) throw new Error('项目不存在');
  const currentVision = result[0].current_vision;
  const [result2] = await connection.query(`select * from snapshots where id = ?`, [currentVision]);
  if(result2.length === 0) throw new Error('当前线上版本不存在');
  return {version:result2[0].version,desc:result2[0].desc};
}