import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import OpenAI from 'openai'
import { encodingForModel } from 'js-tiktoken'
import { baseURL, key } from '../../key.js'
import { tools, functionMap } from './tools.js'
import connection from '../../Mysql/index.js';
import { describeImage } from './image-desc.js'

const client = new OpenAI({
    apiKey: key,
    baseURL: baseURL,
})

/**
 * Token 估算器。实际消耗优先使用模型返回的 usage；这里只用于上下文阈值判断和 usage 缺失时兜底。
 * 当前编码器与 CHAT_MODEL 不完全一致，因此 countContextTokens 的结果是近似值。
 */
const tokenizer = encodingForModel('gpt-4')
/** 主对话与摘要压缩使用的模型。 */
const CHAT_MODEL = process.env.AI_CHAT_MODEL || 'deepseek-v4-pro'
/** 应用侧声明的上下文预算；它不会改变上游模型自身的上下文能力。 */
const CONTEXT_LIMIT_TOKENS = Math.max(Number(process.env.AI_CONTEXT_LIMIT_TOKENS) || 1_000_000, 4096)
/** 达到上下文预算的该比例后尝试压缩。 */
const CONTEXT_COMPRESSION_RATIO = Math.min(Math.max(Number(process.env.AI_CONTEXT_COMPRESSION_RATIO) || 0.8, 0.5), 0.95)
const CONTEXT_COMPRESSION_THRESHOLD = Math.floor(CONTEXT_LIMIT_TOKENS * CONTEXT_COMPRESSION_RATIO)
/** 历史摘要允许生成的最大 Token 数。 */
const SUMMARY_MAX_TOKENS = Math.max(Number(process.env.AI_SUMMARY_MAX_TOKENS) || 1600, 256)
/** 压缩时始终保留的最近用户轮次数。 */
const RECENT_USER_TURNS_TO_KEEP = Math.max(Number(process.env.AI_RECENT_TURNS_TO_KEEP) || 3, 1)

/**
 * 估算 messages 上下文长度，覆盖文本、工具调用参数和 tool_call_id 等字段。
 * 该值用于压缩阈值和 currentContextTokens，不等同于模型服务返回的实际计费用量。
 * @param {Array<object>} context OpenAI messages 结构的上下文数组
 * @returns {number} 估算 Token 数
 */
export function countContextTokens(context) {
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

/**
 * 创建一次完整用户请求共用的用量统计器。
 * 所有工具递归、视觉分析和摘要调用都累加到同一对象，最终只结算一次。
 * @param {Array<object>} context 加入本轮用户消息前的上下文
 * @returns {object} 本轮可变统计状态
 */
const createUsageTracker = (context) => ({
  promptTokens: 0,
  completionTokens: 0,
  contextTokensBefore: countContextTokens(context),
  currentContextTokens: 0,
  modelCalls: 0,
  estimated: false,
  compressed: false,
  summary: null,
  summarizedUntilSessionId: null,
  assistantText: '',
})

/**
 * 将一次模型调用的 usage 累加到本轮统计器。
 * 模型未返回 usage 时采用调用前准备的估算值，并将整轮标记为 estimated。
 * @param {object} tracker 本轮共享的用量统计器
 * @param {object|null|undefined} usage 模型返回的 usage
 * @param {number} fallbackPromptTokens 输入 Token 兜底估算值
 * @param {number} fallbackCompletionTokens 输出 Token 兜底估算值
 * @returns {void}
 */
const addUsage = (tracker, usage, fallbackPromptTokens, fallbackCompletionTokens) => {
  const hasUsage = usage && Number.isFinite(Number(usage.prompt_tokens)) && Number.isFinite(Number(usage.completion_tokens))
  tracker.promptTokens += hasUsage ? Number(usage.prompt_tokens) : fallbackPromptTokens
  tracker.completionTokens += hasUsage ? Number(usage.completion_tokens) : fallbackCompletionTokens
  tracker.modelCalls += 1
  if (!hasUsage) tracker.estimated = true
}

/**
 * 移除仅供服务端追踪摘要范围的内部字段，生成可安全发送给模型的 messages。
 * @param {Array<object>} context 带 _sessionId 等内部元数据的上下文
 * @returns {Array<object>} 仅包含模型 API 支持字段的消息数组
 */
const toApiMessages = (context) => context.map(({ role, content, tool_calls, tool_call_id, name }) => ({
  role,
  content,
  ...(tool_calls ? { tool_calls } : {}),
  ...(tool_call_id ? { tool_call_id } : {}),
  ...(name ? { name } : {}),
}))

/** 创建统一的用户取消异常，供上层区分 cancelled 与 failed。 */
const abortError = () => Object.assign(new Error('生成已取消'), { name: 'AbortError' })

/**
 * 在模型调用和工具执行边界检查取消信号。
 * @param {AbortSignal|undefined} signal 当前生成任务的取消信号
 * @throws {Error} signal 已取消时抛出 name=AbortError 的异常
 */
const throwIfAborted = (signal) => {
  if (signal?.aborted) throw abortError()
}

/**
 * 找到历史压缩的结束下标：system prompt 不参与压缩，并保留最近若干个用户轮次。
 * @param {Array<object>} context 当前完整上下文
 * @returns {number} 作为 context.slice(1, cutoff) 结束位置的下标；-1 表示暂无可压缩历史
 */
function findCompressionCutoff(context) {
  const userIndexes = []
  for (let i = 1; i < context.length; i += 1) {
    if (context[i].role === 'user') userIndexes.push(i)
  }
  if (userIndexes.length <= RECENT_USER_TURNS_TO_KEEP) return -1
  return userIndexes[userIndexes.length - RECENT_USER_TURNS_TO_KEEP]
}

/**
 * 当上下文达到阈值时，把较早历史总结成一条累计摘要并原地替换旧消息。
 * 摘要调用本身的 Token 会计入 tracker；成功后记录摘要覆盖到的最大 sessions.id，供重启恢复。
 * 压缩状态通过 context_compress_start/done/error 事件实时通知前端，摘要正文不会通过 SSE 暴露。
 * @param {Array<object>} context 会被原地修改的当前上下文
 * @param {object} tracker 本轮共享的用量统计器
 * @param {AbortSignal|undefined} signal 当前生成任务的取消信号
 * @param {(event: object) => void} onEvent SSE 事件回调
 * @returns {Promise<void>}
 */
async function compressContext(context, tracker, signal, onEvent) {
  const beforeTokens = countContextTokens(context)
  if (beforeTokens < CONTEXT_COMPRESSION_THRESHOLD) return

  const cutoff = findCompressionCutoff(context)
  if (cutoff <= 1) return

  const oldMessages = context.slice(1, cutoff)
  const existingMarker = oldMessages.reduce(
    (max, item) => Math.max(max, Number(item._summarizedUntilSessionId) || Number(item._sessionId) || 0),
    0
  )
  const summaryInput = oldMessages.map(({ role, content, tool_calls }) => ({ role, content, tool_calls }))
  const summaryPrompt = `请将以下历史对话压缩成一份可供后续编程助手继续工作的中文摘要。必须保留：用户目标、已确认决策、已修改文件、关键代码/API、工具执行结果、未完成事项和约束。不要添加原对话中不存在的信息。\n\n${JSON.stringify(summaryInput)}`
  const promptMessages = [
    { role: 'system', content: '你负责压缩编程会话上下文，只输出结构化、事实准确的摘要。' },
    { role: 'user', content: summaryPrompt },
  ]
  const fallbackPromptTokens = countContextTokens(promptMessages)
  throwIfAborted(signal)
  onEvent({
    event: 'context_compress_start',
    data: {
      beforeTokens,
      thresholdTokens: CONTEXT_COMPRESSION_THRESHOLD,
      contextLimit: CONTEXT_LIMIT_TOKENS,
    },
  })

  let response
  try {
    response = await client.chat.completions.create({
      model: CHAT_MODEL,
      messages: promptMessages,
      max_tokens: SUMMARY_MAX_TOKENS,
    }, { signal })
  } catch (error) {
    onEvent({
      event: 'context_compress_error',
      data: { message: error?.message || '上下文压缩失败' },
    })
    throw error
  }
  const summary = response.choices?.[0]?.message?.content?.trim()
  if (!summary) {
    onEvent({
      event: 'context_compress_error',
      data: { message: '压缩模型未返回摘要' },
    })
    return
  }

  const fallbackCompletionTokens = tokenizer.encode(summary).length
  addUsage(tracker, response.usage, fallbackPromptTokens, fallbackCompletionTokens)
  const summaryMessage = {
    role: 'system',
    content: `【历史对话压缩摘要】\n${summary}`,
    _isSummary: true,
    _summarizedUntilSessionId: existingMarker || null,
  }
  context.splice(1, cutoff - 1, summaryMessage)
  tracker.compressed = true
  tracker.summary = summary
  tracker.summarizedUntilSessionId = existingMarker || tracker.summarizedUntilSessionId
  onEvent({
    event: 'context_compress_done',
    data: {
      beforeTokens,
      afterTokens: countContextTokens(context),
    },
  })
}

/** 本地默认系统提示词文件路径 */
const SYSTEM_PROMPT_PATH = fileURLToPath(new URL('./system-prompt.md', import.meta.url))

/** 项目内 Master Skills 相对路径 */
const PROJECT_SKILLS_REL_PATH = path.join('agent_base', 'skills', 'system-prompt.md')

/**
 * 读取 Master Skills 规范：优先项目 agent_base/skills/system-prompt.md，不存在则用本地默认
 * @param {string} [projectDirPath] 项目根目录
 * @returns {string}
 */
function getMasterSkillsPrompt(projectDirPath) {
  if (projectDirPath) {
    const projectSkillsPath = path.join(projectDirPath, PROJECT_SKILLS_REL_PATH)
    if (fs.existsSync(projectSkillsPath)) {
      return fs.readFileSync(projectSkillsPath, 'utf-8').trim()
    }
  }
  return fs.readFileSync(SYSTEM_PROMPT_PATH, 'utf-8').trim()
}

/**
 * 构建完整系统提示词
 * @param {string} [projectDirPath] 项目根目录
 * @returns {string}
 */
function buildSystemPrompt(projectDirPath) {
  const masterSkillsPrompt = getMasterSkillsPrompt(projectDirPath)
  return `# Role
你是一个高级程序员，擅长使用前端技术栈开发项目涉及到canvas游戏与网页工具并具备良好的审美和交互体验。

# Execution Rules (优先级)
1. **意图识别**：若用户只是闲聊或提问，忽略项目背景直接回答。
2. **开发流程**：写代码前必须先调用 ListDir/ReadFile 查看项目结构和文件内容。
3. **技术栈**：Vant (组件优先) + Tailwind CSS (布局优先 flex/grid)。
4. **路径规则**：必须使用提供的「项目Path」作为根目录，read/write 使用相对路径。
5. **视觉输入**：当用户消息含「视觉模型分析结果」时，系统已代你完成看图，该内容等同于你亲眼所见。必须直接基于此回答，禁止说「无法查看图片」「我看不到图像」「根据你附带的分析报告」；禁止追问或评论视觉工具来源。UI 改样式时优先采纳其中的样式参数与执行建议。

## 移动端适配
项目默认面向移动端预览，编写 UI 时必须遵守：
1. 布局按移动端宽度设计（约 375px），使用 flex/grid + Tailwind，避免写死过大的固定宽度
2. 交互按触摸设计：可点击区域足够大，避免 hover 作为唯一反馈
3. 页面需适配安全区（如底部栏使用 safe-area / pb-safe 等），避免被刘海或手势条遮挡
4. 文字与间距在小屏可读，禁止出现横向溢出（overflow-x）
5. Canvas 游戏区域需适配容器宽度，保持比例，避免超出视口

## 修改克制（强制）

1. 【新建/首版实现】允许一次完整实现；写完后停止，等待用户反馈，禁止在同一轮里反复重写「再优化」
2. 【迭代修改】用户指出具体问题后，只改该问题；同一文件原则上最多再写 1～2 次，禁止无明确问题时整文件重做
3. 用户未指出问题时，禁止主动重构、换实现、重做样式或「顺便优化」
4. 修改范围最小化：只改用户要求的点，无关代码保持原样
5. 仅当改动会推翻现有架构/大面积重写时，先说明方案再动手；普通功能实现与小修直接做

## 跨域图片规范（WebContainer + COS）

预览环境启用了 Cross-Origin Isolation，加载 COS 等跨域图片时必须遵守：

1. 使用 <img> 加载外部图片 URL 时，必须加 crossorigin="anonymous"
2. 禁止使用 CSS background-image / mask-image 引用外部 COS URL
3. 需要“背景图”效果时，用绝对定位的 <img> 模拟：
   <div class="relative">
     <img crossorigin="anonymous" src="..." class="absolute inset-0 w-full h-full object-cover" />
     <div class="relative z-10">...</div>
   </div>
4. Canvas 中 drawImage 外部图片前，先用 new Image() 并设置 img.crossOrigin = 'anonymous'
5. 项目内本地资源不受此限制,项目中的图片统一放在项目根目录下的public目录下

## 文件操作规则
1. 修改已有文件前，必须先使用 get_file_list 和 get_file_content 查看最新项目结构与文件内容。
2. 创建全新文件，或预计修改已有文件 40% 及以上、重构文件整体结构时，必须使用 write_file_content 并传入完整文件内容。
3. 预计修改已有文件不足 40% 时，必须使用 upsert_file；每个 hunk 正文不得超过 120 行，只保留修改点前后各 3-5 行上下文，分散的修改必须拆成多个小 hunk，禁止用一个 hunk 覆盖整个文件。
4. 直接删除文件时使用 delete_file；delete_file 仅允许删除 src 或 public 目录下的文件。
5. upsert_file 的 patch 必须使用项目相对路径，并带 a/ 与 b/ 前缀；新增文件使用 --- /dev/null，删除文件使用 +++ /dev/null；@@ 头部的旧/新行数必须分别等于正文中上下文与删除/新增行的总数；不要输出完整文件内容。
6. 如果 upsert_file 返回 PATCH_TOO_LARGE，必须改用 write_file_content；如果返回 HUNK_TOO_LARGE，必须重新读取文件并拆成多个小 hunk；其他失败必须重新读取最新文件并生成修正后的小 patch，禁止直接切换为全量覆盖写入。

# Disable Change
禁止修改项目下的agent_base项目底座下的所有文件，新增删除修改都不允许。当用户指定修改agent_base项目底座下的文件时，提示没有权限进行修改。

# Language
在回答用户问题时，必须使用中文回答。

# Expertise Integration
在编写任何 UI 或逻辑代码时，必须严格遵循以下 [Master Skills] 规范，以确保产品具备顶级的视觉审美和交互体验。


${masterSkillsPrompt}`
}

/** 系统提示词（基础规则 + Master Skills，无项目目录时使用本地默认） */
const SYSTEM_PROMPT = buildSystemPrompt()

export const message = [
  { role: "system", content: SYSTEM_PROMPT },
]

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

  if (name !== 'get_file_content' && name !== 'write_file_content' && name !== 'delete_file' && name !== 'download_file') return bound

  const filePath = String(args.path || '').trim()
  if (!filePath) return bound

  const normRoot = path.normalize(projectDirPath)
  const normPath = path.normalize(filePath)

  if (normPath.startsWith(normRoot + path.sep) || normPath === normRoot) {
    bound.path = path.relative(normRoot, normPath)
    return bound
  }

  if (path.isAbsolute(normPath)) {
    // 下载工具：绝对路径若含 public 段，截取为 public 起的相对路径
    if (name === 'download_file') {
      const publicSep = `${path.sep}public${path.sep}`
      const publicIdx = normPath.indexOf(publicSep)
      if (publicIdx !== -1) {
        bound.path = normPath.slice(publicIdx + 1)
        return bound
      }
      if (normPath.endsWith(`${path.sep}public`) || normPath.endsWith('/public')) {
        bound.path = 'public'
        return bound
      }
      bound.path = path.join('public', path.basename(normPath))
      return bound
    }

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
 * 将视觉模型结果与用户指令拼成 DS 可消费的 user 消息
 * @param {string} visionResult 视觉模型输出
 * @param {string} userMessage 完整用户消息（含项目背景等）
 * @param {string} prompt 用户原始问题
 */
function buildUserContent(visionResult, userMessage, prompt) {
  const instruction = userMessage || prompt;
  if (!visionResult) return instruction;

  return `【视觉模型分析结果 - 系统已代你看图，等同于你已亲眼所见】
以下由专用视觉模型对用户上传图片的分析结果，请将其视为你的视觉输入，直接回答用户问题。

禁止：
- 不要说「无法查看图片」「我看不到图像」「根据你附带的视觉分析报告」
- 不要追问或评论视觉分析工具的来源
- 作答时用「图中…」「从图片可见…」，不要暴露双模型架构

${visionResult}

${instruction}`;
}

/**
 * 执行一次主模型请求，并在模型返回 tool_calls 时执行工具后递归继续。
 * 同一完整用户请求内的所有递归调用共享 context、tracker 和 signal；只有首次调用会添加用户消息和分析图片。
 * @param {string} userMessage 主模型使用的完整用户消息，通常包含项目背景
 * @param {(event: object) => void} onEvent 文本、工具、视觉和压缩状态事件回调
 * @param {Array<object>} context 会被原地追加消息或压缩的对话上下文
 * @param {string} projectDirPath 工具执行时强制绑定的项目根目录
 * @param {string[]} imageUrls 首次调用需要分析的图片地址；工具递归时为空数组
 * @param {string} prompt 用户原始指令，用于视觉分析等场景
 * @param {object} tracker 整轮对话共享的用量统计器
 * @param {AbortSignal|undefined} signal 当前生成任务的取消信号
 * @param {boolean} appendUserMessage 是否把本轮用户消息追加到 context，仅首次调用为 true
 * @param {number|string|null} userSessionId 本轮用户消息对应的 sessions.id
 * @param {number|string|null} assistantSessionId 本轮 assistant 消息对应的 sessions.id
 * @returns {Promise<void>} 所有工具递归和最终回复完成后返回
 */
async function runChat(userMessage, onEvent, context, projectDirPath, imageUrls, prompt, tracker, signal, appendUserMessage, userSessionId=null, assistantSessionId=null, toolContext={}) {
  throwIfAborted(signal)
  let ImageResponse = ""

  if (Array.isArray(imageUrls) && imageUrls.length > 0) {
    onEvent({ event: 'vision_start', data: null })
    const result = await describeImage(prompt || userMessage, imageUrls, onEvent, signal)
    ImageResponse = result?.response ?? ""
    addUsage(
      tracker,
      result?.usage,
      tokenizer.encode(`${prompt || userMessage}\n${JSON.stringify(imageUrls)}`).length,
      tokenizer.encode(`${result?.reasoning || ''}${ImageResponse}`).length
    )
    if (ImageResponse) onEvent({ event: 'vision_done', data: ImageResponse })
  }

  const toolCallsMap = {}
  let assistantText = ""

  if (appendUserMessage && (userMessage || prompt)) {
    const content = buildUserContent(ImageResponse, userMessage, prompt);
    context.push({ role: "user", content, _sessionId: userSessionId });
  }

  await compressContext(context, tracker, signal, onEvent)
  const apiMessages = toApiMessages(context)
  const fallbackPromptTokens = countContextTokens(apiMessages)

  const stream = await client.chat.completions.create({
    model: CHAT_MODEL,
    messages: apiMessages,
    tools: tools,
    tool_choice: "auto",
    stream: true,
    stream_options: { include_usage: true },
  }, { signal })

  let requestUsage = null
  let requestSettled = false
  try {
    for await (const chunk of stream) {
      if (chunk.usage) requestUsage = chunk.usage
      if (!chunk.choices?.length) continue
      const delta = chunk.choices[0].delta

      if (delta.content) {
        assistantText += delta.content
        tracker.assistantText += delta.content
        onEvent({ event: 'text', data: delta.content })
      }
      if (delta.tool_calls) mergeToolCallDeltas(toolCallsMap, delta.tool_calls)
    }
    const fallbackCompletionTokens = countContextTokens([{
      role: 'assistant',
      content: assistantText || null,
      tool_calls: Object.values(toolCallsMap),
    }])
    addUsage(tracker, requestUsage, fallbackPromptTokens, fallbackCompletionTokens)
    requestSettled = true
  } catch (error) {
    if (!requestSettled) {
      const fallbackCompletionTokens = countContextTokens([{
        role: 'assistant',
        content: assistantText || null,
        tool_calls: Object.values(toolCallsMap),
      }])
      addUsage(tracker, requestUsage, fallbackPromptTokens, fallbackCompletionTokens)
    }
    throw error
  }

  const toolCalls = Object.keys(toolCallsMap)
    .sort((a, b) => Number(a) - Number(b))
    .map((key) => toolCallsMap[key])

  if (toolCalls.length > 0) {
    context.push({ role: "assistant", content: assistantText || null, tool_calls: toolCalls })
    for (const toolCall of toolCalls) {
      const id = toolCall.id
      const name = toolCall.function.name
      const originArgs = JSON.parse(toolCall.function.arguments)
      const args = {}
      const keys = Object.keys(originArgs)
      for (const key of keys) args[key] = originArgs[key]
      const boundArgs = bindProjectDirPath(name, args, projectDirPath)
      onEvent({ event: 'tool_start', data: `正在执行工具: ${name} $$ 参数: ${JSON.stringify(boundArgs)}` })
      throwIfAborted(signal)
      const handler = functionMap[name]
      if (!handler) throw new Error('未注册的工具: ' + name)
      const result = await handler(boundArgs, {
        ...toolContext,
        assistantSessionId,
        toolCallId: id,
        onEvent,
        signal,
      })
      throwIfAborted(signal)
      context.push({ role: "tool", content: result, tool_call_id: id })
      onEvent({ event: 'tool_end', data: `工具执行完毕: ${name} $$ 结果: ${result}` })
    }
    await runChat("", onEvent, context, projectDirPath, [], prompt, tracker, signal, false, null, assistantSessionId, toolContext)
  } else if (assistantText) {
    context.push({ role: "assistant", content: assistantText, _sessionId: assistantSessionId })
  }
}

/**
 * 在一整轮生成结束后移除仅供当前推理使用的 tool/tool_calls 消息。
 * 本轮所有已推送文本会合并到最终 assistant 消息，使热缓存结构与数据库恢复后的消息结构尽量一致。
 * @param {Array<object>} context 会被原地整理的上下文
 * @param {number|string|null} assistantSessionId 最终 assistant 消息对应的 sessions.id
 * @param {string} assistantText 本轮所有模型调用产生的可见文本
 * @returns {void}
 */
function pruneCompletedToolContext(context, assistantSessionId, assistantText) {
  const retained = context.filter((item) => item.role !== 'tool' && !item.tool_calls)
  const finalAssistant = retained[retained.length - 1]
  if (finalAssistant?.role === 'assistant') {
    finalAssistant.content = assistantText || finalAssistant.content
    finalAssistant._sessionId = assistantSessionId || finalAssistant._sessionId
  } else if (assistantText) {
    retained.push({ role: 'assistant', content: assistantText, _sessionId: assistantSessionId })
  }
  context.splice(0, context.length, ...retained)
}

/**
 * 完成一次从用户输入到最终回复、失败或取消的完整 AI 对话任务。
 * 该外层入口负责初始化 system prompt 和 tracker、启动工具递归、整理最终上下文，并返回整轮汇总 usage。
 * 失败或取消时不会吞掉异常，而是把已产生的部分用量放到 error.chatUsage，供流管理层继续结算。
 * @param {string} userMessage 主模型使用的完整用户消息
 * @param {(event: object) => void} onEvent 流式事件回调
 * @param {Array<object>} context 会被原地更新的会话上下文
 * @param {string} projectDirPath 当前项目根目录
 * @param {string[]} imageUrls 本轮用户上传的图片地址
 * @param {string} prompt 用户原始指令
 * @param {{signal?: AbortSignal, userSessionId?: number|string, assistantSessionId?: number|string}} options 任务取消信号与消息 ID
 * @returns {Promise<object>} 本轮输入/输出 Token、调用次数、压缩状态和最终上下文长度
 * @throws {Error} 模型、工具或取消异常；已产生的用量位于 error.chatUsage
 */
export async function chat(userMessage="", onEvent=(msg)=>{process.stdout.write(msg)}, context=message, projectDirPath="", imageUrls=[], prompt="", options={}) {
  if (context.length > 0 && context[0].role === 'system') context[0].content = buildSystemPrompt(projectDirPath)
  const tracker = createUsageTracker(context)
  try {
    await runChat(
      userMessage,
      onEvent,
      context,
      projectDirPath,
      imageUrls,
      prompt,
      tracker,
      options.signal,
      true,
      options.userSessionId,
      options.assistantSessionId,
      options.toolContext || {}
    )
    pruneCompletedToolContext(context, options.assistantSessionId, tracker.assistantText)
    tracker.currentContextTokens = countContextTokens(context)
    const result = {
      ...tracker,
      totalTokens: tracker.promptTokens + tracker.completionTokens,
      contextLimit: CONTEXT_LIMIT_TOKENS,
    }
    delete result.assistantText
    return result
  } catch (error) {
    pruneCompletedToolContext(context, options.assistantSessionId, tracker.assistantText)
    tracker.currentContextTokens = countContextTokens(context)
    error.chatUsage = {
      ...tracker,
      totalTokens: tracker.promptTokens + tracker.completionTokens,
      contextLimit: CONTEXT_LIMIT_TOKENS,
    }
    delete error.chatUsage.assistantText
    throw error
  }
}

/**
 * 从数据库恢复会话消息。存在累计摘要时，只读取摘要覆盖位置之后的 sessions 记录。
 * assistant/vision 正文存放在 messages 表，因此查询后会按 message_id 回填 content。
 * @param {string} account 会话所属账号
 * @param {number|string} projectId 项目 ID
 * @param {string} title 旧版兼容查询使用的会话标题
 * @param {number|string|null} conversationId 稳定会话 ID，存在时优先按它查询
 * @param {number|string|null} summarizedUntilSessionId 已被摘要覆盖到的最大 sessions.id
 * @returns {Promise<{result: Array<object>, length: number}>} 按 sessions.id 升序排列的未压缩消息
 */
export async function keepContext(account,projectId,title,conversationId=null,summarizedUntilSessionId=null) {
  const params = conversationId
    ? [account, projectId, conversationId, Number(summarizedUntilSessionId) || 0]
    : [account, projectId, title]
  const sql = conversationId
    ? `select s.*, coalesce(m.content, s.content, '') as content
         from sessions s left join messages m on m.id = s.message_id
        where s.account = ? and s.project_id = ? and s.conversation_id = ? and s.id > ?
        order by s.id asc`
    : `select s.*, coalesce(m.content, s.content, '') as content
         from sessions s left join messages m on m.id = s.message_id
        where s.account = ? and s.project_id = ? and s.title = ?
        order by s.id asc`
  const [res] = await connection.query(sql, params);
  return {result:res,length:res.length}
}
