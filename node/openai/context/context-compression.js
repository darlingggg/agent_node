import {
  client,
  CONTEXT_COMPRESSION_THRESHOLD,
  CONTEXT_LIMIT_TOKENS,
  RECENT_USER_TURNS_TO_KEEP,
  SUMMARY_MAX_TOKENS,
  tokenizer,
} from '../client.js';
import { addUsage, countContextTokens, throwIfAborted } from './usage.js';
import { modelRequestOptions } from '../../models/config.js';

function findCompressionCutoff(context) {
  const userIndexes = [];
  for (let index = 1; index < context.length; index += 1) {
    if (context[index].role === 'user') userIndexes.push(index);
  }
  if (userIndexes.length <= RECENT_USER_TURNS_TO_KEEP) return -1;
  return userIndexes[userIndexes.length - RECENT_USER_TURNS_TO_KEEP];
}

export async function compressContext(context, tracker, signal, onEvent, modelConfig) {
  const contextLimit = modelConfig.contextLimit || CONTEXT_LIMIT_TOKENS;
  const threshold = Math.floor(
    (contextLimit * CONTEXT_COMPRESSION_THRESHOLD) / CONTEXT_LIMIT_TOKENS,
  );
  const beforeTokens = countContextTokens(context);
  if (beforeTokens < threshold) return;

  const cutoff = findCompressionCutoff(context);
  if (cutoff <= 1) return;

  const oldMessages = context.slice(1, cutoff);
  const summarizedUntilSessionId = oldMessages.reduce(
    (max, item) =>
      Math.max(max, Number(item._summarizedUntilSessionId) || Number(item._sessionId) || 0),
    0,
  );
  const summaryInput = oldMessages.map(({ role, content, tool_calls }) => ({
    role,
    content,
    tool_calls,
  }));
  const promptMessages = [
    { role: 'system', content: '你负责压缩编程会话上下文，只输出结构化、事实准确的摘要。' },
    {
      role: 'user',
      content: `请将以下历史对话压缩成一份可供后续编程助手继续工作的中文摘要。必须保留：用户目标、已确认决策、已修改文件、关键代码/API、工具执行结果、未完成事项和约束。不要添加原对话中不存在的信息。\n\n${JSON.stringify(summaryInput)}`,
    },
  ];

  throwIfAborted(signal);
  onEvent({
    event: 'context_compress_start',
    data: {
      beforeTokens,
      thresholdTokens: threshold,
      contextLimit,
    },
  });

  let response;
  try {
    response = await client.chat.completions.create(
      {
        ...modelRequestOptions(modelConfig),
        messages: promptMessages,
        max_tokens: SUMMARY_MAX_TOKENS,
      },
      { signal },
    );
  } catch (error) {
    onEvent({
      event: 'context_compress_error',
      data: { message: error?.message || '上下文压缩失败' },
    });
    throw error;
  }

  const summary = response.choices?.[0]?.message?.content?.trim();
  if (!summary) {
    onEvent({ event: 'context_compress_error', data: { message: '压缩模型未返回摘要' } });
    return;
  }

  addUsage(
    tracker,
    response.usage,
    countContextTokens(promptMessages),
    tokenizer.encode(summary).length,
  );
  context.splice(1, cutoff - 1, {
    role: 'system',
    content: `【历史对话压缩摘要】\n${summary}`,
    _isSummary: true,
    _summarizedUntilSessionId: summarizedUntilSessionId || null,
  });
  tracker.compressed = true;
  tracker.summary = summary;
  tracker.summarizedUntilSessionId = summarizedUntilSessionId || tracker.summarizedUntilSessionId;
  onEvent({
    event: 'context_compress_done',
    data: { beforeTokens, afterTokens: countContextTokens(context) },
  });
}
