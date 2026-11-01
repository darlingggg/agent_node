# 图像理解：原生输入与外接工具

日期：2026-11-01。状态：已实现后端、前端及本地数据库迁移。

## 1. 能力判断

只根据模型列表中的 input_modalities 是否包含 image 判断，不增加探测或人工覆盖。

```js
const capabilities = parseModelJson(model.capabilities) || {};
const supportsVision =
  Array.isArray(capabilities.input_modalities) &&
  capabilities.input_modalities.includes('image');
```

已有模型同步会将该字段保存到 ai_models.capabilities。resolveModelConfig 增加 supportsVision，贯穿同一轮所有递归调用；modelRequestOptions 不向服务商发送该内部字段。缺失、null、非数组或不包含 image 时走外接视觉。

## 2. 对话执行流程

首次上传：原生模式直接将图片附在用户消息中；外接模式向模型提供附件 ID，模型调用 view_image 后取得文字描述。

中途看图：主模型返回 view_image 调用，工具运行器执行后补齐结果，继续现有 runChat 递归。工具 handler 本身不调用 chat、不创建新会话。

```text
原生：主模型 → view_image 读取图片 → tool 加载状态 + user 图片消息
     → 下一次请求发送给同一个主模型 → 模型直接识图并继续任务

外接：主模型 → view_image 读取图片并调用外接视觉服务
     → tool 返回分析文字 → 下一次请求主模型 → 继续任务
```

全程使用 tool_choice:auto。真实接口验证发现当前 DeepSeek 思考模式不接受指定工具的 tool_choice，因此不使用强制工具选择；提示词要求基于图片判断前先取得真实图片或成功分析。

## 3. 工具入参及返回

```js
view_image({
  // imageIds 与 paths 恰好提供一组，最多 6 张
  imageIds: ['img_...'],
  // paths: ['public/reference.png'],
  question: '检查导航栏的布局与颜色',
  detail: 'auto' // auto | low | high
});
```

imageIds 来自上传附件、历史观察或生图结果；paths 是当前项目中的图片路径。项目根目录、账号及能力由后端注入，模型不能自行指定。

原生分支返回加载状态和内部 observation；外接分支复用 image-desc.js 返回文字分析及 usage。图片二进制不进入工具 JSON、SSE 或数据库。

当前使用 Chat Completions，必须保留工具调用和返回的配对。原生续传示例：

```js
[
  {
    role: 'assistant', content: null,
    tool_calls: [{ id: 'call_001', type: 'function', function: {
      name: 'view_image',
      arguments: '{"paths":["public/reference.png"],"question":"检查布局"}'
    }}]
  },
  {
    role: 'tool', tool_call_id: 'call_001',
    content: '{"success":true,"message":"图片已加载，真实图片随后的消息提供"}'
  },
  {
    role: 'user',
    content: [
      { type: 'text', text: '工具 call_001 提供的图片资料，请检查布局并继续原任务。' },
      { type: 'image_url', image_url: { url: imageDataUrl, detail: 'auto' } }
    ]
  }
]
```

如果一批有多个工具，先补齐全部 tool 返回，再追加图片消息。服务端生成的图片资料标记 _origin:tool_attachment，不增加真实用户轮次。外接模式不会向主模型发送 image_url 内容块。

标准消息结构参考 [Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)。

## 4. 代码放置

| 文件 | 职责 |
| --- | --- |
| node/models/config.js | input_modalities → supportsVision |
| node/openai/media/image-input.js | 图片引用、读取校验、消息构建、图片历史恢复 |
| node/openai/media/image-desc.js | 已有外接视觉客户端与流式分析 |
| node/openai/tools/tool-handlers.js | viewImageTool 的原生/外接分支；生图返回图片 ID |
| node/openai/tools/tool-definitions.js | view_image schema |
| node/openai/chat.js | 原有对话循环，配对工具结果、加入观察并递归、汇总用量 |
| node/openai/context/usage.js | 内容数组及图片预算 |
| node/openai/context/context-compression.js | 真实轮次压缩及图片引用保留 |
| node/session/records.js、context/history.js、routes/front/chat.js | 消息保存与恢复，可信会话参数传递 |
| game-agent 的 ChatToolInvocation.vue、toolInvocations.ts、ui-icons.svg | 工具文案、原生加载状态、外接分析正文及独立识图图标 |
| game-agent 的 ChatModelPicker.vue | 展示原生/外接图像理解方式 |

## 5. 图片引用、历史及模型切换

内部图片引用包含稳定 imageId 与来源。上传/生图保存 COS objectKey，读取时重新签名；项目图片保存相对路径与内容版本。仅接受本账号 COS 上传对象或本项目图片文件，不增加任意公网 URL 抓取入口。

复用 sessions 表，新增一个 image_context JSON 字段，保存 images 和 observations，无需新增多张图片/观察表。用户消息记录上传图片引用；助手消息记录成功的工具观察，包括原始工具调用 ID、问题、模式、图片引用及外接分析。普通正文仍为字符串。

```sh
pnpm db:migrate:vision
```

该迁移可重复执行，本地已执行；其他部署环境需要在启动新版服务前执行。

上下文缓存清除后，从该字段恢复图片引用及视觉证据；历史回合不伪造孤立 tool 返回。旧消息中明确的本账号 COS 图片 Markdown 可兼容恢复。

原生切换到文本模型时，仅传文字证据与图片清单，细节可重新调用外接工具。切回原生时，可以重新提供原图。压缩时只传文字、图片 ID 和已有结论，不把 Base64 转为摘要文本；已压缩图片的引用仍可从历史存储恢复。

## 6. 预算、限制及失败

- 读取时校验项目实际路径和账号权限，限制单图 10 MB、解码像素 4000 万，转为最长边 2048 的 WebP。
- 每次请求最多附 12 个最近图片版本，同版本只附一次；同一轮缓存解码结果，路径内容变化时生成新 ID。
- 每轮最多 12 次看图调用、24 次图片加载及 40 步工具循环。需要新问题或新版本时允许再次看图。
- 文本块正常估算 token，图片默认预留 4096 token，可通过 AI_IMAGE_TOKEN_BUDGET 调整；实际累计消耗优先采用服务商 usage。图片预算为估算值。
- 原生图片用量计入主模型调用，不虚构额外视觉调用；外接视觉 usage 单独累加一次。
- 读取失败返回 success:false，不追加伪造视觉分析；用户取消停止图片读取、外接请求和后续主模型请求。接口失败正常反馈，不额外做自动能力探测或模式降级。

外接视觉使用现有 imageBaseURL、imageKey；可配置 VISION_MODEL（默认 qwen3.7-plus）、VISION_MAX_TOKENS（默认 1024）、VISION_THINKING（true 时启用，默认关闭）。

## 7. 验证

针对性测试覆盖能力字段缺失、首次附图、中途多次读取、并行工具配对、外接 usage、错误及取消、模型切换、压缩与真实 MySQL 临时表持久化。前端进行类型检查、构建和工具组件浏览器检查。

最小真实验证使用 96×64 的红蓝测试图，原生主模型 2 次请求与外接视觉 1 次请求均正确识别，成功请求合计 1897 token。另有一次指定 tool_choice 的请求被服务商以 400 拒绝，随后已移除强制工具选择。

手工真实测试脚本默认跳过，避免日常测试产生费用。确需复验时显式启用：

```powershell
$env:VISION_LIVE_TEST='1'
$env:VISION_MAX_TOKENS='128'
node tests/vision-live.mjs
```

该脚本限制主模型最多 2 次请求、外接 1 次请求，只读取自动生成的临时图片，不操作业务项目文件。
