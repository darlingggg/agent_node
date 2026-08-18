import express from 'express';
import { fileURLToPath } from 'url';
import authJWT from '../middleware/authJWT.js';
import { register, login, refreshAccessToken, logout, getUserProfile, updateUserProfile } from '../auth/index.js';
import { buildWechatOAuthUrl, loginWithWechatCode, verifyWechatServerSignature } from '../auth/wechat.js';
import { buildQQOAuthUrl, loginWithQQCode } from '../auth/qq.js';
import { normalizeOAuthReturnUrl, OAuthSessionStore } from '../auth/oauthSession.js';
import { getOAuthCallbackAction } from '../auth/oauthCallback.js';
import { getProjectTempFiles, getFileContent, writeFileContent, copyDir, deleteFileContent, getFileMeta, importFilesToPublic, deletePublicAsset, resolvePublicAssetFile } from '../file/index.js';
import multer from 'multer';
import { createProject, getProjectList, deleteProject,updateProject,getProjectInfo,buildProject,
  getLatestTemplateVersion,getCurrentProjectTemplateVersion,updateProjectTemplateVersion,getAllTemplateVersionFiles } from '../project/index.js';
import { createSession, createUserChatSession, createStreamingAssistantSession, getSessionList,
  updateSession,deleteSession,getSessionDetail,getOrCreateConversation,getConversationStats,
  settleConversationUsage } from '../session/index.js';
import { addLog, getLogList } from '../log/index.js';
import { keepContext,message } from '../openai/index.js';
import { runAiChat, startChatStream, subscribeChatStream, cancelChatStream } from '../chatStream/index.js';
import { addSnapshot, getSnapshotList,deleteSnapshot,changeSnapshot,getCurrentVision } from '../snapshot/index.js';
import { buildCommand,deleteOnlineVersion } from '../exec/index.js';
import { getCredential } from '../cos/index.js';
import { markProjectFileActivity, markUserActive } from '../utils/activity.js';
import { QQ_REDIRECT_URI } from '../../key.js';

/** 前台接口路由；挂载在根路径以保持现有接口地址不变。 */
const app = express.Router();

// 创建上下文map
const contextMap = new Map();

const wechatAuthSessions = new OAuthSessionStore('wechat');
const qqAuthSessions = new OAuthSessionStore('qq');
const oauthSuccessPage = fileURLToPath(new URL('../auth/pages/oauth-success.html', import.meta.url));
const oauthProcessingPage = fileURLToPath(new URL('../auth/pages/oauth-processing.html', import.meta.url));
const oauthErrorPage = fileURLToPath(new URL('../auth/pages/oauth-error.html', import.meta.url));

const allowOrigin = ["http://localhost:5173", "https://darling.xin", "https://www.darling.xin"];

/** 内存上传：用于把前端 File 写入项目 public */
const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 3 * 1024 * 1024,
    files: 20,
  },
});

/**
 * 解析前端传入的 urls / saveNames 字段（支持 JSON 数组字符串、单个字符串、数组）
 * @param {unknown} raw 原始值
 * @returns {string[]}
 */
function parseImportUrls(raw) {
  if (raw == null || raw === '') return [];
  if (Array.isArray(raw)) return raw.map((item) => String(item).trim()).filter(Boolean);
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return [];
    if (text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
          return parsed.map((item) => String(item).trim()).filter(Boolean);
        }
      } catch {
        // 非 JSON 时按单个值处理
      }
    }
    return [text];
  }
  return [String(raw).trim()].filter(Boolean);
}

/**
 * 解析保存文件名列表（保留空字符串占位，表示该位置用默认名）
 * @param {unknown} raw 原始值
 * @returns {string[]}
 */
function parseSaveNames(raw) {
  if (raw == null || raw === '') return [];
  if (Array.isArray(raw)) {
    return raw.map((item) => (item == null ? '' : String(item).trim()));
  }
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return [];
    if (text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
          return parsed.map((item) => (item == null ? '' : String(item).trim()));
        }
      } catch {
      }
    }
    return [text];
  }
  return [String(raw).trim()];
}

function getExternalOrigin(req) {
  const forwardedProto = req.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const forwardedHost = req.get('x-forwarded-host')?.split(',')[0]?.trim();
  const protocol = forwardedProto || req.protocol;
  const host = forwardedHost || req.get('host');
  return `${protocol}://${host}`;
}

function getWechatRedirectUri(req) {
  return String(req.query.redirectUri || `${getExternalOrigin(req)}/api/auth/wechat/callback`);
}

function getQQRedirectUri() {
  return String(QQ_REDIRECT_URI || '');
}

function getOAuthEventsUrl(provider, state, streamToken) {
  const params = new URLSearchParams({ state, streamToken });
  return `/auth/${provider}/events?${params.toString()}`;
}

function subscribeOAuthEvents(store, req, res) {
  const result = store.subscribe({
    state: String(req.query.state || ''),
    streamToken: String(req.query.streamToken || ''),
    req,
    res,
  });

  if (!result.ok && !res.headersSent) {
    res.status(result.status).json({ status: 1, message: result.message, data: null });
  }
}

function sendOAuthResultPage(res, result, returnUrl = '') {
  const status = result === true ? 'success' : result === false ? 'error' : result;
  const page = status === 'success'
    ? oauthSuccessPage
    : status === 'processing'
      ? oauthProcessingPage
      : oauthErrorPage;

  if (returnUrl && status !== 'processing') {
    res.setHeader('Cache-Control', 'no-store');
    return res.redirect(302, returnUrl);
  }

  res.status(200);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; frame-ancestors 'none'");
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-OAuth-Result', status);
  return res.sendFile(page);
}

/** 健康检查接口 */
app.get('/', (req, res) => {
  res.cc(0, 'Express 服务运行正常');
});

/** 微信测试账号服务器验证 */
app.get('/wechat', (req, res) => {
  const { signature, timestamp, nonce, echostr } = req.query;

  if (!verifyWechatServerSignature({ signature, timestamp, nonce })) {
    res.status(403).type('text/plain').send('Forbidden');
    return;
  }

  res.type('text/plain').send(String(echostr || ''));
});

app.post('/wechat', (req, res) => {
  res.type('text/plain').send('success');
});

app.get('/auth/wechat/url', (req, res) => {
  let authSession = null;
  try {
    const redirectUri = getWechatRedirectUri(req);
    authSession = wechatAuthSessions.create({ redirectUri });
    const { state, streamToken, expiresAt } = authSession;
    const authorizeUrl = buildWechatOAuthUrl({ redirectUri, state });
    const eventsUrl = getOAuthEventsUrl('wechat', state, streamToken);
    res.cc(0, '获取微信授权链接成功', {
      authorizeUrl,
      redirectUri,
      state,
      streamToken,
      eventsUrl,
      expiresAt,
    });
  } catch (err) {
    if (authSession) wechatAuthSessions.remove(authSession.state);
    res.cc(1, err.message);
  }
});

app.get('/auth/wechat/bind',authJWT,(req,res)=>{
  const { account } = req.user;
  let authSession = null;
  try {
    const redirectUri = getWechatRedirectUri(req);
    authSession = wechatAuthSessions.create({ redirectUri, account });
    const { state, streamToken, expiresAt } = authSession;
    const authorizeUrl = buildWechatOAuthUrl({ redirectUri, state });
    const eventsUrl = getOAuthEventsUrl('wechat', state, streamToken);
    res.cc(0, '获取微信授权链接成功', {
      authorizeUrl,
      redirectUri,
      state,
      streamToken,
      eventsUrl,
      expiresAt,
    });
  } catch (err) {
    if (authSession) wechatAuthSessions.remove(authSession.state);
    res.cc(1, err.message);
  }
})

app.get('/auth/wechat/events', (req, res) => {
  subscribeOAuthEvents(wechatAuthSessions, req, res);
});

app.get('/auth/wechat/callback', async (req, res) => {
  const state = req.query.state ? String(req.query.state) : '';
  const wechatAuth = wechatAuthSessions.get(state);

  if (!wechatAuth || wechatAuth.status !== 'waiting') {
    return sendOAuthResultPage(res, false);
  }

  try {
    const code = String(req.query.code || '');
    wechatAuthSessions.publish(state, {
      event: 'scan_complete',
      status: 'processing',
      message: '扫码完成，正在登录...',
    });
    const result = await loginWithWechatCode(code,wechatAuth,wechatAuth.account || "");
    wechatAuthSessions.publish(state, {
      event: 'login_success',
      status: 'success',
      message: '微信登录成功',
      result: { ...result, state },
    });
    return sendOAuthResultPage(res, true);
  } catch (err) {
    wechatAuthSessions.publish(state, {
      event: 'login_error',
      status: 'error',
      message: err.message,
    });
    return sendOAuthResultPage(res, false);
  }
});

app.get('/auth/qq/url', (req, res) => {
  let authSession = null;
  try {
    const redirectUri = getQQRedirectUri();
    const returnUrl = normalizeOAuthReturnUrl(req.query.returnUrl, allowOrigin);
    authSession = qqAuthSessions.create({ redirectUri, returnUrl });
    const { state, streamToken, expiresAt } = authSession;
    const authorizeUrl = buildQQOAuthUrl({ redirectUri, state });
    const eventsUrl = getOAuthEventsUrl('qq', state, streamToken);
    res.cc(0, '获取 QQ 授权链接成功', {
      authorizeUrl,
      redirectUri,
      state,
      streamToken,
      eventsUrl,
      expiresAt,
    });
  } catch (err) {
    if (authSession) qqAuthSessions.remove(authSession.state);
    res.cc(1, err.message);
  }
});

app.get('/auth/qq/bind', authJWT, (req, res) => {
  const { account } = req.user;
  let authSession = null;
  try {
    const redirectUri = getQQRedirectUri();
    authSession = qqAuthSessions.create({ redirectUri, account });
    const { state, streamToken, expiresAt } = authSession;
    const authorizeUrl = buildQQOAuthUrl({ redirectUri, state });
    const eventsUrl = getOAuthEventsUrl('qq', state, streamToken);
    res.cc(0, '获取 QQ 绑定链接成功', {
      authorizeUrl,
      redirectUri,
      state,
      streamToken,
      eventsUrl,
      expiresAt,
    });
  } catch (err) {
    if (authSession) qqAuthSessions.remove(authSession.state);
    res.cc(1, err.message);
  }
});

app.get('/auth/qq/events', (req, res) => {
  subscribeOAuthEvents(qqAuthSessions, req, res);
});

async function handleQQCallback(req, res) {
  const state = req.query.state ? String(req.query.state) : '';
  const qqAuth = qqAuthSessions.get(state);
  const callbackAction = getOAuthCallbackAction(qqAuth);

  if (callbackAction === 'error') {
    return sendOAuthResultPage(res, false, qqAuth?.returnUrl);
  }
  if (callbackAction === 'success') {
    return sendOAuthResultPage(res, true, qqAuth.returnUrl);
  }
  if (callbackAction === 'processing') {
    return sendOAuthResultPage(res, 'processing');
  }

  try {
    if (req.query.error) {
      throw new Error(String(req.query.error_description || req.query.error));
    }

    const code = String(req.query.code || '');
    qqAuthSessions.publish(state, {
      event: 'scan_complete',
      status: 'processing',
      message: '扫码完成，正在登录...',
    });
    const result = await loginWithQQCode(code, qqAuth, qqAuth.account || '');
    qqAuthSessions.publish(state, {
      event: 'login_success',
      status: 'success',
      message: 'QQ 登录成功',
      result: { ...result, state },
    });
    return sendOAuthResultPage(res, true, qqAuth.returnUrl);
  } catch (err) {
    qqAuthSessions.publish(state, {
      event: 'login_error',
      status: 'error',
      message: err.message,
    });
    return sendOAuthResultPage(res, false, qqAuth.returnUrl);
  }
}

// 保留 QQ 互联当前已登记的地址，同时提供与微信一致的命名方式。
app.get('/oauth/callback', handleQQCallback);
app.get('/auth/qq/callback', handleQQCallback);

/** 获取腾讯云对象存储临时密钥 */
app.get('/cos/credential', authJWT, async (req, res) => {
  try {
    const result = await getCredential(req.user.storage_key);
    await markUserActive(req.user.id);
    res.cc(0, '获取成功', result);
  } catch (err) {
    res.cc(1, err.message);
  }
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

/** 刷新 Access Token */
app.post('/auth/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    const result = await refreshAccessToken(refreshToken);
    res.cc(0, '刷新成功', result);
  } catch (err) {
    res.cc(1, err.message);
  }
});

/** 用户登出 */
app.post('/auth/logout', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    await logout(refreshToken);
    res.cc(0, '登出成功');
  } catch (err) {
    res.cc(1, err.message);
  }
});

/** 获取当前登录用户信息 */
app.get('/user/profile', authJWT, async (req, res) => {
  try {
    const profile = await getUserProfile(req.user.id);
    res.cc(0, '获取成功', profile);
  } catch (err) {
    res.cc(1, err.message);
  }
});

/** 按前端传入的有效字段修改当前登录用户信息 */
app.patch('/user/profile', authJWT, async (req, res) => {
  try {
    const profile = await updateUserProfile(req.user.id, req.body);
    res.cc(0, '修改成功', profile);
  } catch (err) {
    res.cc(1, err.message);
  }
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
    await markProjectFileActivity(dir);
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
    await markProjectFileActivity(dir);
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

/**
 * 下载/上传文件到项目 public 目录
 * - dirPath: 项目根绝对路径（必填）
 * - path: public 下子目录，默认 / 表示 public；/images 表示 public/images
 * - urls: 远程链接，支持多个（JSON 数组字符串或单个 url）；也兼容字段 url
 * - files: 上传的 File（multipart，字段名 files，可多个）
 * - fileName / saveNames: 自定义保存文件名，按「先 urls 后 files」顺序对应
 */
app.post('/file/download',authJWT, memoryUpload.array('files', 20), async (req, res) => {
  try {
    const dirPath = req.body.dirPath;
    const savePath = req.body.path ?? '/';
    const urls = [
      ...parseImportUrls(req.body.urls),
      ...parseImportUrls(req.body.url),
    ];
    const files = Array.isArray(req.files) ? req.files : [];
    // 自定义文件名：saveNames / fileNames / fileName 三选一，优先级从左到右
    const saveNames = parseSaveNames(
      req.body.saveNames ?? req.body.fileNames ?? req.body.fileName
    );

    if (!dirPath) return res.cc(1, '项目根路径 dirPath 不能为空');
    if (urls.length === 0 && files.length === 0) {
      return res.cc(1, '请至少提供一个 url 或上传文件');
    }

    const result = await importFilesToPublic({
      dirPath,
      path: savePath,
      urls,
      files,
      saveNames,
    });

    const failed = result.results.filter((item) => !item.success);
    if (failed.length === result.results.length) {
      return res.cc(1, '全部文件处理失败', result);
    }
    await markProjectFileActivity(dirPath);
    if (failed.length > 0) {
      return res.cc(0, `部分成功，失败 ${failed.length} 个`, result);
    }
    res.cc(0, '处理成功', result);
  } catch (err) {
    res.cc(1, err.message);
  }
});

/**
 * 删除 public 下的上传素材
 * - dirPath: 项目根绝对路径（必填）
 * - path: 文件绝对路径或相对项目根路径（必填），如 public/images/a.png
 */
app.post('/file/asset/delete', authJWT, async (req, res) => {
  try {
    const { dirPath, path: filePath } = req.body;
    if (!dirPath) return res.cc(1, '项目根路径 dirPath 不能为空');
    if (!filePath) return res.cc(1, '文件路径 path 不能为空');

    const result = await deletePublicAsset(filePath, dirPath);
    await markProjectFileActivity(dirPath);
    res.cc(0, '删除成功', result);
  } catch (err) {
    res.cc(1, err.message);
  }
});

/**
 * 读取 public 下素材文件（用于前端预览）
 * - dirPath: 项目根绝对路径（必填）
 * - path: 相对项目根或绝对路径（必填），如 public/images/a.png
 */
app.get('/file/asset', authJWT, async (req, res) => {
  try {
    const dirPath = req.query.dirPath;
    const filePath = req.query.path;
    if (!dirPath) return res.cc(1, '项目根路径 dirPath 不能为空');
    if (!filePath) return res.cc(1, '文件路径 path 不能为空');

    const result = await resolvePublicAssetFile(String(filePath), String(dirPath));
    res.sendFile(result.path, (err) => {
      if (err && !res.headersSent) {
        res.cc(1, err.message || '文件读取失败');
      }
    });
  } catch (err) {
    res.cc(1, err.message);
  }
});

/** 创建项目 */
app.post('/project/create',authJWT, async (req, res) => {
  const body = req.body;
  if(!body.title) return res.cc(1, '标题不能为空');
  if(!body.type) return res.cc(1, '类型不能为空');
  try {
    const result = await createProject(req.user, body);
    await markUserActive(req.user.id);
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
    await markUserActive(req.user.id);
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
    await markUserActive(req.user.id);
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

/** 获取会话累计 token 与当前上下文长度。 */
app.get('/conversation/stats', authJWT, async (req, res) => {
  const { conversationId, projectId, title } = req.query;
  if (!conversationId && (!projectId || !title)) return res.cc(1, 'conversationId 或 projectId + title 不能为空');
  try {
    const result = await getConversationStats({ conversationId, projectId, title }, req.user);
    res.cc(0, '获取成功', result);
  } catch (err) {
    res.cc(1, err.message);
  }
});

/** 获取项目累计 token。 */
app.get('/project/usage', authJWT, async (req, res) => {
  const { projectId } = req.query;
  if (!projectId) return res.cc(1, '项目id不能为空');
  try {
    const project = await getProjectInfo(projectId, req.user);
    res.cc(0, '获取成功', {
      projectId: project.id,
      promptTokens: Number(project.ai_prompt_tokens) || 0,
      completionTokens: Number(project.ai_completion_tokens) || 0,
      totalTokens: Number(project.ai_total_tokens) || 0,
    });
  } catch (err) {
    res.cc(1, err.message);
  }
});

/** 与AI对话（SSE 流式） */
app.post('/chat/stream', authJWT, async (req, res) => {
  const { prompt, projectId, title, imageUrls = [] } = req.body
  if (!prompt) return res.cc(1, '发送消息不能为空')
  if (!projectId) return res.cc(1, '操作项目不能为空')

  const sessionTitle = title || prompt.slice(0, 30)
  let context = message.map(item => ({ ...item }))

  try {
    const projectInfo = await getProjectInfo(projectId, req.user)
    await markUserActive(req.user.id)
    const conversation = await getOrCreateConversation({ projectId, title: sessionTitle }, req.user)
    const contextKey = String(conversation.id)
    // 获取上下文历史记录
    if (sessionTitle && !contextMap.has(contextKey)) {
      const { result } = await keepContext(
        req.user.account,
        projectId,
        sessionTitle,
        conversation.id,
        conversation.summarized_until_session_id
      )
      const history = result.map(item => ({
        role: item.role === "vision" ? "user" : item.role,
        content: item.content,
        _sessionId: item.id,
      }))
      if (conversation.summary) {
        history.unshift({
          role: 'system',
          content: `【历史对话压缩摘要】\n${conversation.summary}`,
          _isSummary: true,
          _summarizedUntilSessionId: conversation.summarized_until_session_id,
        })
      }
      context = context.concat(history)
      contextMap.set(contextKey, history)
    } else if (sessionTitle && contextMap.has(contextKey)) {
      context = context.concat(contextMap.get(contextKey))
    }

    const dirPath = projectInfo.dir_path
    const projectTitle = projectInfo.title ?? ""
    const desc = projectInfo.desc ?? ""
    const userSession = await createUserChatSession({
      title: sessionTitle,
      projectId,
      content: prompt,
      conversationId: conversation.id,
    }, req.user)
    const assistantSession = await createStreamingAssistantSession({
      title: sessionTitle,
      projectId,
      conversationId: conversation.id,
    }, req.user)

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders?.()

    res.write(`data: ${JSON.stringify({
      event: 'message',
      data: {
        userSessionId: userSession.id,
        assistantSessionId: assistantSession.sessionId,
        assistantMessageId: assistantSession.messageId,
        conversationId: conversation.id,
      }
    })}\n\n`)

    const content = `【用户指令 - 最高优先级，请以此为准】\n${prompt}\n\n【项目背景 - 操作文件时使用】\n项目标题: ${projectTitle}\n项目描述: ${desc}\n项目Path: ${dirPath}\n组件库: vant\nCSS: tailwindcss\n\n注: 所有文件操作必须使用上述项目Path，path 参数用相对路径；看项目效果只需提示用户刷新页面`
    startChatStream({
      messageId: assistantSession.messageId,
      sessionId: assistantSession.sessionId,
      run: (send, signal) => runAiChat(content, send, context, dirPath, imageUrls, prompt, {
        signal,
        userSessionId: userSession.id,
        assistantSessionId: assistantSession.sessionId,
      }),
      onSettled: async (usage, status) => {
        const result = await settleConversationUsage({
          conversationId: conversation.id,
          projectId,
          assistantSessionId: assistantSession.sessionId,
          usage,
          status,
        })
        const stats = result.conversation
        if (status !== 'completed') contextMap.delete(contextKey)
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
          conversation: stats ? {
            promptTokens: Number(stats.prompt_tokens) || 0,
            completionTokens: Number(stats.completion_tokens) || 0,
            totalTokens: Number(stats.total_tokens) || 0,
            currentContextTokens: Number(stats.current_context_tokens) || 0,
            contextLimit: Number(stats.context_limit) || 0,
          } : null,
        }
      },
      onComplete: async (_content, _usage, { settlementFailed } = {}) => {
        if (!sessionTitle) return
        if (settlementFailed) contextMap.delete(contextKey)
        else contextMap.set(contextKey, context.slice(1))
      },
    })
    await subscribeChatStream({
      messageId: assistantSession.messageId,
      account: req.user.account,
      offset: 0,
      res,
    })
  } catch (err) {
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ event: 'error', data: err.message })}\n\n`)
      return res.end()
    }
    res.cc(1, err.message);
  }
})

/** 主动终止当前 AI 生成。 */
app.post('/chat/messages/:messageId/cancel', authJWT, async (req, res) => {
  const { messageId } = req.params;
  if (!messageId) return res.cc(1, 'messageId 不能为空');
  try {
    const result = await cancelChatStream({ messageId, account: req.user.account });
    res.cc(0, result.cancelled ? '正在终止生成' : '生成任务已结束', result);
  } catch (err) {
    res.cc(1, err.message);
  }
});

app.get('/chat/messages/:messageId/stream', authJWT, async (req, res) => {
  const { messageId } = req.params
  const { offset = 0 } = req.query
  if (!messageId) return res.cc(1, 'messageId 不能为空')

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()

  try {
    await subscribeChatStream({
      messageId,
      account: req.user.account,
      offset,
      res,
    })
  } catch (err) {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ event: 'error', data: err.message })}\n\n`)
      res.end()
    }
  }
})

/** 添加日志 */
app.post('/log/add',authJWT, async (req, res) => {
  const { content, projectId, title } = req.body;
  if(!content) return res.cc(1, '日志内容不能为空');
  if(!projectId) return res.cc(1, '项目id不能为空');
  if(!title) return res.cc(1, '会话标题不能为空');
  try {
    const result = await addLog(content, projectId, title, req.user);
    res.cc(0, '添加成功', result);
  } catch (err) {
    res.cc(1, err.message);
  }
})

/** 获取日志列表，title 可选，传入时按会话过滤 */
app.get('/log/list',authJWT, async (req, res) => {
  const { projectId, title } = req.query;
  if(!projectId) return res.cc(1, '项目id不能为空');
  try {
    const result = await getLogList(projectId, title ? title : undefined, req.user);
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
  const { dir,projectId} = req.body;
  if(!dir) return res.cc(1, '项目根目录不能为空');
  if(!projectId) return res.cc(1, '项目id不能为空');

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
    const {link,deploymentId} = await buildCommand(dir,send);
    const oldDeploymentId = (await getProjectInfo(projectId,req.user)).cloudflare_id;
    const {id} = await addSnapshot(projectId,'构建'+Math.random().toString(36).substring(2, 15),dir,'',req.user);
    await buildProject(projectId,link,id,deploymentId);
    await markUserActive(req.user.id);
    if(oldDeploymentId) await deleteOnlineVersion(dir,oldDeploymentId);
    if (clientClosed) return
    res.end()
  } catch (err) {
    if (clientClosed) return
    send({ event: 'error', data: '错误信息: \n' + err.message })
    res.end()
    res.cc(1, err.message);
  }
})

/** 获取当前线上版本 */
app.get('/project/version',authJWT,async(req,res)=>{
  const { projectId } = req.query;
  if(!projectId) return res.cc(1, '项目id不能为空');
  try {
    const result = await getCurrentVision(projectId);
    res.cc(0, '获取成功', result);
  } catch (err) {
    res.cc(1, err.message);
  }
})

/** 获取最新的模板版本 */
app.get('/temp/latest',async(req,res)=>{
  const { type } = req.query;
  if(!type) return res.cc(1, '类型不能为空');
  try {
    const result = await getLatestTemplateVersion(type);
    res.cc(0, '获取成功', result);
  } catch (err) {
    res.cc(1, err.message);
  }
})

/** 获取项目当前的模板版本 */
app.get('/temp/current',authJWT,async(req,res)=>{
  const { projectId } = req.query;
  if(!projectId) return res.cc(1, '项目id不能为空');
  try {
    const result = await getCurrentProjectTemplateVersion(projectId);
    res.cc(0, '获取成功', result);
  } catch (err) {
    res.cc(1, err.message);
  }
})

/** 更新项目模板版本 */
app.post('/temp/update',authJWT,async(req,res)=>{
  const { projectId,upToVersion = null } = req.body;
  if(!projectId) return res.cc(1, '项目id不能为空');
  try {
    const result = await updateProjectTemplateVersion(projectId,upToVersion,req.user);
    await markUserActive(req.user.id);
    res.cc(0, '更新成功', result);
  } catch (err) {
    res.cc(1, err.message);
  }
})

/** 获取项目模板版本列表 */
app.get('/temp/list',async(req,res)=>{
  const { type } = req.query;
  if(!type) return res.cc(1, '类型不能为空');
  try {
    const result = await getAllTemplateVersionFiles(type);
    res.cc(0, '获取成功', result);
  } catch (err) {
    res.cc(1, err.message);
  }
})

export default app;
