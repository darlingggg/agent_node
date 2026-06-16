import { getProjectTempFiles,getFileContent, writeFileContent } from "../file/index.js";
export const tools = [
  {
    "type": "function",
    "function": {
      "name": "get_file_list",
      "description": "获取指定目录下的文件列表",
      "parameters": {
        "type": "object",
        "properties": {
          "dirPath": {
              "type": "string",
              "description": "目录路径，如C:/home/user/project，请注意目录路径是绝对路径"
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
      "description": "获取指定文件的内容",
      "parameters": {
        "type": "object",
        "properties": {
          "path": {
              "type": "string",
              "description": "文件路径，如C:/home/user/file.txt，请注意文件路径是绝对路径"
          },
          "dirPath":{
            "type": "string",
            "description": "项目根目录，如C:/home/user/project，请注意项目根目录是绝对路径"
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
      "description": "写入文件内容,如果当前文件不存在则创建文件,src 目录下支持自动创建父目录，其他目录仅允许在已有目录中创建文件",
      "parameters": {
        "type": "object",
        "properties": {
          "dirPath": {
              "type": "string",
              "description": "目录路径，如C:/home/user/project，请注意目录路径是绝对路径"
          },
          "path": {
            "type": "string",
            "description": "文件路径，如C:/home/user/file.txt，请注意文件路径是绝对路径"
          },
          "content": {
            "type": "string",
            "description": "文件内容 必须是完整的文件内容"
          },
        },
        "required": ["dirPath", "path", "content"]
      }
    }
  }
]

export const functionMap = {
  "get_file_list": getFileListTool,
  "get_file_content": getFileContentTool,
  "write_file_content": writeFileContentTool,
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
