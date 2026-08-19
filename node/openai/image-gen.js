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

/**
 * 使用千问图片生成异步接口生成图片。
 * @param {string} prompt 正向提示词
 * @param {string} [negativePrompt=''] 反向提示词
 * @param {string} [size='auto'] 图片尺寸，auto 表示由模型自动选择
 * @returns {Promise<string>} 生成图片的临时 URL
 */
export async function generateImage(
  prompt,
  imageUrls=[],
  negativePrompt = '',
  size = 'auto',
) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new TypeError('prompt 不能为空')
  }

  if (!Array.isArray(imageUrls)) {
    throw new TypeError('imageUrls 必须是数组')
  }

  let imageList = imageUrls.length > 0 ? imageUrls.slice(0, 3) : []
  const imageMsg = imageList.map(item=>({"image":item}))

  const task = await client.post(
    '/services/aigc/image-generation/generation',
    {
      headers: {
        'X-DashScope-Async': 'enable',
      },
      body: {
        model: 'qwen-image-3.0',
        input: {
          messages: [
            {
              role: 'user',
              content: [...imageMsg,{ text: prompt.trim() }],
            },
          ],
        },
        parameters: {
          prompt_extend: true,
          ...(size !== 'auto' ? { size } : {}),
          ...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
        },
      },
    },
  )

  const taskId = task.output?.task_id
  if (!taskId) {
    throw new Error(`图片生成接口未返回 task_id：${JSON.stringify(task)}`)
  }

  const deadline = Date.now() + TASK_TIMEOUT_MS
  while (Date.now() < deadline) {
    const result = await client.get(`/tasks/${encodeURIComponent(taskId)}`, {
      maxRetries: 3,
    })
    const status = result.output?.task_status

    if (status === 'SUCCEEDED') {
      const imageUrl =
        result.output?.choices?.[0]?.message?.content?.[0]?.image

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

await generateImage("帮我生成一张充满高级感的都市风格女性写真，画面中人物完美保留输入图片中这位年轻女性的面部特征与一头柔顺的黑色长发。人物脱下原本的米色针织上衣，换上一套彰显高雅气质的都市职场穿搭，身穿一件质感垂顺的香槟色真丝衬衫，外搭一件剪裁利落的深灰色休闲西装外套，下身搭配同色系的高腰阔腿裤，整体造型既干练又富有女人味。场景设定在一家装修现代简约的高端咖啡店内，背景是通透的落地玻璃窗，窗外隐约可见繁华的城市街景，室内摆放着深色实木长桌和舒适的皮质座椅，桌面上放置着一台打开的银色笔记本电脑、一份文件和一杯热气腾腾的美式咖啡。人物呈现出慵懒而放松的办公姿态，身体微微后仰倚靠在椅背上，一只手臂自然搭在扶手上，另一只手轻轻握着咖啡杯置于桌边，头部微侧，眼神清澈从容且带有一丝慵懒地直视镜头，嘴角挂着一抹优雅自信的微笑。人物化着精致得体的正式场合妆容，底妆清透干净，眉眼线条清晰利落，唇部涂抹着显气色的豆沙色口红，展现出成熟知性的魅力。光线采用午后柔和的自然光，从侧面透过落地窗洒入，在人物的面部轮廓和衣物褶皱上留下细腻的光影过渡，背景呈现自然的景深虚化效果，色彩以大地色、灰色和暖白色为主调，营造出宁静、高级且充满故事感的都市办公氛围，构图采用经典的竖幅七分身人像视角，人物位于画面视觉中心略偏右，比例协调，画质清晰细腻。",["https://alidocs.oss-cn-zhangjiakou.aliyuncs.com/res/yBRq1ZPYEaXdyOdv/img/33a80a19-7ac7-4c64-b0fa-7d685b7046a0.png"])
