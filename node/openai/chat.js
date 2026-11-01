import { client, CONTEXT_LIMIT_TOKENS, tokenizer } from './client.js';
import { randomUUID } from 'node:crypto';
import { compressContext } from './context/context-compression.js';
import { buildModelMessages, collectImageContext, createImageRuntime, imageObservationMessage, uploadedImages } from './media/image-input.js';
import { buildSystemPrompt, message } from './prompt/prompt.js';
import { functionMap } from './tools/tool-handlers.js';
import { tools } from './tools/tool-definitions.js';
import { canUseTool } from './tools/web-search-policy.js';
import { parseToolResult, toolResultStatus } from '../toolCalls.js';
import { modelRequestOptions } from '../models/config.js';
import {
  bindProjectDirPath,
  mergeToolCallDeltas,
  parseToolArguments,
} from './tools/tool-runtime.js';
import {
  addUsage,
  countContextTokens,
  createUsageTracker,
  throwIfAborted,
} from './context/usage.js';

async function streamModelResponse(context, tracker, signal, onEvent, modelConfig, toolContext) {
  await compressContext(context, tracker, signal, onEvent, modelConfig);
  const messages = await buildModelMessages(context, modelConfig, toolContext.images);
  throwIfAborted(signal);
  const fallbackPromptTokens = countContextTokens(messages);
  const stream = await client.chat.completions.create(
    {
      ...modelRequestOptions(modelConfig),
      messages,
      tools: tools.filter((tool) => canUseTool(tool.function.name, toolContext.webSearchEnabled)),
      tool_choice: 'auto',
      stream: true,
      stream_options: { include_usage: true },
    },
    { signal },
  );

  const toolCallsMap = {};
  let assistantText = '';
  let reasoningContent = '';
  let requestUsage = null;
  let requestSettled = false;
  try {
    for await (const chunk of stream) {
      if (chunk.usage) requestUsage = chunk.usage;
      if (!chunk.choices?.length) continue;
      const delta = chunk.choices[0].delta;
      reasoningContent += delta.reasoning_content || '';
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
      countContextTokens([
        {
          role: 'assistant',
          content: assistantText || null,
          reasoning_content: reasoningContent,
          tool_calls: Object.values(toolCallsMap),
        },
      ]),
    );
    requestSettled = true;
  } catch (error) {
    if (!requestSettled) {
      addUsage(
        tracker,
        requestUsage,
        fallbackPromptTokens,
        countContextTokens([
          {
            role: 'assistant',
            content: assistantText || null,
            tool_calls: Object.values(toolCallsMap),
          },
        ]),
      );
    }
    throw error;
  }

  const toolCalls = Object.keys(toolCallsMap)
    .sort((left, right) => Number(left) - Number(right))
    .map((key) => toolCallsMap[key]);
  return { assistantText, reasoningContent, toolCalls };
}

async function executeToolCalls({
  toolCalls,
  assistantText,
  reasoningContent,
  context,
  toolTurnId,
  projectDirPath,
  assistantSessionId,
  toolContext,
  tracker,
  modelConfig,
  onEvent,
  signal,
}) {
  context.push({
    role: 'assistant',
    content: assistantText || null,
    reasoning_content: reasoningContent,
    tool_calls: toolCalls,
    _toolTurnId: toolTurnId,
    _sessionId: assistantSessionId,
  });

  const invocations = new Map();
  const results = await Promise.allSettled(
    toolCalls.map(async (toolCall) => {
      const { id } = toolCall;
      const name = toolCall.function.name;
      const invocation = { toolCallId: randomUUID(), name, startedAt: new Date().toISOString() };
      invocations.set(toolCall, invocation);
      const handler = functionMap[name];
      if (!handler) throw new Error(`未注册的工具: ${name}`);

      const args = bindProjectDirPath(name, parseToolArguments(toolCall), projectDirPath);
      const startedAt = invocation.startedAt;
      onEvent({
        event: 'tool_start',
        data: { ...invocation, args, status: 'running' },
      });
      throwIfAborted(signal);

      if (!canUseTool(name, toolContext.webSearchEnabled)) throw new Error('联网搜索未开启，无法搜索或读取网页');

      const result = await handler(args, {
        ...toolContext,
        assistantSessionId,
        toolCallId: id,
        invocationId: invocation.toolCallId,
        onEvent,
        signal,
        modelConfig,
      });

      const content = result?.modelContent ?? result;
      if (result?.usage) addUsage(tracker, result.usage.usage, result.usage.promptTokens, tokenizer.encode(result.usage.completionText).length);
      throwIfAborted(signal);
      const status = toolResultStatus(content);
      const parsedResult = parseToolResult(content);
      onEvent({ event: 'tool_end', data: {
        toolCallId: invocation.toolCallId, name, result: parsedResult, status,
        error: status === 'failed' ? parsedResult?.message || '工具执行失败' : undefined,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - new Date(startedAt).getTime(),
      } });
      return {
        observation: result?.observation,
        message: {
          role: 'tool',
          content,
          tool_call_id: id,
          _toolTurnId: toolTurnId,
          _sessionId: assistantSessionId,
        },
      };
    }),
  );

  throwIfAborted(signal);
  context.splice(
    0,
    context.length,
    ...context.filter(
      (item) => !(item.role === 'tool' || item.tool_calls) || item._toolTurnId === toolTurnId,
    ),
  );
  context.push(
    ...results.map((item, index) => {
      if (item.status === 'fulfilled') return item.value.message;

      const error = String(item.reason?.message ?? item.reason);
      const toolCall = toolCalls[index];
      onEvent({
        event: 'tool_error',
        data: { ...invocations.get(toolCall), name: toolCall.function.name, status: 'failed', error, finishedAt: new Date().toISOString() },
      });
      return {
        role: 'tool',
        content: `工具执行失败: ${error}`,
        tool_call_id: toolCall.id,
        _toolTurnId: toolTurnId,
        _sessionId: assistantSessionId,
      };
    }),
  );
  // 必须先补齐本批全部 tool 返回，再插入承载图片的 user 消息。
  for (const item of results) {
    if (item.status !== 'fulfilled' || !item.value.observation) continue;
    const observation = item.value.observation;
    context.push({ ...imageObservationMessage(observation, assistantSessionId), _toolTurnId: toolTurnId, _observation: observation });
  }
  if (results.some((item) => item.status === 'fulfilled' && item.value.observation)) {
    await toolContext.persistImageContext?.(collectImageContext(context, assistantSessionId));
  }
}

async function runChat({
  userMessage,
  onEvent,
  context,
  projectDirPath,
  prompt,
  tracker,
  signal,
  toolTurnId,
  appendUserMessage,
  userSessionId,
  assistantSessionId,
  toolContext,
  modelConfig,
  step = 0,
}) {
  throwIfAborted(signal);
  if (step >= 40) throw new Error('本轮工具执行次数已达上限，请继续发送消息');
  if (appendUserMessage && (userMessage || prompt || toolContext.initialImages.length)) {
    context.push({
      role: 'user',
      content: userMessage || prompt || '请查看上传的图片',
      _images: toolContext.initialImages,
      _imageInput: true,
      _sessionId: userSessionId,
    });
  }

  const { assistantText, reasoningContent, toolCalls } = await streamModelResponse(
    context,
    tracker,
    signal,
    onEvent,
    modelConfig,
    toolContext,
  );
  if (toolCalls.length > 0) {
    await executeToolCalls({
      toolCalls,
      assistantText,
      reasoningContent,
      context,
      toolTurnId,
      projectDirPath,
      assistantSessionId,
      toolContext,
      tracker,
      modelConfig,
      onEvent,
      signal,
    });
    await runChat({
      userMessage: '',
      onEvent,
      context,
      projectDirPath,
      prompt,
      tracker,
      signal,
      toolTurnId,
      appendUserMessage: false,
      userSessionId: null,
      assistantSessionId,
      toolContext,
      modelConfig,
      step: step + 1,
    });
  } else if (assistantText) {
    context.push({ role: 'assistant', content: assistantText, reasoning_content: reasoningContent, _sessionId: assistantSessionId });
  }
}

function pruneIncompleteToolCalls(context, toolTurnId) {
  const completedIds = new Set(
    context
      .filter((item) => item.role === 'tool' && item._toolTurnId === toolTurnId)
      .map((item) => item.tool_call_id),
  );
  context.splice(
    0,
    context.length,
    ...context.filter(
      (item) =>
        item._toolTurnId !== toolTurnId ||
        !item.tool_calls ||
        item.tool_calls.every((toolCall) => completedIds.has(toolCall.id)),
    ),
  );
}

function buildUsageResult(tracker, context, modelConfig) {
  tracker.currentContextTokens = countContextTokens(context);
  const result = {
    ...tracker,
    totalTokens: tracker.promptTokens + tracker.completionTokens,
    contextLimit: modelConfig.contextLimit || CONTEXT_LIMIT_TOKENS,
    contextEstimated: context.some((item) => item._images?.length > 0),
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
  const webSearchEnabled = options.webSearchEnabled === true;
  const modelConfig = options.modelConfig;
  modelRequestOptions(modelConfig);
  if (context[0]?.role === 'system') context[0].content = buildSystemPrompt(projectDirPath, webSearchEnabled, modelConfig.supportsVision);
  const tracker = createUsageTracker(context);
  const toolTurnId = Symbol('tool-turn');
  const initialImages = options.images ?? uploadedImages(imageUrls, options.toolContext?.storageKey);
  const images = createImageRuntime(context, projectDirPath, { storageKey: options.toolContext?.storageKey, signal: options.signal });
  images.register(initialImages);
  try {
    await runChat({
      userMessage,
      onEvent,
      context,
      projectDirPath,
      prompt,
      tracker,
      signal: options.signal,
      toolTurnId,
      appendUserMessage: true,
      userSessionId: options.userSessionId,
      assistantSessionId: options.assistantSessionId,
      toolContext: { ...options.toolContext, webSearchEnabled, images, initialImages },
      modelConfig,
    });
    return buildUsageResult(tracker, context, modelConfig);
  } catch (error) {
    pruneIncompleteToolCalls(context, toolTurnId);
    error.chatUsage = buildUsageResult(tracker, context, modelConfig);
    throw error;
  }
}
