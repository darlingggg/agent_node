import path from 'path';

const FILE_PATH_TOOLS = new Set([
  'get_file_content',
  'write_file_content',
  'delete_file',
  'download_file',
]);

export function bindProjectDirPath(name, args, projectDirPath) {
  if (!projectDirPath) return args;

  const bound = { ...args, dirPath: projectDirPath };
  if (!FILE_PATH_TOOLS.has(name)) return bound;

  const filePath = String(args.path || '').trim();
  if (!filePath) return bound;

  const normalizedRoot = path.normalize(projectDirPath);
  const normalizedPath = path.normalize(filePath);
  if (normalizedPath.startsWith(normalizedRoot + path.sep) || normalizedPath === normalizedRoot) {
    bound.path = path.relative(normalizedRoot, normalizedPath);
    return bound;
  }
  if (!path.isAbsolute(normalizedPath)) return bound;

  if (name === 'download_file') {
    const publicSegment = `${path.sep}public${path.sep}`;
    const publicIndex = normalizedPath.indexOf(publicSegment);
    if (publicIndex !== -1) bound.path = normalizedPath.slice(publicIndex + 1);
    else if (normalizedPath.endsWith(`${path.sep}public`) || normalizedPath.endsWith('/public')) {
      bound.path = 'public';
    } else {
      bound.path = path.join('public', path.basename(normalizedPath));
    }
    return bound;
  }

  const sourceSegment = `${path.sep}src${path.sep}`;
  const sourceIndex = normalizedPath.indexOf(sourceSegment);
  if (sourceIndex !== -1) bound.path = normalizedPath.slice(sourceIndex + 1);
  else if (normalizedPath.endsWith(`${path.sep}index.html`) || normalizedPath.endsWith('/index.html')) {
    bound.path = 'index.html';
  } else {
    bound.path = path.basename(normalizedPath);
  }
  return bound;
}

export function mergeToolCallDeltas(toolCallsMap, deltaToolCalls) {
  for (const toolCall of deltaToolCalls) {
    const { index } = toolCall;
    if (!toolCallsMap[index]) {
      toolCallsMap[index] = {
        id: '',
        type: 'function',
        function: { name: '', arguments: '' },
      };
    }
    const target = toolCallsMap[index];
    if (toolCall.id) target.id = toolCall.id;
    if (toolCall.type) target.type = toolCall.type;
    if (toolCall.function?.name) target.function.name += toolCall.function.name;
    if (toolCall.function?.arguments) target.function.arguments += toolCall.function.arguments;
  }
}

export function buildUserContent(visionResult, userMessage, prompt) {
  const instruction = userMessage || prompt;
  if (!visionResult) return instruction;
  return `【视觉模型分析结果 - 系统已代你看图，等同于你已亲眼所见】
以下由专用视觉模型对用户上传图片的分析结果，请将其视为你的视觉输入，直接回答用户问题。

禁止：
- 不要说「无法查看图片」「我看不到图像」「根据你附带的视觉分析报告」
- 不要追问或评论视觉分析工具的来源
- 作答时用「图中…」「从图片可见…」，不要暴露双模型架构

${visionResult}

${instruction}`;
}

export function parseToolArguments(toolCall) {
  try {
    return JSON.parse(toolCall.function.arguments || '{}');
  } catch (error) {
    throw new Error(`工具 ${toolCall.function.name || 'unknown'} 参数不是有效 JSON: ${error.message}`);
  }
}
