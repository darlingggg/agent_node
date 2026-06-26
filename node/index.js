import express from 'express';
import cors from 'cors';
import resCC from './middleware/resCC.js';
import authJWT from './middleware/authJWT.js';
import { register, login } from './auth/index.js';
import { getProjectTempFiles, getFileContent, writeFileContent, copyDir, deleteFileContent, getFileMeta } from './file/index.js';
import { createProject, getProjectList, deleteProject,updateProject,getProjectInfo } from './project/index.js';
import { createSession, getSessionList,updateSession,deleteSession,getSessionDetail } from './session/index.js';
import { addLog, getLogList } from './log/index.js';
import { chat, keepContext,message } from './openai/index.js';
import { addSnapshot, getSnapshotList,deleteSnapshot,changeSnapshot } from './snapshot/index.js';
import { buildCommand } from './exec/index.js';

/** 默认服务端口 */
const PORT = 3000;
// const PORT = 5000;

/** 创建 Express 应用实例 */
const app = express();

// 创建上下文map
const contextMap = new Map();

// 接口返回 JSON，关闭 ETag 避免浏览器缓存导致 304
app.set('etag', false);

// 开启跨域支持，允许所有来源（开发环境）
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS','PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// 解析 JSON 和表单请求体
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 统一响应结构中间件
app.use(resCC);

/** 健康检查接口 */
app.get('/', (req, res) => {
  res.cc(0, 'Express 服务运行正常');
});

/** 用户注册 */
app.post('/register', async (req, res) => {
  try {
    const { account, password, nickname } = req.body;
    const result = await register(account, password, nickname);
    res.cc(0, '注册成功', result);
  } catch (err) {
    res.cc(1, err.message);
  }
});

/** 用户登录 */
app.post('/login', async (req, res) => {
  try {
    const { account, password } = req.body;
    const result = await login(account, password);
    res.cc(0, '登录成功', result);
  } catch (err) {
    res.cc(1, err.message);
  }
});

/** 获取当前登录用户信息 */
app.get('/user/profile', authJWT, (req, res) => {
  res.cc(0, '获取成功', req.user);
});

/** 拷贝文件夹到指定目录 */
app.post('/file/copy', async (req, res) => {
  try {
    const { sourceDir, targetDir } = req.body;
    const result = await copyDir(sourceDir, targetDir);
    res.cc(0, '拷贝成功', result);
  } catch (err) {
    res.cc(1, err.message);
  }
})

/** 获取文件目录，dir 为项目根目录 */
app.get('/files', async (req, res) => {
  try {
    const { dir } = req.query;
    const files = await getProjectTempFiles(dir);
    res.cc(0, '获取成功', files);
  } catch (err) {
    res.cc(1, err.message);
  }
});

/** 获取文件内容，dir 为项目根目录，path 为文件路径 */
app.get('/file/content', async (req, res) => {
  try {
    const { dir, path: filePath } = req.query;
    if (!filePath) return res.cc(1, 'path 不能为空');
    const content = await getFileContent(filePath, dir);
    res.cc(0, '获取成功', content);
  } catch (err) {
    res.cc(1, err.message);
  }
});

/** 写入文件内容，dir 为项目根目录，path 为文件路径 */
app.post('/file/write', async (req, res) => {
  try {
    const { dir, path: filePath, content = '' } = req.body;
    if (!filePath) return res.cc(1, 'path 不能为空');
    const result = await writeFileContent(filePath, content, dir);
    res.cc(0, '写入成功', result);
  } catch (err) {
    res.cc(1, err.message);
  }
});

/** 删除文件 */
app.post('/file/delete',async(req,res)=>{
  const {dir,path:filePath} = req.body;
  if(!filePath) return res.cc(1, '文件路径不能为空');
  if(!dir) return res.cc(1, '项目根目录不能为空');
  try {
    const result = await deleteFileContent(filePath, dir);
    res.cc(0, '删除成功', result);
  } catch (err) {
    res.cc(1, err.message);
  }
})

/** 获取文件字节数与行数，dir 为项目根目录，path 为文件路径 */
app.post('/file/meta', async (req, res) => {
  const { dir, path: filePath } = req.body;
  if (!filePath) return res.cc(1, '文件路径不能为空');
  if (!dir) return res.cc(1, '项目根目录不能为空');
  try {
    const result = await getFileMeta(filePath, dir);
    res.cc(0, '获取成功', result);
  } catch (err) {
    res.cc(1, err.message);
  }
});

/** 创建项目 */
app.post('/project/create',authJWT, async (req, res) => {
  const body = req.body;
  if(!body.title) return res.cc(1, '标题不能为空');
  try {
    const result = await createProject(req.user, body);
    res.cc(0, '创建成功', result);
  } catch (err) {
    res.cc(1, err.message);
  }
});

/** 获取项目列表 */
app.get('/project/list',authJWT, async (req, res) => {
  try {
    const result = await getProjectList(req.user);
    res.cc(0, '获取成功', result);
  } catch (err) {
    res.cc(1, err.message);
  }
});

/** 删除项目 */
app.post('/project/delete',authJWT, async (req, res) => {
  if(!req.body.id) return res.cc(1, 'id 不能为空');
  try {
    const result = await deleteProject(req.body.id, req.user);
    res.cc(0, '删除成功', result);
  } catch (err) {
    res.cc(1, err.message);
  }
});

/** 修改项目配置 */
app.patch('/project/update',authJWT, async (req, res) => {
  const body = req.body;
  if(!body.id) return res.cc(1, 'id 不能为空');
  if(!body.title) return res.cc(1, '标题不能为空');
  try {
    const result = await updateProject(body, req.user);
    res.cc(0, '修改成功', result);
  } catch (err) {
    res.cc(1, err.message);
  }
});

/** 创建会话 不同title代表不同会话 */
app.post('/session/create',authJWT, async (req, res) => {
  const body = req.body;
  if(!body.role) return res.cc(1, '角色不能为空');
  if(!body.projectId) return res.cc(1, '项目id不能为空');
  if(!body.content) return res.cc(1, '内容不能为空');
  try {
    const result = await createSession(body, req.user);
    res.cc(0, '创建成功', result);
  } catch (err) {
    res.cc(1, err.message);
  }
});

/** 获取会话列表 */
app.get('/session/list',authJWT, async (req, res) => {
  const { projectId,title } = req.query;
  if(!projectId) return res.cc(1, '项目id不能为空');
  try {
    const result = await getSessionList(projectId,title ? title : undefined, req.user);
    res.cc(0, '获取成功', result);
  } catch (err) {
    res.cc(1, err.message);
  }
});

/** 修改会话标题 */
app.patch('/session/update',authJWT, async (req, res) => {
  const { title,oldTitle,projectId } = req.body;
  if(!title) return res.cc(1, '新标题不能为空');
  if(!oldTitle) return res.cc(1, '旧标题不能为空');
  if(!projectId) return res.cc(1, '项目id不能为空');
  try {
    const result = await updateSession(req.body, req.user);
    res.cc(0, '修改成功', result);
  } catch (err) {
    res.cc(1, err.message);
  }
});

/** 删除会话 */
app.post('/session/delete',authJWT, async (req, res) => {
  const { title,projectId } = req.body;
  if(!title) return res.cc(1, '标题不能为空');
  if(!projectId) res.cc(1, '项目id不能为空');
  try {
    const result = await deleteSession(req.body, req.user);
    res.cc(0, '删除成功', result);
  } catch (err) {
    res.cc(1, err.message);
  }
});

/** 获取ai会话详情 */
app.get('/session/detail',authJWT, async (req, res) => {
  const { id } = req.query;
  if(!id) return res.cc(1, 'id不能为空');
  try {
    const result = await getSessionDetail(id);
    res.cc(0, '获取成功', result);
  } catch (err) {
    res.cc(1, err.message);
  }
});

/** 与AI对话（SSE 流式） */
app.post('/chat/stream', authJWT, async (req, res) => {
  const { prompt, projectId,title } = req.body
  if (!prompt) return res.cc(1, '发送消息为空')
  if (!projectId) return res.cc(1, '操作项目为空')

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()

  let clientClosed = false

  /** 推送 SSE 事件，格式与 chat 保持一致：{ event, data } */
  const send = (msg) => {
    if (clientClosed || res.writableEnded) return
    res.write(`data: ${JSON.stringify(msg)}\n\n`)
  }

  /**
   * 客户端在响应完成前断开时标记关闭，停止继续写入
   * 注意：不要用 req.on('close')，POST 请求体读完后也会触发，会导致连接立刻被关掉
   */
  res.on('close', () => {
    if (res.writableEnded) return
    clientClosed = true
  })
  let context = [...message]
  if(title && !contextMap.has(`${req.user.account}-${projectId}-${title}`)){
    const {result,length} = await keepContext(req.user.account,projectId,title);
    context = context.concat(result.map(item => ({role: item.role, content: item.content})));
    if(length > 0) contextMap.set(`${req.user.account}-${projectId}-${title}`,context);
  }else if(title && contextMap.has(`${req.user.account}-${projectId}-${title}`)){
    context = context.concat(contextMap.get(`${req.user.account}-${projectId}-${title}`));
  }else{
    contextMap.set(`${req.user.account}-${projectId}-${title}`,context);
  }

  try {
    const projectInfo = await getProjectInfo(projectId, req.user)
    const dirPath = projectInfo.dir_path
    const projectTitle = projectInfo.title ?? ""
    const desc = projectInfo.desc ?? ""
    const content = `【用户指令 - 最高优先级，请以此为准】\n${prompt}\n\n【项目背景 - 操作文件时使用】\n项目标题: ${projectTitle}\n项目描述: ${desc}\n项目Path: ${dirPath}\n组件库: vant\nCSS: tailwindcss\n\n注: 所有文件操作必须使用上述项目Path，path 参数用相对路径；看项目效果只需提示用户刷新页面`
    await chat(content, send, context, dirPath)
    if (clientClosed) return

    send({ event: 'done', data: null })
    res.end()
  } catch (err) {
    if (clientClosed) return

    send({ event: 'error', data: err.message })
    res.end()
  }
})

/** 添加日志 */
app.post('/log/add',authJWT, async (req, res) => {
  const { content, projectId } = req.body;
  if(!content) return res.cc(1, '日志内容不能为空');
  if(!projectId) return res.cc(1, '项目id不能为空');
  try {
    const result = await addLog(content, projectId, req.user);
    res.cc(0, '添加成功', result);
  } catch (err) {
    res.cc(1, err.message);
  }
})

/** 获取日志列表 */
app.get('/log/list',authJWT, async (req, res) => {
  const { projectId } = req.query;
  if(!projectId) return res.cc(1, '项目id不能为空');
  try {
    const result = await getLogList(projectId, req.user);
    res.cc(0, '获取成功', result);
  } catch (err) {
    res.cc(1, err.message);
  }
})

/** 添加快照列表 */
app.post('/snapshot/add',authJWT, async (req, res) => {
  const { projectId,version,dirPath,desc } = req.body;
  if(!version) return res.cc(1, '版本号不能为空');
  if(!projectId) return res.cc(1, '关联项目不能为空');
  if(!dirPath) return res.cc(1, '项目根路径不能为空');
  try {
    const result = await addSnapshot(projectId, version, dirPath, desc, req.user);
    res.cc(0, '添加成功', result);
  } catch (err) {
    res.cc(1, err.message);
  }
})

/** 获取快照列表 */
app.get('/snapshot/list',authJWT, async (req, res) => {
  const { projectId } = req.query;
  if(!projectId) return res.cc(1, '项目id不能为空');
  try {
    const result = await getSnapshotList(projectId);
    res.cc(0, '获取成功', result);
  } catch (err) {
    res.cc(1, err.message);
  }
})

/** 删除快照列表 */
app.post('/snapshot/delete',authJWT, async (req, res) => {
  const { projectId,version } = req.body;
  if(!projectId) return res.cc(1, '项目id不能为空');
  if(!version) return res.cc(1, '版本号不能为空');
  try {
    const result = await deleteSnapshot(projectId,version);
    res.cc(0, '删除成功', result);
  } catch (err) {
    res.cc(1, err.message);
  }
})

/** 修改快照信息 */
app.patch('/snapshot/change',authJWT, async (req, res) => {
  const { projectId,version,oldVersion,desc } = req.body;
  if(!projectId) return res.cc(1, '项目id不能为空');
  if(!version) return res.cc(1, '版本号不能为空');
  if(!oldVersion) return res.cc(1, '旧版本号不能为空');
  if(version === oldVersion) return res.cc(1, '新旧版本号不能相同');
  try {
    const result = await changeSnapshot(projectId,version,oldVersion,desc);
    res.cc(0, '修改成功', result);
  } catch (err) {
    res.cc(1, err.message);
  }
})

/** 构建并部署项目 */
app.post('/project/build',authJWT,async(req,res)=>{
  const { dir } = req.body;
  if(!dir) return res.cc(1, '项目根目录不能为空');

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()

  let clientClosed = false

  /** 推送 SSE 事件，格式与 chat 保持一致：{ event, data } */
  const send = (msg) => {
    if (clientClosed || res.writableEnded) return
    res.write(`data: ${JSON.stringify(msg)}\n\n`)
  }

  res.on('close', () => {
    if (res.writableEnded) return
    clientClosed = true
  })

  try {
    await buildCommand(dir,send);
    if (clientClosed) return
    res.end()
  } catch (err) {
    if (clientClosed) return
    send({ event: 'error', data: '错误信息: \n' + err.message })
    res.end()
    res.cc(1, err.message);
  }
})

app.listen(PORT, () => {
  console.log(`Express 服务已启动: http://localhost:${PORT}`);
});

