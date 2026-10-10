import { client, CONTEXT_LIMIT_TOKENS, tokenizer } from './client.js';
import { randomUUID } from 'node:crypto';
import { compressContext } from './context/context-compression.js';
import { describeImage } from './media/image-desc.js';
import { buildSystemPrompt, message } from './prompt/prompt.js';
import { functionMap } from './tools/tool-handlers.js';
import { tools } from './tools/tool-definitions.js';
import { parseToolResult, toolResultStatus } from '../toolCalls.js';
import { modelRequestOptions } from '../models/config.js';
import {
  bindProjectDirPath,
  buildUserContent,
  mergeToolCallDeltas,
  parseToolArguments,
} from './tools/tool-runtime.js';
import {
  addUsage,
  countContextTokens,
  createUsageTracker,
  throwIfAborted,
  toApiMessages,
} from './context/usage.js';

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

async function streamModelResponse(context, tracker, signal, onEvent, modelConfig) {
  await compressContext(context, tracker, signal, onEvent, modelConfig);
  const messages = toApiMessages(context);
  const fallbackPromptTokens = countContextTokens(messages);
  const stream = await client.chat.completions.create(
    {
      ...modelRequestOptions(modelConfig),
      messages,
      tools,
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

      const result = await handler(args, {
        ...toolContext,
        assistantSessionId,
        toolCallId: id,
        invocationId: invocation.toolCallId,
        onEvent,
        signal,
      });

      throwIfAborted(signal);
      const status = toolResultStatus(result);
      const parsedResult = parseToolResult(result);
      onEvent({ event: 'tool_end', data: {
        toolCallId: invocation.toolCallId, name, result: parsedResult, status,
        error: status === 'failed' ? parsedResult?.message || '工具执行失败' : undefined,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - new Date(startedAt).getTime(),
      } });
      return {
        role: 'tool',
        content: result,
        tool_call_id: id,
        _toolTurnId: toolTurnId,
        _sessionId: assistantSessionId,
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
      if (item.status === 'fulfilled') return item.value;

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
  toolTurnId,
  appendUserMessage,
  userSessionId,
  assistantSessionId,
  toolContext,
  modelConfig,
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

  const { assistantText, reasoningContent, toolCalls } = await streamModelResponse(
    context,
    tracker,
    signal,
    onEvent,
    modelConfig,
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
      toolTurnId,
      appendUserMessage: false,
      userSessionId: null,
      assistantSessionId,
      toolContext,
      modelConfig,
    });
  } else if (assistantText) {
    context.push({ role: 'assistant', content: assistantText, _sessionId: assistantSessionId });
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
  const modelConfig = options.modelConfig;
  modelRequestOptions(modelConfig);
  const tracker = createUsageTracker(context);
  const toolTurnId = Symbol('tool-turn');
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
      toolTurnId,
      appendUserMessage: true,
      userSessionId: options.userSessionId,
      assistantSessionId: options.assistantSessionId,
      toolContext: options.toolContext || {},
      modelConfig,
    });
    return buildUsageResult(tracker, context, modelConfig);
  } catch (error) {
    pruneIncompleteToolCalls(context, toolTurnId);
    error.chatUsage = buildUsageResult(tracker, context, modelConfig);
    throw error;
  }
}
