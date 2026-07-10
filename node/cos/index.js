import STS from 'qcloud-cos-sts';
import { TENCENT_SECRET_ID, TENCENT_SECRET_KEY } from '../../key.js';

const config = {
  secretId: TENCENT_SECRET_ID,
  secretKey: TENCENT_SECRET_KEY,
  bucket: 'ai-agent-1352300125',
  region: 'ap-beijing',
};

/** 临时密钥有效期（秒） */
const DURATION_SECONDS = 3600;

/**
 * 获取 COS 上传临时密钥，仅允许上传到当前用户自己的目录
 * @param {string} account 用户标识
 * @returns {Promise<object>} 临时密钥及桶信息
 */
export const getCredential = (account) => {
  const shortBucketName = config.bucket.slice(0, config.bucket.lastIndexOf('-'));
  const appId = config.bucket.slice(config.bucket.lastIndexOf('-') + 1);
  const allowPrefix = `uploads/${account}/*`;

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
        `qcs::cos:${config.region}:uid/${appId}:prefix//${appId}/${shortBucketName}/${allowPrefix}`,
      ],
    }],
  };

  return new Promise((resolve, reject) => {
    STS.getCredential({
      secretId: config.secretId,
      secretKey: config.secretKey,
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
        bucket: config.bucket,
        region: config.region,
        uploadPrefix: `uploads/${account}/`,  // 加上这行
      });
    });
  });
};
