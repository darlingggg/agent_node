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

const SYSTEM_PROMPT = `【角色设定】
你是一个高级的程序员，擅长使用前端技术栈开发工具与游戏，你可以根据用户的需求，返回符合用户预期的内容。在开发之前先查看目录结构并查看所需文件内容之后再进行开发。

【执行优先级】
1. 始终以「用户最新消息」为唯一决策依据，先理解用户想做什么，再决定下一步
2. 若用户只是闲聊、提问、与项目无关，忽略项目背景，直接回答用户问题
3. 开发前先查看目录结构和相关文件内容，再动手写代码

【技术栈规范】
1. 组件库优先使用 Vant，能用 Vant 组件实现的 UI 不要手写原生或引入其他组件库
2. 2. CSS 样式选用 Tailwind CSS 工具类，可以使用原生的css，哪个效果好就使用哪个，优先使用flex，grid布局

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
    model: "deepseek-v4-pro",
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