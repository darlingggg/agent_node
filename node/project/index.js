import { copyDir, deleteDir, updateProjectIndexHtml,getFileContent,writeFileContent,deleteFileContent } from '../file/index.js';
import { markProjectSessionsDeleted } from '../session/index.js';
import { addSnapshot } from '../snapshot/index.js';
import connection from '../../Mysql/index.js';
import fs from 'fs/promises';
import path from 'path';
const rootDir = '/www/wwwroot/ai_agent';
// const rootDir = 'C:/pro_self';
// const rootDir = 'C:/ai';

/** 项目类型对应的模板目录相对路径 */
const typeToPath = {
  'tool':'/projectTemp', // 工具类项目模板
  '2d':'/gameTemp2d',    // 2D 游戏模板
  '3d':'/gameTemp3d',    // 3D 游戏模板
}

/** 创建项目 */
export const createProject = async (user, body) => {
  const type = body.type;
  if(!type) throw new Error('类型不能为空');
  if(!typeToPath[type]) throw new Error('类型不存在');
  const sourceDir = rootDir + typeToPath[type];
  let targetDir = rootDir + '/copyPro';
  targetDir = targetDir + '/' + "project" + Math.random().toString(36).substring(2, 15)+ '_' + (+Date.now());
  const { dirPath } = await copyDir(sourceDir, targetDir);
  await updateProjectIndexHtml(dirPath, body.title, body.desc);
  const [result] = await connection.query(
    'INSERT INTO projects (account, dir_path, title, `desc`, temp_version, type) VALUES (?, ?, ?, ?, ?, ?)',
    [user.account, dirPath, body.title, body.desc, (await getLatestTemplateVersion(type)).version, type]
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

/** 获取项目详情 */
export const getProjectInfo = async (id, user) => {
  const [rows] = await connection.query(
    'SELECT * FROM projects WHERE id = ? AND account = ?',
    [id, user.account]
  );
  if (rows.length === 0) throw new Error('项目不存在');
  return rows[0];
}

/** 删除项目 */
export const deleteProject = async (id, user) => {
  const [rows] = await connection.query(
    'SELECT * FROM projects WHERE id = ? AND account = ?',
    [id, user.account]
  );
  if (rows.length === 0) throw new Error('项目不存在');
  const dirPath = rows[0].dir_path;
  await markProjectSessionsDeleted(id, user.account);
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

  let result = null
  if(!body.tempVersion)
  [result] = await connection.query(
    'UPDATE projects SET title = ?, `desc` = ? WHERE id = ? AND account = ?',
    [body.title, body.desc ?? "", body.id, user.account]
  );
  else [result] = await connection.query(
    'UPDATE projects SET title = ?, `desc` = ?, temp_version = ? WHERE id = ? AND account = ?',
    [body.title, body.desc ?? "", body.tempVersion, body.id, user.account]
  );

  if (result.affectedRows !== 1) {
    throw new Error('修改项目失败，请稍后重试');
  }
  return {content: '修改成功'}; 
}

/** 构建项目 */
export const buildProject = async (projectId,link,visionId,deploymentId) => {
  const [result] = await connection.query(
    'UPDATE projects SET link = ?, current_vision = ?, cloudflare_id = ? WHERE id = ?',
    [link, visionId, deploymentId, projectId]
  );
  if (result.affectedRows !== 1) {
    throw new Error('构建项目失败，更新数据库失败');
  }
  return {content: '构建成功'};
}

/**
 * 比较两个 semver 版本号
 * @param {string} a 版本号 a
 * @param {string} b 版本号 b
 * @returns {number} 1 表示 a > b，-1 表示 a < b，0 表示相等
 */
function compareVersion(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

/**
 * 获取模板 versions 目录下的所有版本文件（按版本号升序）
 * @param {string} type 项目类型 tool/2d/3d
 * @returns {Promise<Array<{ version: string, fileName: string, filePath: string, content: object }>>}
 */
export const getAllTemplateVersionFiles = async (type) => {
  if(!type) throw new Error('类型不能为空');
  if(!typeToPath[type]) throw new Error('类型不存在');
  const sourceDir = rootDir + typeToPath[type];
  const versionsDir = path.join(sourceDir, 'agent_base', 'versions');
  const files = await fs.readdir(versionsDir);
  const jsonFiles = files.filter((name) => name.endsWith('.json'));

  const result = [];
  for (const fileName of jsonFiles) {
    const filePath = path.join(versionsDir, fileName);
    const fileContent = await fs.readFile(filePath, 'utf-8');
    const content = JSON.parse(fileContent);
    result.push({
      version: fileName.replace('.json', ''),
      fileName,
      filePath,
      content,
    });
  }

  result.sort((a, b) => compareVersion(a.version, b.version));
  return result;
};

/**
 * 获取 (fromVersion, toVersion] 区间内的版本文件（左开右闭）
 * @param {string} fromVersion 起始版本（不含）
 * @param {string} toVersion 结束版本（含）
 * @param {string} type 项目类型 tool/2d/3d
 * @returns {Promise<Array<{ version: string, fileName: string, filePath: string, content: object }>>}
 */
export const getTemplateVersionFilesBetween = async (fromVersion, toVersion, type) => {
  if (compareVersion(fromVersion, toVersion) >= 0) {
    throw new Error('起始版本必须小于结束版本');
  }

  const allVersions = await getAllTemplateVersionFiles(type);
  return allVersions.filter(
    (item) => compareVersion(item.version, fromVersion) > 0 && compareVersion(item.version, toVersion) <= 0
  );
};

/**
 * 获取指定类型模板的最新版本
 * @param {string} type 项目类型 tool/2d/3d
 */
export const getLatestTemplateVersion = async (type) => {
  if(!type) throw new Error('类型不能为空');
  if(!typeToPath[type]) throw new Error('类型不存在');
  const sourceDir = rootDir + typeToPath[type];
  const versionPath = path.join(sourceDir,'agent_base','version.json');
  const file = await getFileContent(versionPath,rootDir);
  const version = JSON.parse(file).version;
  return {version,fileContent:file};
}

/** 获取当前项目的模板版本 */
export const getCurrentProjectTemplateVersion = async (projectId) => {
  const [rows] = await connection.query(
    'SELECT temp_version FROM projects WHERE id = ?',
    [projectId]
  );
  return {version:rows[0].temp_version};
}

/** 更新项目模板版本（从项目表读取 type 定位模板目录） */
export const updateProjectTemplateVersion = async (projectId,upToVersion,user) => {
  const [result] = await connection.query('select dir_path, type from projects where id = ?',[projectId]);
  if(!result[0]) throw new Error('项目不存在');
  const dirPath = result[0].dir_path;
  const type = result[0].type;
  if(!typeToPath[type]) throw new Error('类型不存在');
  const sourceDir = rootDir + typeToPath[type];

  const latestVersion = await getLatestTemplateVersion(type);
  const currentVision = await getCurrentProjectTemplateVersion(projectId);
  if(!upToVersion) upToVersion = latestVersion.version;
  if(upToVersion === currentVision.version) return {content: '当前模板版本已是最新,无需更新',affectedRows:0};

  const betweenVersionFiles = await getTemplateVersionFilesBetween(currentVision.version, upToVersion, type);

  // 添加快照
  await addSnapshot(projectId,Math.random().toString(36).substring(2, 15)+'_'+upToVersion,dirPath,`更新项目模板版本到${upToVersion}`,user,1);

  for(let file of betweenVersionFiles){
    const files = file.content.files;
    for(let file of files){
      const filePath = path.join(sourceDir,file.path);
      const fileContent = await getFileContent(filePath,sourceDir);
      const targetPath = path.join(dirPath,file.path);
      const action = file.action;

      if(action === 'add' || action === 'update'){
        await writeFileContent(targetPath,fileContent,dirPath,false);
      }else if(action === 'delete'){
        const stat = await fs.stat(filePath)
        if(stat.isDirectory()) await deleteDir(filePath)
        else await deleteFileContent(targetPath,dirPath)
      }
    }

  }
  const [result2] = await connection.query(
    'UPDATE projects SET temp_version = ? WHERE id = ?',
    [upToVersion, projectId]
  );
  if (result2.affectedRows !== 1) throw new Error('更新项目模板版本失败');
  return {content: '项目模板更新成功',affectedRows:result2.affectedRows};
}