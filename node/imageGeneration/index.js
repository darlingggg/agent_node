import connection from '../../Mysql/index.js';
import { uploadGeneratedImageToCos, getSignedObjectUrl } from '../cos/index.js';
import {
  generateImage,
  waitForGeneratedImage,
  IMAGE_GENERATION_MODEL,
  validateImageGenerationSize,
} from '../openai/image-gen.js';
import { keysToCamelCase } from '../utils/case.js';

const activeImageTasks = new Map();
const TERMINAL_STATUSES = new Set(['succeeded', 'failed']);
const HEARTBEAT_INTERVAL_MS = 15 * 1000;

const writeSse = (res, message) => {
  if (!res.writableEnded) res.write(`data: ${JSON.stringify(message)}\n\n`);
};

const broadcast = (state, message, predicate = () => true) => {
  for (const client of state.clients) {
    if (predicate(client)) writeSse(client.res, message);
  }
};

const closeClients = (state) => {
  for (const client of state.clients) {
    clearInterval(client.heartbeat);
    if (!client.res.writableEnded) client.res.end();
  }
  state.clients.clear();
};

const parseReferenceImages = (value) => {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const toPublicTask = async (row, signedUrl = null) => {
  if (!row) return null;
  const task = keysToCamelCase({
    task_id: Number(row.id),
    account: row.account,
    project_id: row.project_id,
    conversation_id: row.conversation_id,
    assistant_session_id: row.assistant_session_id,
    tool_call_id: row.tool_call_id,
    model: row.model,
    prompt: row.prompt,
    negative_prompt: row.negative_prompt,
    reference_images: parseReferenceImages(row.reference_images),
    image_size: row.image_size,
    status: row.status,
    temporary_url: row.assistant_session_id ? null : row.temporary_url,
    content_type: row.content_type,
    original_size: row.original_size,
    stored_size: row.stored_size,
    width: row.width,
    height: row.height,
    error_message: row.error_message,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
    source: 'ai_generated',
  });
  if (row.object_key) task.url = signedUrl || await getSignedObjectUrl(row.object_key);
  return task;
};

export const getImageGenerationTask = async (taskId, account) => {
  const [rows] = await connection.query(
    'select * from ai_generated_images where id = ? and account = ? limit 1',
    [taskId, account],
  );
  return rows[0] || null;
};

const updateTaskStatus = async (taskId, status, extraSql = '', params = []) => {
  await connection.query(
    `update ai_generated_images set status = ?${extraSql} where id = ?`,
    [status, ...params, taskId],
  );
};

const getUserStorageKey = async (account) => {
  const [rows] = await connection.query(
    'select storage_key from users where account = ? limit 1',
    [account],
  );
  const storageKey = rows[0]?.storage_key;
  if (!storageKey) throw new Error('用户存储目录未初始化');
  return storageKey;
};

const publishStatus = (state, status, extra = {}) => {
  state.status = status;
  broadcast(state, {
    event: 'status',
    data: { taskId: state.id, status, ...extra },
  });
};

/**
 * 在后台执行或恢复图片任务。浏览器断开不会取消该 Promise。
 * 如果已有 external_task_id，则继续轮询原服务商任务。
 */
export const startImageGenerationTask = (job, storageKey = null) => {
  const id = Number(job.id);
  if (activeImageTasks.has(id) || TERMINAL_STATUSES.has(job.status)) {
    return activeImageTasks.get(id) || null;
  }

  const state = {
    id,
    status: job.status,
    clients: new Set(),
  };
  activeImageTasks.set(id, state);

  state.promise = Promise.resolve()
    .then(async () => {
      let temporaryUrl = job.temporary_url;
      const onStatus = async (providerStatus) => {
        if (providerStatus !== 'PENDING' && providerStatus !== 'RUNNING') return;
        const status = providerStatus === 'RUNNING' ? 'generating' : 'submitted';
        if (state.status === status) return;
        await updateTaskStatus(id, status);
        publishStatus(state, status, { providerStatus });
      };

      if (!temporaryUrl && job.external_task_id) {
        temporaryUrl = await waitForGeneratedImage(job.external_task_id, { onStatus });
      } else if (!temporaryUrl) {
        temporaryUrl = await generateImage(
          job.prompt,
          parseReferenceImages(job.reference_images),
          job.negative_prompt || '',
          job.image_size || 'auto',
          {
            onSubmitted: async (externalTaskId) => {
              await updateTaskStatus(
                id,
                'submitted',
                ', external_task_id = ?, error_message = null',
                [externalTaskId],
              );
              job.external_task_id = externalTaskId;
              publishStatus(state, 'submitted', { externalTaskId });
            },
            onStatus,
          },
        );
      }

      await updateTaskStatus(id, 'storing', ', temporary_url = ?', [temporaryUrl]);
      publishStatus(state, 'storing');
      broadcast(state, {
        event: 'generated',
        data: { taskId: id, temporaryUrl },
      }, client => client.exposeTemporary);

      const targetStorageKey = storageKey || await getUserStorageKey(job.account);
      const stored = await uploadGeneratedImageToCos(temporaryUrl, targetStorageKey);
      await connection.query(
        `update ai_generated_images
         set status = 'succeeded', object_key = ?, content_type = ?,
             original_size = ?, stored_size = ?, width = ?, height = ?,
             error_message = null, completed_at = current_timestamp
         where id = ?`,
        [
          stored.key,
          stored.contentType,
          stored.originalSize,
          stored.size,
          stored.width,
          stored.height,
          id,
        ],
      );
      state.status = 'succeeded';
      const completed = await getImageGenerationTask(id, job.account);
      broadcast(state, { event: 'stored', data: await toPublicTask(completed, stored.url) });
      broadcast(state, { event: 'done', data: { taskId: id } });
    })
    .catch(async (error) => {
      const message = String(error?.message || error).slice(0, 4000);
      state.status = 'failed';
      await connection.query(
        `update ai_generated_images
         set status = 'failed', error_message = ?, completed_at = current_timestamp
         where id = ?`,
        [message, id],
      ).catch(updateError => {
        console.error('[image-generation] 更新失败状态时出错:', updateError);
      });
      broadcast(state, { event: 'error', data: { taskId: id, message } });
    })
    .finally(() => {
      closeClients(state);
      activeImageTasks.delete(id);
    });

  return state;
};

/** 创建数据库任务并立即在后台启动，调用方不需要等待图片完成。 */
export const createImageGenerationTask = async ({
  account,
  storageKey,
  prompt,
  imageUrls = [],
  negativePrompt = '',
  size = 'auto',
  projectId = null,
  conversationId = null,
  assistantSessionId = null,
  toolCallId = null,
}) => {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new TypeError('prompt 不能为空');
  if (!Array.isArray(imageUrls)) throw new TypeError('imageUrls 必须是数组');
  if (!storageKey) throw new TypeError('用户存储目录未初始化');

  const references = imageUrls.slice(0, 3);
  const normalizedSize = validateImageGenerationSize(size);
  const [result] = await connection.query(
    `insert into ai_generated_images
      (account, project_id, conversation_id, assistant_session_id, tool_call_id,
       model, prompt, negative_prompt, reference_images, image_size, status)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued')`,
    [
      account,
      projectId || null,
      conversationId || null,
      assistantSessionId || null,
      toolCallId || null,
      IMAGE_GENERATION_MODEL,
      prompt.trim(),
      negativePrompt || null,
      JSON.stringify(references),
      normalizedSize,
    ],
  );
  const job = await getImageGenerationTask(result.insertId, account);
  startImageGenerationTask(job, storageKey);
  return toPublicTask(job);
};

/** 等待任务完成；只有图片已成功保存到 COS 时才返回。 */
export const waitForStoredImageGenerationTask = async ({ taskId, account, storageKey }) => {
  let job = await getImageGenerationTask(taskId, account);
  if (!job) throw new Error('图片生成任务不存在');

  if (!TERMINAL_STATUSES.has(job.status)) {
    const state = activeImageTasks.get(Number(taskId)) || startImageGenerationTask(job, storageKey);
    await state?.promise;
    job = await getImageGenerationTask(taskId, account);
  }

  if (!job || job.status !== 'succeeded' || !job.object_key) {
    throw new Error(job?.error_message || '图片未能保存到 COS');
  }

  return toPublicTask(job);
};

/** 返回最近任务，刷新页面后可用 conversationId 或 projectId 找回 taskId。 */
export const listImageGenerationTasks = async ({
  account,
  projectId,
  conversationId,
  assistantSessionId,
  page = 1,
  pageSize = 12,
}) => {
  const conditions = ['account = ?'];
  const params = [account];
  if (projectId) {
    conditions.push('project_id = ?');
    params.push(projectId);
  }
  if (conversationId) {
    conditions.push('conversation_id = ?');
    params.push(conversationId);
  }
  if (assistantSessionId) {
    conditions.push('assistant_session_id = ?');
    params.push(assistantSessionId);
  }
  const safePage = Math.max(Number(page) || 1, 1);
  const safePageSize = Math.min(Math.max(Number(pageSize) || 12, 1), 50);
  const offset = (safePage - 1) * safePageSize;
  const [rows] = await connection.query(
    `select * from ai_generated_images
     where ${conditions.join(' and ')}
     order by id desc limit ? offset ?`,
    [...params, safePageSize + 1, offset],
  );
  const hasMore = rows.length > safePageSize;
  const list = await Promise.all(rows.slice(0, safePageSize).map(toPublicTask));
  return {
    list,
    pagination: {
      page: safePage,
      pageSize: safePageSize,
      hasMore,
    },
  };
};

/** 查询单个任务；普通轮询和 SSE 重连都会使用同一份数据库状态。 */
export const getPublicImageGenerationTask = async (taskId, account) => {
  const job = await getImageGenerationTask(taskId, account);
  if (job && !TERMINAL_STATUSES.has(job.status) && !activeImageTasks.has(Number(taskId))) {
    startImageGenerationTask(job);
  }
  return toPublicTask(job);
};

/** SSE 重连：先发送完整快照，再挂接当前进程内的后续事件。 */
export const subscribeImageGenerationTask = async ({ taskId, account, storageKey, res }) => {
  let job = await getImageGenerationTask(taskId, account);
  if (!job) {
    writeSse(res, { event: 'error', data: { taskId, message: '图片生成任务不存在' } });
    res.end();
    return;
  }

  let state = activeImageTasks.get(Number(taskId));
  if (!TERMINAL_STATUSES.has(job.status) && !state) {
    state = startImageGenerationTask(job, storageKey);
  }

  let client = null;
  if (state) {
    client = {
      res,
      exposeTemporary: !job.assistant_session_id,
      heartbeat: setInterval(() => {
        if (!res.writableEnded) res.write(': ping\n\n');
      }, HEARTBEAT_INTERVAL_MS),
    };
    state.clients.add(client);
    res.on('close', () => {
      clearInterval(client.heartbeat);
      state.clients.delete(client);
    });
  }

  // 加入订阅后重新查询，避免在“读取快照”和“订阅”之间漏掉完成事件。
  job = await getImageGenerationTask(taskId, account);
  writeSse(res, { event: 'status', data: await toPublicTask(job) });
  if (job.temporary_url && !job.assistant_session_id) {
    writeSse(res, {
      event: 'generated',
      data: { taskId: Number(taskId), temporaryUrl: job.temporary_url },
    });
  }

  if (job.status === 'succeeded') {
    writeSse(res, { event: 'stored', data: await toPublicTask(job) });
    writeSse(res, { event: 'done', data: { taskId: Number(taskId) } });
    if (client) {
      clearInterval(client.heartbeat);
      state.clients.delete(client);
    }
    res.end();
    return;
  }
  if (job.status === 'failed') {
    writeSse(res, {
      event: 'error',
      data: { taskId: Number(taskId), message: job.error_message || '图片生成失败' },
    });
    if (client) {
      clearInterval(client.heartbeat);
      state.clients.delete(client);
    }
    res.end();
    return;
  }

};
