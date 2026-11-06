import { tokenizer } from '../client.js';

// 用于上下文预算及无 usage 时的保守估算，不按 URL/Base64 长度计算视觉 token。
export const IMAGE_TOKEN_BUDGET = Math.max(256, Number(process.env.AI_IMAGE_TOKEN_BUDGET) || 4096);

export function countContextTokens(context) {
  let total = 0;
  for (const message of context) {
    total += 4;
    if (message.role) total += tokenizer.encode(message.role).length;
    if (typeof message.content === 'string' && message.content) {
      total += tokenizer.encode(message.content).length;
    }
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === 'text') total += tokenizer.encode(part.text || '').length;
        if (part.type === 'image_url') total += IMAGE_TOKEN_BUDGET;
      }
    } else if (message._imageInput) total += (message._images?.length || 0) * IMAGE_TOKEN_BUDGET;
    if (message.reasoning_content) total += tokenizer.encode(message.reasoning_content).length;
    if (message.tool_calls) total += tokenizer.encode(JSON.stringify(message.tool_calls)).length;
    if (message.tool_call_id) total += tokenizer.encode(message.tool_call_id).length;
    if (message.name) total += tokenizer.encode(message.name).length;
  }
  return total + 2;
}

export function createUsageTracker(context) {
  return {
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
  };
}

export function addUsage(tracker, usage, fallbackPromptTokens, fallbackCompletionTokens) {
  const hasUsage =
    usage &&
    Number.isFinite(Number(usage.prompt_tokens)) &&
    Number.isFinite(Number(usage.completion_tokens));
  tracker.promptTokens += hasUsage ? Number(usage.prompt_tokens) : fallbackPromptTokens;
  tracker.completionTokens += hasUsage ? Number(usage.completion_tokens) : fallbackCompletionTokens;
  tracker.modelCalls += 1;
  if (!hasUsage) tracker.estimated = true;
}

export function toApiMessages(context) {
  return context.map(({ role, content, tool_calls, tool_call_id, name, reasoning_content }) => ({
    role,
    content,
    ...(reasoning_content ? { reasoning_content } : {}),
    ...(tool_calls ? { tool_calls } : {}),
    ...(tool_call_id ? { tool_call_id } : {}),
    ...(name ? { name } : {}),
  }));
}

export function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw Object.assign(new Error('生成已取消'), { name: 'AbortError' });
  }
}
