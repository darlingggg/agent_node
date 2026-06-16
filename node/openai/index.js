import OpenAI from 'openai'
import { baseURL, key } from '../../key.js'
import { tools, functionMap } from './tools.js'

const client = new OpenAI({
    apiKey: key,
    baseURL: baseURL,
})

let message = [
  {role: "system", content: "你是一个高级程序员，擅长使用Web技术栈开发游戏与工具，你会根据用户的需求，并根据文件内容生成完整代码。在开发之前先查看目录结构并查看所需文件内容之后再进行开发。"},
]

function resetMessage() {
  message = [
    {role: "system", content: "你是人工智能助手，你更擅长中文和英文的对话。你会为用户提供安全，有帮助，准确的回答。同时，你会拒绝一切涉及恐怖主义，种族歧视，黄色暴力等问题的回答。"},
  ]
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
 */
export async function chat(userMessage="",onEvent=(msg)=>{process.stdout.write(msg)}) {
  const toolCallsMap = {}
  let finishReason = null

  if(userMessage) message.push({role: "user", content: userMessage})
  
  const stream = await client.chat.completions.create({
    model: "deepseek-v4-pro",
    messages: message,
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
    message.push({role: "assistant", content: null, tool_calls: toolCalls})
    for (const toolCall of toolCalls) {
      const id = toolCall.id
      const name = toolCall.function.name
      const originArgs = JSON.parse(toolCall.function.arguments)
      const args = {}
      const keys = Object.keys(originArgs)
      for (const key of keys) args[key] = originArgs[key]
      onEvent({event: 'tool_start', data: `正在执行工具: ${name}\n`})
      const result = await functionMap[name](args)
      message.push({role: "tool", content: result, tool_call_id: id})
      onEvent({event: 'tool_end', data: `工具执行完毕: ${name}\n`})
    }
    await chat("",onEvent)
  }
}
