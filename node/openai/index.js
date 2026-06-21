import path from 'path'
import OpenAI from 'openai'
import { encodingForModel } from 'js-tiktoken'
import { baseURL, key } from '../../key.js'
import { tools, functionMap } from './tools.js'
import connection from '../../Mysql/index.js';

const client = new OpenAI({
    apiKey: key,
    baseURL: baseURL,
})

/** token 编码器（用于估算上下文长度） */
const tokenizer = encodingForModel('gpt-4')

/**
 * 统计 messages 上下文的 token 数量
 * @param {Array} context 对话上下文
 * @returns {number}
 */
function countContextTokens(context) {
  let total = 0
  for (const msg of context) {
    total += 4
    if (msg.role) total += tokenizer.encode(msg.role).length
    if (typeof msg.content === 'string' && msg.content) {
      total += tokenizer.encode(msg.content).length
    }
    if (msg.tool_calls) {
      total += tokenizer.encode(JSON.stringify(msg.tool_calls)).length
    }
    if (msg.tool_call_id) {
      total += tokenizer.encode(msg.tool_call_id).length
    }
    if (msg.name) {
      total += tokenizer.encode(msg.name).length
    }
  }
  total += 2
  return total
}

/** 系统提示词 */
const SYSTEM_PROMPT = `【角色设定】
你是曾获得 Awwwards 设计大奖的顶级全栈工程师，对「丑陋的默认 UI」深恶痛绝。你的任务是生成具有高级感、现代感、苹果级审美的网页或游戏。

【执行优先级】
1. 始终以「用户最新消息」为唯一决策依据，先理解用户想做什么，再决定下一步
2. 若用户只是闲聊、提问、与项目无关，忽略项目背景，直接回答用户问题
3. 开发前先查看目录结构和相关文件内容，再动手写代码

【技术栈规范】
1. 组件库优先使用 Vant，能用 Vant 组件实现的 UI 不要手写原生或引入其他组件库
2. CSS 样式优先使用 Tailwind CSS 工具类，避免写大量自定义 CSS，除非 Tailwind 无法实现
3. 使用 Vant 组件时，通过 Tailwind 类名和自定义样式使其符合下方设计规范，拒绝 Vant 默认廉价观感

【设计强制规范】（必须严格遵守）
1. 留白：使用巨大的、奢侈的 padding 和 margin（如 p-8、gap-6），绝对不要让元素挤在一起
2. 微交互：每一个可点击元素都必须有 Hover 和 Active 视觉反馈（颜色变深、轻微位移或阴影变化）
3. 层级与阴影：善用柔和卡片阴影（如 shadow-lg、shadow-xl）和边框（border border-gray-100）区分层级，避免扁平廉价的纯色块
4. 圆角：全局使用现代化圆角（如 rounded-2xl、rounded-full），拒绝尖锐直角
5. 色彩克制：除非游戏效果需要，避免高饱和度原色（如 #FF0000），多用低饱和度莫兰迪色系或现代渐变（如 bg-gradient-to-r from-cyan-500 to-blue-500）
6. 文案：拒绝「欢迎来到我的网站」「点击这里」等无聊机器文案，使用有幽默感、极客感或煽动性的拟人化文案

【项目路径规则】
1. 操作项目文件时，必须使用消息中提供的「项目Path」作为项目根目录
2. 禁止自行猜测、编造或替换项目路径
3. read/write 文件时 path 参数使用相对路径（如 src/App.vue），不要编造绝对路径`

export const message = [
  { role: "system", content: SYSTEM_PROMPT },
]

function resetMessage() {
  message = [
    { role: "system", content: SYSTEM_PROMPT },
  ]
}

/**
 * 将工具参数绑定到后台项目根目录，避免 AI 编造错误路径
 * @param {string} name 工具名称
 * @param {object} args AI 传入的参数
 * @param {string} projectDirPath 后台项目根目录
 */
function bindProjectDirPath(name, args, projectDirPath) {
  if (!projectDirPath) return args

  const bound = { ...args }
  bound.dirPath = projectDirPath

  if (name !== 'get_file_content' && name !== 'write_file_content') return bound

  const filePath = String(args.path || '').trim()
  if (!filePath) return bound

  const normRoot = path.normalize(projectDirPath)
  const normPath = path.normalize(filePath)

  if (normPath.startsWith(normRoot + path.sep) || normPath === normRoot) {
    bound.path = path.relative(normRoot, normPath)
    return bound
  }

  if (path.isAbsolute(normPath)) {
    const srcSep = `${path.sep}src${path.sep}`
    const srcIdx = normPath.indexOf(srcSep)
    if (srcIdx !== -1) {
      bound.path = normPath.slice(srcIdx + 1)
      return bound
    }
    if (normPath.endsWith(`${path.sep}index.html`) || normPath.endsWith('/index.html')) {
      bound.path = 'index.html'
      return bound
    }
    bound.path = path.basename(normPath)
  }

  return bound
}

/**
 * 将流式 tool_calls 增量片段合并为完整的 tool call 列表
 * @param {Record<number, object>} toolCallsMap 按 index 累积的 tool call 映射
 * @param {Array} deltaToolCalls 当前 chunk 中的 tool_calls 增量
 */
function mergeToolCallDeltas(toolCallsMap, deltaToolCalls) {
  for (const tc of deltaToolCalls) {
    const index = tc.index
    if (!toolCallsMap[index]) {
      toolCallsMap[index] = {
        id: '',
        type: 'function',
        function: { name: '', arguments: '' },
      }
    }
    const target = toolCallsMap[index]
    if (tc.id) target.id = tc.id
    if (tc.type) target.type = tc.type
    if (tc.function?.name) target.function.name += tc.function.name
    if (tc.function?.arguments) target.function.arguments += tc.function.arguments
  }
}

/**
 * 与 AI 对话，并通过 onEvent 向前台推送事件
 * @param {string} userMessage 用户消息
 * @param {(event: object) => void} onEvent 事件回调
 * @param {Array} context 对话上下文
 * @param {string} projectDirPath 后台项目根目录，工具执行时强制使用
 */
export async function chat(userMessage="", onEvent=(msg)=>{process.stdout.write(msg)}, context=message, projectDirPath="") {
  const toolCallsMap = {}
  let finishReason = null
  if(userMessage) context.push({role: "user", content: userMessage})
  
  const stream = await client.chat.completions.create({
    model: "deepseek-v4-flash",
    messages: context,
    tools: tools,
    tool_choice: "auto",
    stream: true,
  })

  for await (let chunk of stream) {
    const delta = chunk.choices[0].delta

    if (delta.content) onEvent({event: 'text', data: delta.content})
    if (delta.tool_calls) mergeToolCallDeltas(toolCallsMap, delta.tool_calls)
    if (chunk.choices[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason
  }

  const toolCalls = Object.keys(toolCallsMap)
    .sort((a, b) => Number(a) - Number(b))
    .map((key) => toolCallsMap[key])

  if (toolCalls.length > 0) {
    context.push({role: "assistant", content: null, tool_calls: toolCalls})
    for (const toolCall of toolCalls) {
      const id = toolCall.id
      const name = toolCall.function.name
      const originArgs = JSON.parse(toolCall.function.arguments)
      const args = {}
      const keys = Object.keys(originArgs)
      for (const key of keys) args[key] = originArgs[key]
      const boundArgs = bindProjectDirPath(name, args, projectDirPath)
      onEvent({event: 'tool_start', data: `正在执行工具: ${name} $$ 参数: ${JSON.stringify(boundArgs)}`})
      const result = await functionMap[name](boundArgs)
      context.push({role: "tool", content: result, tool_call_id: id})
      onEvent({event: 'tool_end', data: `工具执行完毕: ${name} $$ 结果: ${result}`})
    }
    await chat("", onEvent, context, projectDirPath)
  } else {
    const tokenCount = countContextTokens(context)
    console.log(`[上下文] 当前 token 数: ${tokenCount}，消息条数: ${context.length}`)
  }
}

export async function keepContext(account,projectId,title) {
  const [res] = await connection.query('select * from sessions where account = ? and project_id = ? and title = ? ', [account,projectId,title]);
  if(res.length === 0) return {result:res,length:res.length}
  for(const item of res){
    if(item.message_id){
      const [res1] = await connection.query('select * from messages where id = ?', [item.message_id]);
      if(res1.length === 0) continue;
      item.content = res1[0].content;
    }
  }
  return {result:res,length:res.length}
}