import OpenAI from 'openai'
import {
  IMAGE_GENERATION_BASE_URL,
  IMAGE_GENERATION_KEY,
} from '../../key.js'

const client = new OpenAI({
  apiKey: IMAGE_GENERATION_KEY,
  baseURL: IMAGE_GENERATION_BASE_URL,
  timeout: 30 * 1000,
  maxRetries: 0,
})

const POLL_INTERVAL_MS = 5 * 1000
const TASK_TIMEOUT_MS = 30 * 60 * 1000
const FAILED_TASK_STATUSES = new Set(['FAILED', 'CANCELED', 'UNKNOWN'])
export const IMAGE_GENERATION_MODEL = 'qwen-image-3.0'
const MIN_IMAGE_EDGE = 512
const MAX_IMAGE_EDGE = 2048

export const validateImageGenerationSize = (size = 'auto') => {
  if (size === 'auto' || size == null || size === '') return 'auto'
  if (typeof size !== 'string') {
    throw new TypeError('size 必须是 auto 或“宽*高”格式')
  }

  const match = size.trim().match(/^(\d+)\*(\d+)$/)
  if (!match) throw new TypeError('size 必须是 auto 或“宽*高”格式')

  const width = Number(match[1])
  const height = Number(match[2])
  if (
    !Number.isInteger(width)
    || !Number.isInteger(height)
    || width < MIN_IMAGE_EDGE
    || width > MAX_IMAGE_EDGE
    || height < MIN_IMAGE_EDGE
    || height > MAX_IMAGE_EDGE
  ) {
    throw new RangeError(`图片宽高必须在 ${MIN_IMAGE_EDGE}-${MAX_IMAGE_EDGE}px 之间`)
  }

  return `${width}*${height}`
}

const validateImageRequest = (prompt, imageUrls, size) => {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new TypeError('prompt 不能为空')
  }
  if (!Array.isArray(imageUrls)) {
    throw new TypeError('imageUrls 必须是数组')
  }
  return validateImageGenerationSize(size)
}

/** 提交图片生成任务，返回服务商任务 ID。 */
export async function submitImageGeneration(
  prompt,
  imageUrls = [],
  negativePrompt = '',
  size = 'auto',
) {
  const normalizedSize = validateImageRequest(prompt, imageUrls, size)
  const imageMsg = imageUrls.slice(0, 3).map(item => ({ image: item }))

  const task = await client.post(
    '/services/aigc/image-generation/generation',
    {
      headers: {
        'X-DashScope-Async': 'enable',
      },
      body: {
        model: IMAGE_GENERATION_MODEL,
        input: {
          messages: [
            {
              role: 'user',
              content: [...imageMsg, { text: prompt.trim() }],
            },
          ],
        },
        parameters: {
          prompt_extend: true,
          ...(normalizedSize !== 'auto' ? { size: normalizedSize } : {}),
          ...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
        },
      },
    },
  )

  const taskId = task.output?.task_id
  if (!taskId) {
    throw new Error(`图片生成接口未返回 task_id：${JSON.stringify(task)}`)
  }
  return taskId
}

/** 轮询已提交的服务商任务；服务重启后可凭 taskId 继续等待。 */
export async function waitForGeneratedImage(taskId, { onStatus } = {}) {
  if (!taskId) throw new TypeError('taskId 不能为空')

  const deadline = Date.now() + TASK_TIMEOUT_MS
  let lastStatus = null
  while (Date.now() < deadline) {
    const result = await client.get(`/tasks/${encodeURIComponent(taskId)}`, {
      maxRetries: 3,
    })
    const status = result.output?.task_status
    if (status !== lastStatus) {
      lastStatus = status
      await onStatus?.(status)
    }

    if (status === 'SUCCEEDED') {
      const imageUrl = result.output?.choices?.[0]?.message?.content?.[0]?.image
      if (!imageUrl) {
        throw new Error(`任务成功但未返回图片：${JSON.stringify(result)}`)
      }
      console.log(`图片生成成功：${imageUrl}`)
      return imageUrl
    }

    if (FAILED_TASK_STATUSES.has(status)) {
      const code = result.output?.code || result.code || status
      const message = result.output?.message || result.message || '未知错误'
      throw new Error(`图片生成失败（${code}）：${message}`)
    }

    if (status !== 'PENDING' && status !== 'RUNNING') {
      throw new Error(`未知任务状态：${JSON.stringify(result)}`)
    }

    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
  }

  throw new Error(`图片生成等待超时，task_id=${taskId}`)
}

/**
 * 使用千问图片生成异步接口生成图片。
 * @param {string} prompt 正向提示词
 * @param {string} [negativePrompt=''] 反向提示词
 * @param {string} [size='auto'] 图片尺寸，auto 表示由模型自动选择
 * @param {{onSubmitted?: Function, onStatus?: Function}} [callbacks] 任务状态回调
 * @returns {Promise<string>} 生成图片的临时 URL
 */
export async function generateImage(
  prompt,
  imageUrls=[],
  negativePrompt = '',
  size = 'auto',
  callbacks = {},
) {
  const taskId = await submitImageGeneration(prompt, imageUrls, negativePrompt, size)
  await callbacks.onSubmitted?.(taskId)
  return waitForGeneratedImage(taskId, callbacks)
}
