import { getProjectTempFiles, getFileContent, writeFileContent, deleteFileContent, downloadFile,upsertFileByPatch, assertDeletableToolPath } from "../file/index.js";
import { markProjectFileActivity } from '../utils/activity.js';
import { createImageGenerationTask, waitForStoredImageGenerationTask } from '../imageGeneration/index.js';

export const tools = [
  {
    "type": "function",
    "function": {
      "name": "get_file_list",
      "description": "获取当前项目目录下的文件列表，dirPath 由系统自动注入，传任意占位值即可",
      "parameters": {
        "type": "object",
        "properties": {
          "dirPath": {
              "type": "string",
              "description": "项目根目录，由系统自动注入，无需自行填写"
          },
        },
        "required": ["dirPath"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "get_file_content",
      "description": "获取项目内指定文件的内容，dirPath 由系统自动注入",
      "parameters": {
        "type": "object",
        "properties": {
          "path": {
              "type": "string",
              "description": "文件相对路径，如 src/App.vue 或 index.html"
          },
          "dirPath":{
            "type": "string",
            "description": "项目根目录，由系统自动注入，无需自行填写"
          },
        },
        "required": ["path", "dirPath"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "write_file_content",
      "description": "创建全新文件，或在预计修改已有文件 40% 及以上、重构文件整体结构时全量写入。content 必须是完整文件内容；小于 40% 的修改应使用 upsert_file。dirPath 由系统自动注入，src/public 下支持自动创建父目录。",
      "parameters": {
        "type": "object",
        "properties": {
          "dirPath": {
              "type": "string",
              "description": "项目根目录，由系统自动注入，无需自行填写"
          },
          "path": {
            "type": "string",
            "description": "文件相对路径，如 src/App.vue 或 index.html"
          },
          "content": {
            "type": "string",
            "description": "文件内容 必须是完整的文件内容"
          },
        },
        "required": ["dirPath", "path", "content"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "delete_file",
      "description": "删除项目内指定文件，dirPath 由系统自动注入；仅允许删除 src 或 public 目录下的文件，其他目录不允许删除。",
      "parameters": {
        "type": "object",
        "properties": {
          "dirPath": {
              "type": "string",
              "description": "项目根目录，由系统自动注入，无需自行填写"
          },
          "path": {
            "type": "string",
            "description": "要删除的项目相对文件路径，只允许 src 或 public 下的文件，如 src/App.vue 或 public/images/logo.png"
          }
        },
        "required": ["dirPath", "path"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "download_file",
      "description": "从 URL 下载文件到项目 public 目录（图片及其他类型均可），dirPath 由系统自动注入；path 为相对路径且必须落在 public 下，父目录不存在则自动创建",
      "parameters": {
        "type": "object",
        "properties": {
          "dirPath": {
              "type": "string",
              "description": "项目根目录，由系统自动注入，无需自行填写"
          },
          "url": {
            "type": "string",
            "description": "文件下载地址，仅支持 http/https"
          },
          "path": {
            "type": "string",
            "description": "保存的相对路径，必须在 public 下，如 public/images/logo.png；也可写 images/logo.png（会自动归入 public）"
          },
        },
        "required": ["dirPath", "url", "path"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "upsert_file",
      "description": "增量更新预计变更不足 40% 的已有文件；每个 hunk 不得超过 120 行并只保留前后各 3-5 行上下文，分散修改应拆成多个 hunk。变更比例超限返回 PATCH_TOO_LARGE，改用 write_file_content；单个 hunk 超限返回 HUNK_TOO_LARGE，拆成多个小 hunk。dirPath 由系统自动注入。",
      "parameters": {
        "type": "object",
        "properties": {
          "dirPath": {
              "type": "string",
              "description": "项目根目录，由系统自动注入，无需自行填写"
          },
          "patch": {
            "type": "string",
            "description": "用于应用到项目文件的 unified diff 字符串。格式示例：--- a/src/App.vue\\n+++ b/src/App.vue\\n@@ -1,3 +1,3 @@\\n-old line\\n+new line。新增文件用 --- /dev/null 和 +++ b/path；删除文件用 --- a/path 和 +++ /dev/null。patch 中路径必须是项目相对路径并带 a/ 或 b/ 前缀；不得包含绝对路径、../、二进制内容或重命名操作。@@ 头部的旧/新行数必须分别等于正文中上下文与删除/新增行的总数。每个 hunk 不得超过 120 行，只保留前后各 3-5 行上下文；预计修改文件 40% 及以上时改用 write_file_content。"
          },
        },
        "required": ["dirPath", "patch"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "generate_image",
      "description": "根据用户要求生成一张图片。工具会等待图片保存到 COS 后才返回，结果不包含服务商临时地址。只有用户明确提出生成、绘制或创建图片时才调用。",
      "parameters": {
        "type": "object",
        "properties": {
          "prompt": {
            "type": "string",
            "description": "正向提示词，描述主体、场景、构图、光线和风格"
          },
          "negativePrompt": {
            "type": "string",
            "description": "可选，描述不希望画面中出现的元素、瑕疵或风格"
          },
          "imageUrls": {
            "type": "array",
            "maxItems": 3,
            "items": { "type": "string" },
            "description": "可选，图生图使用的 1-3 张公网图片地址"
          },
          "size": {
            "type": "string",
            "description": "输出尺寸，默认 auto；也可使用宽*高格式，宽高均为 512-2048，例如 1024*1024"
          }
        },
        "required": ["prompt"]
      }
    }
  },
]

export const functionMap = {
  "get_file_list": getFileListTool,
  "get_file_content": getFileContentTool,
  "write_file_content": writeFileContentTool,
  "delete_file": deleteFileTool,
  "download_file": downloadFileTool,
  "upsert_file": upsertFileTool,
  "generate_image": generateImageTool,
}

const returnJson = (data,isSuccess=false,message="") => JSON.stringify({
  success: isSuccess,
  message: message,
  data: data,
})

export async function getFileListTool({dirPath}) {
  try {
    const files = await getProjectTempFiles(dirPath);
    return returnJson(files, true, `获取文件列表成功: ${dirPath}`)
  } catch (error) {
    return returnJson(null, false, `获取文件列表失败: ${error.message}`)
  }
}

export async function getFileContentTool({path,dirPath}) {
  try {
    const content = await getFileContent(path,dirPath);
    return returnJson(content, true, `获取文件内容成功: ${path}`)
  } catch (error) {
    return returnJson(null, false, `获取文件内容失败: ${error.message}`)
  }
}

export async function writeFileContentTool({dirPath,path,content}) {
  try {
    const res = await writeFileContent(path,content,dirPath);
    await markProjectFileActivity(dirPath);
    return returnJson(res, true, `写入文件内容成功: ${path}`)
  } catch (error) {
    return returnJson(null, false, `写入文件内容失败: ${error.message}`)
  }
}

export async function deleteFileTool({dirPath,path}) {
  try {
    assertDeletableToolPath(path, dirPath);
    const res = await deleteFileContent(path, dirPath);
    await markProjectFileActivity(dirPath);
    return returnJson(res, true, `删除文件成功: ${path}`)
  } catch (error) {
    return returnJson(null, false, `删除文件失败: ${error.message}`)
  }
}

/**
 * 从 URL 下载文件到项目 public 目录
 * @param {{ dirPath: string, url: string, path: string }} params 工具参数
 */
export async function downloadFileTool({dirPath, url, path}) {
  try {
    const res = await downloadFile(url, path, dirPath);
    await markProjectFileActivity(dirPath);
    return returnJson(res, true, `下载文件成功: ${res.relativePath}`)
  } catch (error) {
    return returnJson(null, false, `下载文件失败: ${error.message}`)
  }
}

export async function upsertFileTool({dirPath, patch}) {
  try {
    const res = await upsertFileByPatch(patch, dirPath);
    await markProjectFileActivity(dirPath);
    return returnJson(res, true, `增量更新文件内容成功: ${patch}`)
  } catch (error) {
    return returnJson(null, false, `增量更新文件内容失败: ${error.message}`)
  }
}

/** 主 AI 生图工具：临时地址仅供后端转存，COS 成功后才返回工具结果。 */
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
    if (!account || !storageKey || !projectId || !conversationId || !assistantSessionId || !toolCallId) {
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
    return returnJson({
      taskId: stored.taskId,
      status: stored.status,
      url: stored.url,
      width: stored.width,
      height: stored.height,
      contentType: stored.contentType,
      storedSize: stored.storedSize,
    }, true, '图片已生成并保存到 COS');
  } catch (error) {
    return returnJson(null, false, '图片生成失败: ' + error.message);
  }
}
