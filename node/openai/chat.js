import { CHAT_MODEL, client, CONTEXT_LIMIT_TOKENS, tokenizer } from './client.js';
import { compressContext } from './context-compression.js';
import { describeImage } from './image-desc.js';
import { buildSystemPrompt, message } from './prompt.js';
import { functionMap } from './tool-handlers.js';
import { tools } from './tool-definitions.js';
import {
  bindProjectDirPath,
  buildUserContent,
  mergeToolCallDeltas,
  parseToolArguments,
} from './tool-runtime.js';
import {
  addUsage,
  countContextTokens,
  createUsageTracker,
  throwIfAborted,
  toApiMessages,
} from './usage.js';

async function analyzeImages(imageUrls, prompt, userMessage, onEvent, tracker, signal) {
  if (!Array.isArray(imageUrls) || imageUrls.length === 0) return '';

  onEvent({ event: 'vision_start', data: null });
  const result = await describeImage(prompt || userMessage, imageUrls, onEvent, signal);
  const response = result?.response ?? '';
  addUsage(
    tracker,
    result?.usage,
    tokenizer.encode(`${prompt || userMessage}\n${JSON.stringify(imageUrls)}`).length,
    tokenizer.encode(`${result?.reasoning || ''}${response}`).length,
  );
  if (response) onEvent({ event: 'vision_done', data: response });
  return response;
}

async function streamModelResponse(context, tracker, signal, onEvent) {
  await compressContext(context, tracker, signal, onEvent);
  const messages = toApiMessages(context);
  const fallbackPromptTokens = countContextTokens(messages);
  const stream = await client.chat.completions.create({
    model: CHAT_MODEL,
    messages,
    tools,
    tool_choice: 'auto',
    stream: true,
    stream_options: { include_usage: true },
  }, { signal });

  const toolCallsMap = {};
  let assistantText = '';
  let requestUsage = null;
  let requestSettled = false;
  try {
    for await (const chunk of stream) {
      if (chunk.usage) requestUsage = chunk.usage;
      if (!chunk.choices?.length) continue;
      const delta = chunk.choices[0].delta;
      if (delta.content) {
        assistantText += delta.content;
        tracker.assistantText += delta.content;
        onEvent({ event: 'text', data: delta.content });
      }
      if (delta.tool_calls) mergeToolCallDeltas(toolCallsMap, delta.tool_calls);
    }
    addUsage(
      tracker,
      requestUsage,
      fallbackPromptTokens,
      countContextTokens([{
        role: 'assistant',
        content: assistantText || null,
        tool_calls: Object.values(toolCallsMap),
      }]),
    );
    requestSettled = true;
  } catch (error) {
    if (!requestSettled) {
      addUsage(
        tracker,
        requestUsage,
        fallbackPromptTokens,
        countContextTokens([{
          role: 'assistant',
          content: assistantText || null,
          tool_calls: Object.values(toolCallsMap),
        }]),
      );
    }
    throw error;
  }

  const toolCalls = Object.keys(toolCallsMap)
    .sort((left, right) => Number(left) - Number(right))
    .map((key) => toolCallsMap[key]);
  return { assistantText, toolCalls };
}

// async function executeToolCalls({
//   toolCalls,
//   assistantText,
//   context,
//   projectDirPath,
//   assistantSessionId,
//   toolContext,
//   onEvent,
//   signal,
// }) {
//   context.push({ role: 'assistant', content: assistantText || null, tool_calls: toolCalls });
//   for (const toolCall of toolCalls) {
//     const { id } = toolCall;
//     const name = toolCall.function.name;
//     const handler = functionMap[name];
//     if (!handler) throw new Error(`未注册的工具: ${name}`);

//     const args = bindProjectDirPath(name, parseToolArguments(toolCall), projectDirPath);
//     onEvent({ event: 'tool_start', data: `正在执行工具: ${name} $$ 参数: ${JSON.stringify(args)}` });
//     throwIfAborted(signal);
//     handler(args, {
//       ...toolContext,
//       assistantSessionId,
//       toolCallId: id,
//       onEvent,
//       signal,
//     }).then((result)=>{
//       throwIfAborted(signal);
//       context.push({ role: 'tool', content: result, tool_call_id: id });
//       onEvent({ event: 'tool_end', data: `工具执行完毕: ${name} $$ 结果: ${result}` });
//     })
//   }
// }

async function executeToolCalls({
  toolCalls, assistantText, context, projectDirPath,
  assistantSessionId, toolContext, onEvent, signal,
}) {
  context.push({
    role: 'assistant',
    content: assistantText || null,
    tool_calls: toolCalls,
  });

  const results = await Promise.allSettled(toolCalls.map(async (toolCall) => {
    const { id } = toolCall;
    const name = toolCall.function.name;
    const handler = functionMap[name];
    if (!handler) throw new Error(`未注册的工具: ${name}`);

    const args = bindProjectDirPath(name, parseToolArguments(toolCall), projectDirPath);
    onEvent({ event: 'tool_start', data: `正在执行工具: ${name} $$ 参数: ${JSON.stringify(args)}` });
    throwIfAborted(signal);

    const result = await handler(args, {
      ...toolContext,
      assistantSessionId,
      toolCallId: id,
      onEvent,
      signal,
    });

    throwIfAborted(signal);
    onEvent({ event: 'tool_end', data: `工具执行完毕: ${name} $$ 结果: ${result}` });
    return { role: 'tool', content: result, tool_call_id: id };
  }));

  throwIfAborted(signal);
  context.push(...results.map((item, index) => {
    if (item.status === 'fulfilled') return item.value;

    const error = String(item.reason?.message ?? item.reason);
    const toolCall = toolCalls[index];
    onEvent({
      event: 'tool_error',
      data: `工具执行失败: ${toolCall.function.name} $$ 错误: ${error}`,
    });
    return {
      role: 'tool',
      content: `工具执行失败: ${error}`,
      tool_call_id: toolCall.id,
    };
  }));
}

async function runChat({
  userMessage,
  onEvent,
  context,
  projectDirPath,
  imageUrls,
  prompt,
  tracker,
  signal,
  appendUserMessage,
  userSessionId,
  assistantSessionId,
  toolContext,
}) {
  throwIfAborted(signal);
  const visionResult = await analyzeImages(
    imageUrls,
    prompt,
    userMessage,
    onEvent,
    tracker,
    signal,
  );
  if (appendUserMessage && (userMessage || prompt)) {
    context.push({
      role: 'user',
      content: buildUserContent(visionResult, userMessage, prompt),
      _sessionId: userSessionId,
    });
  }

  const { assistantText, toolCalls } = await streamModelResponse(context, tracker, signal, onEvent);
  if (toolCalls.length > 0) {
    await executeToolCalls({
      toolCalls,
      assistantText,
      context,
      projectDirPath,
      assistantSessionId,
      toolContext,
      onEvent,
      signal,
    });
    await runChat({
      userMessage: '',
      onEvent,
      context,
      projectDirPath,
      imageUrls: [],
      prompt,
      tracker,
      signal,
      appendUserMessage: false,
      userSessionId: null,
      assistantSessionId,
      toolContext,
    });
  } else if (assistantText) {
    context.push({ role: 'assistant', content: assistantText, _sessionId: assistantSessionId });
  }
}

function pruneCompletedToolContext(context, assistantSessionId, assistantText) {
  const retained = context.filter((item) => item.role !== 'tool' && !item.tool_calls);
  const finalAssistant = retained[retained.length - 1];
  if (finalAssistant?.role === 'assistant') {
    finalAssistant.content = assistantText || finalAssistant.content;
    finalAssistant._sessionId = assistantSessionId || finalAssistant._sessionId;
  } else if (assistantText) {
    retained.push({ role: 'assistant', content: assistantText, _sessionId: assistantSessionId });
  }
  context.splice(0, context.length, ...retained);
}

function buildUsageResult(tracker, context) {
  tracker.currentContextTokens = countContextTokens(context);
  const result = {
    ...tracker,
    totalTokens: tracker.promptTokens + tracker.completionTokens,
    contextLimit: CONTEXT_LIMIT_TOKENS,
  };
  delete result.assistantText;
  return result;
}

export async function chat(
  userMessage = '',
  onEvent = (event) => process.stdout.write(JSON.stringify(event)),
  context = message,
  projectDirPath = '',
  imageUrls = [],
  prompt = '',
  options = {},
) {
  if (context[0]?.role === 'system') context[0].content = buildSystemPrompt(projectDirPath);
  const tracker = createUsageTracker(context);
  try {
    await runChat({
      userMessage,
      onEvent,
      context,
      projectDirPath,
      imageUrls,
      prompt,
      tracker,
      signal: options.signal,
      appendUserMessage: true,
      userSessionId: options.userSessionId,
      assistantSessionId: options.assistantSessionId,
      toolContext: options.toolContext || {},
    });
    pruneCompletedToolContext(context, options.assistantSessionId, tracker.assistantText);
    return buildUsageResult(tracker, context);
  } catch (error) {
    pruneCompletedToolContext(context, options.assistantSessionId, tracker.assistantText);
    error.chatUsage = buildUsageResult(tracker, context);
    throw error;
  }
}
