import {
  assertDeletableToolPath,
  deleteFileContent,
  downloadFile,
  getFileContent,
  getProjectTempFiles,
  upsertFileByPatch,
  writeFileContent,
} from '../../file/index.js';
import { markProjectFileActivity } from '../../utils/activity.js';
import { fetchPageTool, searchWebTool } from './web-tools.js';
import { uploadedImages } from '../media/image-input.js';
import { describeImage } from '../media/image-desc.js';
import { countContextTokens, throwIfAborted } from '../context/usage.js';
import {
  createImageGenerationTask,
  waitForStoredImageGenerationTask,
} from '../../imageGeneration.js';

const returnJson = (data, success = false, message = '') =>
  JSON.stringify({
    success,
    message,
    data,
  });

/** 原生分支只取图，外接分支返回分析；后续主模型请求由 chat 循环负责。 */
export async function viewImageTool(args = {}, runtime = {}) {
  let promptTokens = 0;
  try {
    const { question, detail = 'auto' } = args;
    if (typeof question !== 'string' || !question.trim() || question.length > 2000) throw new Error('question 必须为 1-2000 个字符');
    if (!['auto', 'low', 'high'].includes(detail)) throw new Error('detail 无效');
    const images = await runtime.images.resolve(args);
    const urls = await Promise.all(images.map((image) => runtime.images.load(image)));
    promptTokens = countContextTokens([{ role: 'user', content: [{ type: 'text', text: question }, ...urls.map((url) => ({ type: 'image_url', image_url: { url } }))] }]);
    throwIfAborted(runtime.signal);
    const mode = runtime.modelConfig?.supportsVision ? 'native' : 'external';
    let analysis = '';
    let usage = null;
    if (mode === 'external') {
      const result = await describeImage(question, urls, () => {}, runtime.signal, detail);
      analysis = result.response?.trim();
      usage = {
        usage: result.usage,
        promptTokens,
        completionText: `${result.reasoning || ''}${analysis || ''}`,
      };
      if (!analysis) throw Object.assign(new Error('外接视觉模型未返回分析结果'), { imageUsage: usage });
    }
    const data = { mode, images, question, analysis: analysis || undefined, status: mode === 'native' ? 'loaded' : 'analyzed' };
    return {
      modelContent: returnJson(data, true, mode === 'native' ? '图片已加载，真实图片随后的消息提供' : '图片分析完成'),
      observation: { images, question, analysis, mode, detail, sourceToolCallId: runtime.toolCallId },
      usage,
    };
  } catch (error) {
    const usage = error.imageUsage || (error.visionUsage ? { ...error.visionUsage, promptTokens } : null);
    // 先把已发生的视觉消耗交给 chat 统计，再由外层收束取消状态。
    return { modelContent: returnJson(null, false, `查看图片失败：${error.message}`), usage };
  }
}

export async function getFileListTool({ dirPath }) {
  try {
    return returnJson(await getProjectTempFiles(dirPath), true, `获取文件列表成功: ${dirPath}`);
  } catch (error) {
    return returnJson(null, false, `获取文件列表失败: ${error.message}`);
  }
}

export async function getFileContentTool({ path, dirPath }) {
  try {
    if (/\.(png|jpe?g|webp|gif|avif|heic|heif|svg)$/i.test(path || '')) {
      throw new Error('这是图片文件，请使用 view_image({ paths: [图片路径], question: 观察问题 }) 查看');
    }
    return returnJson(await getFileContent(path, dirPath), true, `获取文件内容成功: ${path}`);
  } catch (error) {
    return returnJson(null, false, `获取文件内容失败: ${error.message}`);
  }
}

export async function writeFileContentTool({ dirPath, path, content }) {
  try {
    const result = await writeFileContent(path, content, dirPath);
    await markProjectFileActivity(dirPath);
    return returnJson(result, true, `写入文件内容成功: ${path}`);
  } catch (error) {
    return returnJson(null, false, `写入文件内容失败: ${error.message}`);
  }
}

export async function deleteFileTool({ dirPath, path }) {
  try {
    assertDeletableToolPath(path, dirPath);
    const result = await deleteFileContent(path, dirPath);
    await markProjectFileActivity(dirPath);
    return returnJson(result, true, `删除文件成功: ${path}`);
  } catch (error) {
    return returnJson(null, false, `删除文件失败: ${error.message}`);
  }
}

export async function downloadFileTool({ dirPath, url, path }) {
  try {
    const result = await downloadFile(url, path, dirPath);
    await markProjectFileActivity(dirPath);
    return returnJson(result, true, `下载文件成功: ${result.relativePath}`);
  } catch (error) {
    return returnJson(null, false, `下载文件失败: ${error.message}`);
  }
}

export async function upsertFileTool({ dirPath, patch }) {
  try {
    const result = await upsertFileByPatch(patch, dirPath);
    await markProjectFileActivity(dirPath);
    return returnJson(result, true, `增量更新文件内容成功: ${patch}`);
  } catch (error) {
    return returnJson(null, false, `增量更新文件内容失败: ${error.message}`);
  }
}

export async function generateImageTool(args, runtime = {}) {
  try {
    const {
      account,
      storageKey,
      projectId,
      conversationId,
      assistantSessionId,
      toolCallId,
      invocationId,
      onEvent,
    } = runtime;
    if (
      !account ||
      !storageKey ||
      !projectId ||
      !conversationId ||
      !assistantSessionId ||
      !toolCallId
    ) {
      throw new Error('生图工具缺少可信会话上下文');
    }

    const task = await createImageGenerationTask({
      account,
      storageKey,
      projectId,
      conversationId,
      assistantSessionId,
      toolCallId: invocationId || toolCallId,
      prompt: args.prompt,
      negativePrompt: args.negativePrompt || '',
      imageUrls: args.imageUrls || [],
      size: args.size || 'auto',
    });
    onEvent?.({ event: 'image_task', data: task });

    const stored = await waitForStoredImageGenerationTask({
      taskId: task.taskId,
      account,
      storageKey,
      signal: runtime.signal,
    });
    onEvent?.({ event: 'image_task', data: stored });
    const images = uploadedImages([stored.url], storageKey);
    runtime.images?.register(images);
    return { modelContent: returnJson(
      {
        taskId: stored.taskId,
        status: stored.status,
        url: stored.url,
        width: stored.width,
        height: stored.height,
        contentType: stored.contentType,
        storedSize: stored.storedSize,
        images,
      },
      true,
      '图片已生成并保存到 COS',
    ), observation: { images, question: '图片已生成，尚未查看；需要细节时调用 view_image', mode: 'available', sourceToolCallId: toolCallId } };
  } catch (error) {
    return returnJson(null, false, `图片生成失败: ${error.message}`);
  }
}

export const functionMap = {
  view_image: viewImageTool,
  search_web: searchWebTool,
  fetch_page: fetchPageTool,
  get_file_list: getFileListTool,
  get_file_content: getFileContentTool,
  write_file_content: writeFileContentTool,
  delete_file: deleteFileTool,
  download_file: downloadFileTool,
  upsert_file: upsertFileTool,
  generate_image: generateImageTool,
};
