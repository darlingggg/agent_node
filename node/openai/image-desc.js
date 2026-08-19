import OpenAI from 'openai'
import { imageKey, imageBaseURL } from '../../key.js'

/** 是否开启思考过程 */
const ENABLE_THINKING = true
/** 思考过程最大 token 数（多图场景预留更充裕的推理空间） */
const THINKING_BUDGET = 768
/** 正式回复最大 token 数 */
const MAX_TOKENS = 1024

const client = new OpenAI({
  apiKey: imageKey,
  baseURL: imageBaseURL,
})

const systemPrompt = `
你是一个资深前端视觉分析专家。你的任务是将图片信息转化为精准的技术描述，以便后续的代码模型执行修改。
分析准则：
区分意图：判断图片是布局参考(UI Reference)还是素材资源(Static Asset)。
技术规格：优先提取颜色（Hex/RGB）、间距（px/rem）、圆角、阴影、层级关系。
布局描述：使用 Flexbox 或 Grid 术语描述结构（如：justify-between, align-center）。
素材处理：如果是 Logo 或插图，将图片链接也输出到结果，供下游使用。
简洁性：不要口水话，直接输出技术特征。如果不确定，请回复'无法通过图片确定具体参数'，禁止反复纠正。`

/**
 * 调用视觉模型分析用户图片，并把思考过程和正式回答以事件形式向主对话流转发。
 * 返回的 usage 会由主对话 tracker 累加；signal 用于用户终止时取消当前视觉请求。
 * @param {string} prompt 用户原始指令
 * @param {string|string[]} imageUrls 一张或多张图片地址
 * @param {(event: object) => void} onEvent 视觉分析流式事件回调
 * @param {AbortSignal|undefined} signal 当前生成任务的取消信号
 * @returns {Promise<{reasoning: string, response: string, usage: object|null}>} 完整视觉分析、正式回答和模型用量
 */
export async function describeImage(prompt, imageUrls,onEvent=(msg)=>{process.stdout.write(msg)}, signal=undefined) {
  let promptImageUrl = []
  if(Array.isArray(imageUrls)) promptImageUrl = imageUrls.map(url => ({ type: "image_url", image_url: { url } }))
  else promptImageUrl = [{ type: "image_url", image_url: { url: imageUrls } }]

  onEvent({event: 'visual_start', data: null})
  try {
    const stream = await client.chat.completions.create({
      model: "qwen3.7-plus",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: [
          ...promptImageUrl,
          { type: "text", text: `用户指令：${prompt}\n图像链接：${JSON.stringify(imageUrls)}
请根据用户指令分析图片。如果是 UI 截图，请详细提取布局（Flex/Grid）、颜色（Hex码）、间距和字体大小。如果是素材图，请在输出的时候带上图片链接。` }
        ]},
      ],
      stream: true,
      max_tokens: MAX_TOKENS,
      // Node.js SDK 中非 OpenAI 标准参数作为顶层属性传入
      enable_thinking: ENABLE_THINKING,
      thinking_budget: THINKING_BUDGET,
      stream_options: { include_usage: true },
    }, { signal })

    const reasoningParts = []
    const contentParts = []
    let usage = null
    let isAnswering = false

    for await (const chunk of stream) {
      if (chunk.usage) usage = chunk.usage
      if (!chunk.choices?.length) {
        continue
      }

      const delta = chunk.choices[0].delta

      // 思考过程（reasoning_content）
      if (delta.reasoning_content) {
        onEvent({event: 'visual_analysis', data: delta.reasoning_content})
        reasoningParts.push(delta.reasoning_content)
      }
      // 正式回复（content）
      else if (delta.content) {
        if (!isAnswering) {
          isAnswering = true
        }
        onEvent({event: 'visual_answer', data: delta.content})
        contentParts.push(delta.content)
      }
    }

    onEvent({event: 'visual_done', data: null})
    const fullReasoning = reasoningParts.join("")
    const fullResponse = contentParts.join("")
    return { reasoning: fullReasoning, response: fullResponse, usage }

    // if (fullReasoning) {
    //   console.log(`\n--- 完整思考 ---\n${fullReasoning}`)
    // }
    // console.log(`\n--- 完整回复 ---\n${fullResponse}`)

  } catch (error) {
    throw error
  }
}
