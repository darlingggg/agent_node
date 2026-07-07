import connection from '../../Mysql/index.js';
import { getProjectTempFiles, getFileContent,getFileBytes } from '../file/index.js';
import { countFileLines } from '../file/index.js';
import { getCurrentProjectTemplateVersion } from '../project/index.js';

/** 添加快照 */
export const addSnapshot = async (projectId, version, dirPath, desc, user,type=0,tempVersion=null) => {
  const files = await getProjectTempFiles(dirPath);
  const snapshotNum = await getSnapshotNum(projectId,user,type);
  if(snapshotNum >= 5) throw new Error('快照数量不能超过5个，请删除旧版本快照');

  let temp_version = null;
  if(!tempVersion) {
    const currentTempVersion = await getCurrentProjectTemplateVersion(projectId);
    temp_version = currentTempVersion.version;
  }else{
    temp_version = tempVersion;
  }

  const snapList = [];
  for (const file of files) {
    const filePath = file.path;
    const fileContent = await getFileContent(filePath, dirPath);
    const bytes = (await getFileBytes(filePath)).size;
    const length = await countFileLines(filePath);
    snapList.push({projectId, account:user.account, version, desc:desc||'',filePath, fileContent, bytes, length,type,temp_version});
  }
  if(snapList.length === 0) throw new Error('项目下没有文件，无法添加快照');
  const [result] = await connection.query(`select * from snapshots where project_id = ? and version = ?`, [projectId, version]);
  if (result.length > 0) {
    await connection.query(`delete from snapshots where project_id = ? and version = ?`, [projectId, version]);
  }
  const values = snapList.map((snap)=>(Object.values(snap)));
  const [insertResult] = await connection.query('insert into snapshots (project_id, account, version, `desc`, file_path, file_content, bytes, length,type,temp_version) values ?', [values]);
  return {content:"保存成功",id: insertResult.insertId};
}

/** 获取快照列表 */
export const getSnapshotList = async (projectId) => {
  const [result] = await connection.query(`select * from snapshots where project_id = ?`, [projectId]);
  return result;
}

/** 删除快照 */
export const deleteSnapshot = async (projectId, version) => {
  const [result] = await connection.query(`delete from snapshots where project_id = ? and version = ?`, [projectId, version]);
  return {content:"删除成功",affectedRows: result.affectedRows};
}

/** 修改快照 */
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

/** 获取快照数量 */
export const getSnapshotNum = async (projectId,user,type=0) => {
  const [result] = await connection.query(`select count(distinct version) from snapshots where project_id = ? and account = ? and type = ?`, [projectId, user.account, type]);
  return result[0]['count(distinct version)'];
}

/** 获取当前线上版本 */
export const getCurrentVision = async (projectId) => {
  const [result] = await connection.query(`select current_vision from projects where id = ?`, [projectId]);
  if(result.length === 0) throw new Error('项目不存在');
  const currentVision = result[0].current_vision;
  const [result2] = await connection.query(`select * from snapshots where id = ?`, [currentVision]);
  if(result2.length === 0) throw new Error('当前线上版本不存在');
  return {version:result2[0].version,desc:result2[0].desc};
}