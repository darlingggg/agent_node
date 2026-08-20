import STS from 'qcloud-cos-sts';
import COS from 'cos-nodejs-sdk-v5';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
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
const GENERATED_IMAGE_DOWNLOAD_TIMEOUT_MS = 60 * 1000;
const MAX_GENERATED_IMAGE_BYTES = 20 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES = new Set([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);
const GENERATED_IMAGE_WEBP_QUALITY = 92;

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

/**
 * 下载 AI 生成的临时图片并保存到指定账号的 COS 目录。
 * @param {string} imageUrl AI 服务返回的临时图片 URL
 * @param {string} storageKey users.storage_key 中保存的固定 COS 目录键
 * @returns {Promise<{key: string, url: string, source: string, contentType: string, size: number, originalSize: number, width: number, height: number}>}
 */
export async function uploadGeneratedImageToCos(imageUrl, storageKey) {
  const normalizedStorageKey = String(storageKey || '').trim();
  if (!normalizedStorageKey || normalizedStorageKey === '.' || normalizedStorageKey === '..'
    || normalizedStorageKey.includes('/') || normalizedStorageKey.includes('\\')) {
    throw new Error('用户存储目录格式不正确');
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(imageUrl);
  } catch {
    throw new Error('AI 生成图片地址格式不正确');
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('AI 生成图片地址仅支持 HTTP 或 HTTPS');
  }

  const response = await fetch(parsedUrl, {
    signal: AbortSignal.timeout(GENERATED_IMAGE_DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`下载 AI 生成图片失败：HTTP ${response.status}`);
  }

  const contentType = String(response.headers.get('content-type') || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (!SUPPORTED_IMAGE_TYPES.has(contentType)) {
    throw new Error(`AI 生成结果不是支持的图片类型：${contentType || 'unknown'}`);
  }

  const declaredSize = Number(response.headers.get('content-length')) || 0;
  if (declaredSize > MAX_GENERATED_IMAGE_BYTES) {
    throw new Error('AI 生成图片超过 20MB，无法保存');
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) {
    throw new Error('AI 生成图片内容为空');
  }
  if (buffer.length > MAX_GENERATED_IMAGE_BYTES) {
    throw new Error('AI 生成图片超过 20MB，无法保存');
  }

  let optimized;
  try {
    optimized = await sharp(buffer, { failOn: 'error' })
      .rotate()
      .webp({
        quality: GENERATED_IMAGE_WEBP_QUALITY,
        alphaQuality: 100,
        smartSubsample: true,
        effort: 5,
      })
      .toBuffer({ resolveWithObject: true });
  } catch (error) {
    throw new Error(`AI 生成图片格式转换失败：${error.message}`);
  }

  const key = `uploads/${normalizedStorageKey}/ai_generated/${Date.now()}-${randomUUID()}.webp`;
  await new Promise((resolve, reject) => {
    cos.putObject({
      Bucket: COS_CONFIG.bucket,
      Region: COS_CONFIG.region,
      Key: key,
      Body: optimized.data,
      ContentType: 'image/webp',
      Headers: {
        'x-cos-meta-source': 'ai_generated',
      },
    }, (error, data) => {
      if (error) reject(error);
      else resolve(data);
    });
  });

  return {
    key,
    url: await getSignedObjectUrl(key),
    source: 'ai_generated',
    contentType: 'image/webp',
    size: optimized.data.length,
    originalSize: buffer.length,
    width: optimized.info.width,
    height: optimized.info.height,
  };
}
