import { getProjectTempFiles, getFileContent, writeFileContent, downloadFile } from "../file/index.js";

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
      "description": "写入项目内文件内容，dirPath 由系统自动注入；文件不存在则创建，src 目录下支持自动创建父目录",
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
]

export const functionMap = {
  "get_file_list": getFileListTool,
  "get_file_content": getFileContentTool,
  "write_file_content": writeFileContentTool,
  "download_file": downloadFileTool,
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
    return returnJson(res, true, `写入文件内容成功: ${path}`)
  } catch (error) {
    return returnJson(null, false, `写入文件内容失败: ${error.message}`)
  }
}

/**
 * 从 URL 下载文件到项目 public 目录
 * @param {{ dirPath: string, url: string, path: string }} params 工具参数
 */
export async function downloadFileTool({dirPath, url, path}) {
  try {
    const res = await downloadFile(url, path, dirPath);
    return returnJson(res, true, `下载文件成功: ${res.relativePath}`)
  } catch (error) {
    return returnJson(null, false, `下载文件失败: ${error.message}`)
  }
}
