import express from 'express';
import authJWT from '../../middleware/authJWT.js';
import { getProjectInfo } from '../../project.js';
import {
  createStreamingAssistantSession,
  createUserChatSession,
  getOrCreateConversation,
  settleConversationUsage,
} from '../../session/index.js';
import { keepContext, message } from '../../openai/index.js';
import {
  cancelChatStream,
  runAiChat,
  startChatStream,
  getActiveStream,
  subscribeChatStream,
} from '../../chatStream.js';
import { markUserActive } from '../../utils/activity.js';
import { contextCache } from './context.js';
import { selectChatModel } from '../../models/service.js';
import { saveConversationModel } from '../../session/conversations.js';
import { prepareSse, writeSse } from './sse.js';
import { toolCallStore, summarizeTools } from '../../toolCalls.js';
import { listImageGenerationTasks } from '../../imageGeneration.js';

const router = express.Router();

function restoreContextHistory(rows, conversation) {
  const history = rows.map((item) => ({
    role: item.role === 'vision' ? 'user' : item.role,
    content: item.content,
    _sessionId: item.id,
  }));
  if (conversation.summary) {
    history.unshift({
      role: 'system',
      content: `【历史对话压缩摘要】\n${conversation.summary}`,
      _isSummary: true,
      _summarizedUntilSessionId: conversation.summarized_until_session_id,
    });
  }
  return history;
}

function buildProjectMessage(prompt, project) {
  return `【用户指令 - 最高优先级，请以此为准】
${prompt}

【项目背景 - 操作文件时使用】
项目标题: ${project.title ?? ''}
项目描述: ${project.desc ?? ''}
项目Path: ${project.dir_path}
组件库: vant
CSS: tailwindcss

注: 所有文件操作必须使用上述项目Path，path 参数用相对路径；看项目效果只需提示用户刷新页面`;
}

function formatUsageSettlement(result, usage, status) {
  const stats = result.conversation;
  return {
    status,
    turn: {
      promptTokens: Number(usage?.promptTokens) || 0,
      completionTokens: Number(usage?.completionTokens) || 0,
      totalTokens: Number(usage?.totalTokens) || 0,
      modelCalls: Number(usage?.modelCalls) || 0,
      estimated: Boolean(usage?.estimated),
      compressed: Boolean(usage?.compressed),
    },
    conversation: stats
      ? {
          promptTokens: Number(stats.prompt_tokens) || 0,
          completionTokens: Number(stats.completion_tokens) || 0,
          totalTokens: Number(stats.total_tokens) || 0,
          currentContextTokens: Number(stats.current_context_tokens) || 0,
          contextLimit: Number(stats.context_limit) || 0,
        }
      : null,
  };
}

router.post('/chat/stream', authJWT, async (req, res) => {
  const { prompt, projectId, conversationId, title, imageUrls = [] } = req.body;
  if (!prompt) return res.cc(1, '发送消息不能为空');
  if (!projectId) return res.cc(1, '操作项目不能为空');

  let context = message.map((item) => ({ ...item }));
  try {
    const project = await getProjectInfo(projectId, req.user);
    await markUserActive(req.user.id);
    const conversation = await getOrCreateConversation(
      {
        projectId,
        title: title || prompt.slice(0, 30),
        conversationId,
      },
      req.user,
    );
    const modelConfig = await selectChatModel(req.body, conversation);
    await saveConversationModel(conversation.id, modelConfig, req.user);
    const contextKey = String(conversation.id);
    const cachedHistory = conversation.title ? contextCache.get(contextKey) : undefined;

    if (conversation.title && cachedHistory === undefined) {
      const { result } = await keepContext(
        req.user.account,
        projectId,
        conversation.title,
        conversation.id,
        conversation.summarized_until_session_id,
      );
      const history = restoreContextHistory(result, conversation);
      context = context.concat(history);
      contextCache.set(contextKey, history);
    } else if (conversation.title) {
      context = context.concat(cachedHistory);
    }

    const userSession = await createUserChatSession(
      {
        title: conversation.title,
        projectId,
        content: prompt,
        conversationId: conversation.id,
        ...modelConfig,
      },
      req.user,
    );
    const assistantSession = await createStreamingAssistantSession(
      {
        title: conversation.title,
        projectId,
        conversationId: conversation.id,
        ...modelConfig,
      },
      req.user,
    );

    prepareSse(res);
    writeSse(res, {
      event: 'message',
      data: {
        userSessionId: userSession.id,
        assistantSessionId: assistantSession.sessionId,
        assistantMessageId: assistantSession.messageId,
        conversationId: conversation.id,
        model: modelConfig.model,
        reasoningEffort: modelConfig.reasoningEffort,
      },
    });

    startChatStream({
      messageId: assistantSession.messageId,
      sessionId: assistantSession.sessionId,
      run: (send, signal) =>
        runAiChat(
          buildProjectMessage(prompt, project),
          send,
          context,
          project.dir_path,
          imageUrls,
          prompt,
          {
            modelConfig,
            signal,
            userSessionId: userSession.id,
            assistantSessionId: assistantSession.sessionId,
            toolContext: {
              account: req.user.account,
              storageKey: req.user.storage_key,
              projectId: Number(projectId),
              conversationId: conversation.id,
            },
          },
        ),
      onSettled: async (usage, status) => {
        const result = await settleConversationUsage({
          conversationId: conversation.id,
          projectId,
          assistantSessionId: assistantSession.sessionId,
          usage,
          status,
        });
        if (status !== 'completed') contextCache.delete(contextKey);
        return formatUsageSettlement(result, usage, status);
      },
      onComplete: async (_content, _usage, { settlementFailed } = {}) => {
        if (!conversation.title) return;
        if (settlementFailed) contextCache.delete(contextKey);
        else contextCache.set(contextKey, context.slice(1));
      },
    });

    await subscribeChatStream({
      messageId: assistantSession.messageId,
      account: req.user.account,
      offset: 0,
      res,
      initialSession: { account: req.user.account, status: 'streaming' },
    });
  } catch (error) {
    if (res.headersSent) {
      writeSse(res, { event: 'error', data: error.message });
      return res.end();
    }
    res.cc(1, error.message);
  }
});

router.get('/chat/messages/:messageId/tools', authJWT, async (req, res) => {
  try {
    const active = getActiveStream(req.params.messageId);
    if (active) await active.toolPersistence;
    const { tools, sessionId } = await toolCallStore.list(req.params.messageId, req.user.account);
    if (!active) for (const tool of tools) {
      if (tool.status !== 'running') continue;
      tool.status = 'failed';
      tool.error = '生成任务已结束或连接已中断，未收到完整结果';
    }
    let page = 1;
    let hasMore;
    do {
      const result = await listImageGenerationTasks({ account: req.user.account, assistantSessionId: sessionId, page, pageSize: 50 });
      for (const task of result.list) {
        const tool = tools.find((item) => item.toolCallId === task.toolCallId);
        if (tool) (tool.imageTasks ??= []).push(task);
      }
      hasMore = result.pagination.hasMore;
      page += 1;
    } while (hasMore);
    res.cc(0, '工具过程', { tools, summary: summarizeTools(tools) });
  } catch (error) { res.cc(1, error.message); }
});

router.post('/chat/messages/:messageId/cancel', authJWT, async (req, res) => {
  if (!req.params.messageId) return res.cc(1, 'messageId 不能为空');
  try {
    const result = await cancelChatStream({
      messageId: req.params.messageId,
      account: req.user.account,
    });
    res.cc(0, result.cancelled ? '正在终止生成' : '生成任务已结束', result);
  } catch (error) {
    res.cc(1, error.message);
  }
});

router.get('/chat/messages/:messageId/stream', authJWT, async (req, res) => {
  if (!req.params.messageId) return res.cc(1, 'messageId 不能为空');
  prepareSse(res);
  try {
    await subscribeChatStream({
      messageId: req.params.messageId,
      account: req.user.account,
      offset: req.query.offset ?? 0,
      res,
    });
  } catch (error) {
    if (!res.writableEnded) {
      writeSse(res, { event: 'error', data: error.message });
      res.end();
    }
  }
});

export default router;
