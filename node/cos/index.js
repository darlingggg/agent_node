import STS from 'qcloud-cos-sts';
import COS from 'cos-nodejs-sdk-v5';
import { TENCENT_SECRET_ID, TENCENT_SECRET_KEY } from '../../key.js';

export const COS_CONFIG = {
  secretId: TENCENT_SECRET_ID,
  secretKey: TENCENT_SECRET_KEY,
  bucket: 'ai-agent-1352300125',
  region: 'ap-beijing',
};

const cos = new COS({
  SecretId: COS_CONFIG.secretId,
  SecretKey: COS_CONFIG.secretKey,
});

/** 临时密钥有效期（秒） */
const DURATION_SECONDS = 3600;

/**
 * 获取 COS 上传临时密钥，仅允许上传到当前用户自己的目录
 * @param {string} storageKey 用户固定存储目录键
 * @returns {Promise<object>} 临时密钥及桶信息
 */
export const getCredential = (storageKey) => {
  if (!storageKey) throw new Error('用户存储目录未初始化');

  const shortBucketName = COS_CONFIG.bucket.slice(0, COS_CONFIG.bucket.lastIndexOf('-'));
  const appId = COS_CONFIG.bucket.slice(COS_CONFIG.bucket.lastIndexOf('-') + 1);
  const allowPrefix = `uploads/${storageKey}/*`;

  const policy = {
    version: '2.0',
    statement: [{
      action: [
        'name/cos:PutObject',
        'name/cos:PostObject',
        'name/cos:InitiateMultipartUpload',
        'name/cos:ListMultipartUploads',
        'name/cos:ListParts',
        'name/cos:UploadPart',
        'name/cos:CompleteMultipartUpload',
      ],
      effect: 'allow',
      principal: { qcs: ['*'] },
      resource: [
        `qcs::cos:${COS_CONFIG.region}:uid/${appId}:prefix//${appId}/${shortBucketName}/${allowPrefix}`,
      ],
    }],
  };

  return new Promise((resolve, reject) => {
    STS.getCredential({
      secretId: COS_CONFIG.secretId,
      secretKey: COS_CONFIG.secretKey,
      durationSeconds: DURATION_SECONDS,
      policy,
    }, (err, credential) => {
      if (err) return reject(err);
      resolve({
        tmpSecretId: credential.credentials.tmpSecretId,
        tmpSecretKey: credential.credentials.tmpSecretKey,
        sessionToken: credential.credentials.sessionToken,
        startTime: credential.startTime,
        expiredTime: credential.expiredTime,
        bucket: COS_CONFIG.bucket,
        region: COS_CONFIG.region,
        uploadPrefix: `uploads/${storageKey}/`,
      });
    });
  });
};

/** 按对象键前缀分页查询 COS 对象。 */
export function listObjects({ prefix = 'uploads/', marker = '', maxKeys = 20 } = {}) {
  return new Promise((resolve, reject) => {
    cos.getBucket({
      Bucket: COS_CONFIG.bucket,
      Region: COS_CONFIG.region,
      Prefix: prefix,
      Marker: marker,
      MaxKeys: maxKeys,
    }, (error, data) => {
      if (error) reject(error);
      else resolve(data);
    });
  });
}

/** 生成一小时有效的对象访问地址，兼容私有读存储桶。 */
export function getSignedObjectUrl(key) {
  return new Promise((resolve, reject) => {
    cos.getObjectUrl({
      Bucket: COS_CONFIG.bucket,
      Region: COS_CONFIG.region,
      Key: key,
      Sign: true,
      Expires: DURATION_SECONDS,
    }, (error, data) => {
      if (error) reject(error);
      else resolve(data.Url);
    });
  });
}
