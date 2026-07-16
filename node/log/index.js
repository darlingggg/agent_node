import connection from '../../Mysql/index.js';

/**
 * 添加日志
 * @param {string} content 日志内容
 * @param {number|string} projectId 项目 id
 * @param {string} title 会话标题
 * @param {object} user 当前登录用户
 */
export const addLog = async (content, projectId, title, user) => {
  const { account } = user;
  try {
    const [result] = await connection.execute(
      'insert into log (content, project_id, title, account) values (?, ?, ?, ?)',
      [content, projectId, title, account]
    );
    return { content: '添加成功', affectRows: result.affectedRows };
  } catch (err) {
    throw new Error(err.message);
  }
}

/**
 * 获取日志列表，可按会话标题过滤
 * @param {number|string} projectId 项目 id
 * @param {string|undefined} title 会话标题，传入时只返回该会话下的日志
 * @param {object} user 当前登录用户
 */
export const getLogList = async (projectId, title, user) => {
  const { account } = user;
  try {
    const where = title ? 'and title = ?' : '';
    const params = title ? [projectId, account, title] : [projectId, account];
    const [result] = await connection.execute(
      `select * from log where project_id = ? and account = ? ${where} order by created_at asc`,
      params
    );
    return result;
  } catch (err) {
    throw new Error(err.message);
  }
}
