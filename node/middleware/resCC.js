import { keysToCamelCase } from '../utils/case.js';

/**
 * 统一响应中间件，挂载 res.cc 方法
 * 成功: res.cc(0, '获取成功', data)
 * 失败: res.cc(1, '错误信息')
 * data 中的字段名会自动从下划线转为小驼峰后返回给前端
 */
const resCC = (req, res, next) => {
  res.cc = (status = 0, message = 'success', data = null) => {
    const body = { status, message };
    if (data !== null && data !== undefined) {
      body.data = keysToCamelCase(data);
    }
    // 禁止浏览器缓存接口响应
    res.set('Cache-Control', 'no-store');
    res.json(body);
  };
  next();
};

export default resCC;
