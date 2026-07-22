import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import OpenAI from 'openai'
import { encodingForModel } from 'js-tiktoken'
import { baseURL, key } from '../../key.js'
import { tools, functionMap } from './tools.js'
import connection from '../../Mysql/index.js';
import { describeImage } from './image.js'

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
2. 修改已有文件时，优先使用 upsert_file 并传入 unified diff patch；小范围或中等范围修改禁止使用 write_file_content。
3. write_file_content 仅用于创建全新文件，或明确需要重写大部分文件内容的场景。
4. 直接删除文件时使用 delete_file；delete_file 仅允许删除 src 或 public 目录下的文件。
5. upsert_file 的 patch 必须使用项目相对路径，并带 a/ 与 b/ 前缀；新增文件使用 --- /dev/null，删除文件使用 +++ /dev/null；必须包含足够的 @@ hunk 上下文；不要输出完整文件内容。
6. 如果 upsert_file 执行失败，必须重新读取最新文件内容并生成修正后的 patch，禁止直接切换为全量覆盖写入。

# Disable Change
禁止修改项目下的agent_base项目底座下的所有文件，新增删除修改都不允许。当用户指定修改agent_base项目底座下的文件时，提示没有权限进行修改。

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
 * 与 AI 对话，并通过 onEvent 向前台推送事件
 * @param {string} userMessage 用户消息
 * @param {(event: object) => void} onEvent 事件回调
 * @param {Array} context 对话上下文
 * @param {string} projectDirPath 后台项目根目录，工具执行时强制使用
 */
export async function chat(userMessage="", onEvent=(msg)=>{process.stdout.write(msg)}, context=message, projectDirPath="", imageUrls=[], prompt="") {
  let ImageResponse = ""
  if (context.length > 0 && context[0].role === 'system') context[0].content = buildSystemPrompt(projectDirPath)

  if (Array.isArray(imageUrls) && imageUrls.length > 0) {
    onEvent({ event: 'vision_start', data: null })
    const result = await describeImage(prompt || userMessage, imageUrls, onEvent)
    ImageResponse = result?.response ?? ""
    if (ImageResponse) onEvent({ event: 'vision_done', data: ImageResponse })
  }

  const toolCallsMap = {}
  let assistantText = ""

  if (userMessage || prompt) {
    const content = buildUserContent(ImageResponse, userMessage, prompt);
    context.push({ role: "user", content });
  }

  const stream = await client.chat.completions.create({
    model: "deepseek-v4-pro",
    messages: context,
    tools: tools,
    tool_choice: "auto",
    stream: true,
  })

  for await (let chunk of stream) {
    const delta = chunk.choices[0].delta

    if (delta.content) {
      assistantText += delta.content
      onEvent({ event: 'text', data: delta.content })
    }
    if (delta.tool_calls) mergeToolCallDeltas(toolCallsMap, delta.tool_calls)
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
      const result = await functionMap[name](boundArgs)
      context.push({ role: "tool", content: result, tool_call_id: id })
      onEvent({ event: 'tool_end', data: `工具执行完毕: ${name} $$ 结果: ${result}` })
    }
    await chat("", onEvent, context, projectDirPath, [], prompt)
  } else if (assistantText) {
    context.push({ role: "assistant", content: assistantText })
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
