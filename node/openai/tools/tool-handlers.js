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

export async function getFileListTool({ dirPath }) {
  try {
    return returnJson(await getProjectTempFiles(dirPath), true, `获取文件列表成功: ${dirPath}`);
  } catch (error) {
    return returnJson(null, false, `获取文件列表失败: ${error.message}`);
  }
}

export async function getFileContentTool({ path, dirPath }) {
  try {
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
      toolCallId,
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
    });
    onEvent?.({ event: 'image_task', data: stored });
    return returnJson(
      {
        taskId: stored.taskId,
        status: stored.status,
        url: stored.url,
        width: stored.width,
        height: stored.height,
        contentType: stored.contentType,
        storedSize: stored.storedSize,
      },
      true,
      '图片已生成并保存到 COS',
    );
  } catch (error) {
    return returnJson(null, false, `图片生成失败: ${error.message}`);
  }
}

export const functionMap = {
  get_file_list: getFileListTool,
  get_file_content: getFileContentTool,
  write_file_content: writeFileContentTool,
  delete_file: deleteFileTool,
  download_file: downloadFileTool,
  upsert_file: upsertFileTool,
  generate_image: generateImageTool,
};
