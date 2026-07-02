import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
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

/** 系统提示词文件路径 */
const SYSTEM_PROMPT_PATH = fileURLToPath(new URL('./system-prompt.md', import.meta.url))

/** 从 Markdown 文件读取 Master Skills 规范 */
const MASTER_SKILLS_PROMPT = fs.readFileSync(SYSTEM_PROMPT_PATH, 'utf-8').trim()

/** 系统提示词（基础规则 + Master Skills） */
const SYSTEM_PROMPT = `# Role
你是一个高级程序员，擅长开发工具与游戏。

# Execution Rules (优先级)
1. **意图识别**：若用户只是闲聊或提问，忽略项目背景直接回答。
2. **开发流程**：写代码前必须先调用 ListDir/ReadFile 查看项目结构和文件内容。
3. **技术栈**：Vant (组件优先) + Tailwind CSS (布局优先)。
4. **路径规则**：必须使用提供的「项目Path」作为根目录，read/write 使用相对路径。

# Expertise Integration
在编写任何 UI 或逻辑代码时，必须严格遵循以下 [Master Skills] 规范，以确保产品具备顶级的视觉审美和交互体验。

${MASTER_SKILLS_PROMPT}`

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