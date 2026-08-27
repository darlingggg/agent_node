import crypto from 'crypto';

/** 生成与账号无关、创建后不再变化的 COS 用户目录键。 */
export function createStorageKey() {
  return `user_${crypto.randomBytes(16).toString('hex')}`;
}
