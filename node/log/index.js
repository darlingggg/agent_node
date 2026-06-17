import connection from '../../Mysql/index.js';

export const addLog = async (content, projectId, user) => {
  const { account } = user;
  try {
    const [result] = await connection.execute('insert into log (content, project_id, account) values (?, ?, ?)', [content, projectId, account]);
    return {content: '添加成功', affectRows: result.affectedRows};
  } catch (err) {
    throw new Error(err.message);
  }
}

export const getLogList = async (projectId, user) => {
  const { account } = user;
  try {
    const [result] = await connection.execute('select * from log where project_id = ? and account = ?', [projectId, account]);
    return result;
  } catch (err) {
    throw new Error(err.message);
  }
}