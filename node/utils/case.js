/**
 * 将下划线命名转为小驼峰
 * @param {string} str 字段名，如 dir_path
 * @returns {string} 小驼峰字段名，如 dirPath
 */
function snakeToCamel(str) {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

/**
 * 递归将对象/数组的键名转为小驼峰（用于接口返回给前端）
 * @param {*} data 原始数据
 * @returns {*} 转换后的数据
 */
export function keysToCamelCase(data) {
  if (Array.isArray(data)) {
    return data.map(keysToCamelCase);
  }

  if (data !== null && typeof data === 'object') {
    // Date 等内置对象不做键名转换
    if (data instanceof Date) {
      return data;
    }

    return Object.keys(data).reduce((acc, key) => {
      acc[snakeToCamel(key)] = keysToCamelCase(data[key]);
      return acc;
    }, {});
  }

  return data;
}
