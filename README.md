# agentNode

AI Agent 的后端服务，为 AI 编程和游戏构建工作台提供账户、项目、文件、对话、图像生成、版本快照和部署能力。用户通过前端提出需求，后端调用模型及文件工具修改项目，并保存消息、任务进度和用量统计。

配套前端是同级目录中的 `gameAgent`。两个项目分别安装依赖、运行和部署：前端负责编辑与浏览器预览，后端负责业务数据、服务端文件、AI 调用和发布。

## 主要功能

| 模块 | 能力 |
| --- | --- |
| 账户与权限 | 账号注册登录、Access / Refresh Token、QQ / 微信登录及绑定、用户资料、管理员权限 |
| 项目管理 | 工具、2D 游戏、3D 游戏三类项目，模板复制、项目资料、软删除和用量汇总 |
| AI 对话 | SSE 流式回复、工具调用、停止生成、消息流重连、历史消息和上下文压缩 |
| 模型管理 | 同步服务商目录、失效模型禁用、默认模型设置、按会话选择模型与推理强度 |
| 文件与素材 | 项目文件读写、删除、patch、素材导入、COS 临时上传凭证与素材访问 |
| 图像生成 | 文生图、参考图生成、异步任务进度、生成图片转 WebP 并保存到 COS |
| 版本与日志 | 项目快照、恢复、模板版本升级、会话日志和构建进度 |
| 构建部署 | 安装项目依赖、构建产物、通过 Wrangler 发布到 Cloudflare Pages |
| 管理控制台接口 | 用户、项目、素材、生图任务、模型目录、AI 用量与存储统计 |

## 技术栈与运行环境

- Node.js ES Modules、Express 5、MySQL / mysql2。
- OpenAI SDK 对接兼容接口，`js-tiktoken` 统计上下文 Token。
- JWT、bcryptjs 实现账户认证；腾讯 COS / STS 保存素材和下发上传凭证。
- Sharp 处理生成图片；pnpm、Wrangler 执行项目构建和发布。

后端要求 Node.js 22+。与前端一起开发时，可统一使用 Node.js 22.12+；包管理器按 `package.json` 使用 pnpm 11.5.2。构建服务的运行环境需要能够执行 pnpm，并访问依赖仓库、AI 服务、COS 和 Cloudflare。

## 项目结构

```text
agentNode/
├── Mysql/
│   ├── index.js                 # 数据库连接池
│   ├── sql.sql                  # 表结构及历史变更记录
│   ├── ai-models.sql            # 模型目录和会话配置增量 SQL
│   └── migrate-ai-models.js      # 可重复执行的模型迁移脚本
├── node/
│   ├── index.js                 # Express 入口、路由和定时任务注册
│   ├── routes/                  # front 前台路由、admin 管理端路由
│   ├── middleware/              # JWT、管理权限和统一响应
│   ├── auth/                    # 账户、第三方登录、OAuth 会话与回调页
│   ├── admin/                   # 管理端查询和业务处理
│   ├── session/                 # 会话、消息记录及 Token 结算
│   ├── openai/                  # 聊天、上下文、提示词、工具及媒体模型
│   ├── models/                  # 模型目录、默认值、同步和每日任务
│   ├── file/                    # 项目文件与公共素材处理
│   ├── cos/                     # 对象存储及存储统计
│   ├── exec/                    # 构建队列、进程执行及部署
│   ├── project.js               # 项目创建、资料及模板升级
│   ├── chatStream.js            # 后端托管消息流、保存和订阅
│   ├── imageGeneration.js       # 生图任务、状态保存和事件订阅
│   ├── snapshot.js              # 版本快照与恢复
│   ├── log.js                   # 项目会话日志
│   └── utils/                   # 时间、分页、字段转换和缓存等工具
├── tests/                      # 模型、对话和数据库集成测试
├── key.js                      # 本地服务配置，不纳入 Git
└── package.json
```

多文件模块按功能分组，例如 `openai/context`、`openai/tools`、`exec/build` 和 `exec/deploy`。单文件模块直接使用 `.js` 文件；多文件模块通过 `index.js` 提供公共导出。仓库统一使用 LF 换行。

## 配置

### 数据库与文件目录

在 [Mysql/index.js](Mysql/index.js) 中配置 MySQL 地址、端口、账号、密码和数据库名。当前数据库名为 `gameAgent`，时间戳按 UTC 读写，业务日报按北京时间统计。

在 [node/project.js](node/project.js) 中配置项目根目录。当前值为 `/www/wwwroot/ai_agent`，根目录下需准备：

```text
项目根目录/
├── projectTemp/                # 工具模板
├── gameTemp2d/                 # 2D 游戏模板
├── gameTemp3d/                 # 3D 游戏模板
└── copyPro/                    # 创建后的用户项目
```

每个模板需要包含可运行的项目文件，以及 `agent_base/version.json`、`agent_base/versions/` 和相应的提示词资源。配套前端的 `src/a_template/` 提供这些模板的源文件，服务端实际复制的是上述目录。

`node/file/project/path-utils.js` 还定义了未指定目录时的 `PROJECT_TEMP_ROOT`。本地开发或迁移服务器时，需要同时核对该路径和数据库中项目的 `dir_path`。

### AI、对象存储与第三方服务

在仓库根目录创建 `key.js`，导出以下配置名称。使用各自服务商的实际配置；该文件已经被 `.gitignore` 排除。

| 服务 | `key.js` 导出项 |
| --- | --- |
| 对话模型与模型目录 | `baseURL`、`key` |
| 视觉分析 | `imageBaseURL`、`imageKey` |
| 图像生成 | `IMAGE_GENERATION_BASE_URL`、`IMAGE_GENERATION_KEY` |
| 腾讯 COS / STS | `TENCENT_SECRET_ID`、`TENCENT_SECRET_KEY` |
| Cloudflare Pages | `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_API_TOKEN` |
| QQ 登录 | `QQ_APP_ID`、`QQ_APP_KEY`、`QQ_REDIRECT_URI` |
| 微信登录 | `WECHAT_APP_ID`、`WECHAT_APP_SECRET`、`WECHAT_OAUTH_SCOPE`、`WECHAT_VERIFY_TOKEN` |

模型客户端在模块加载时初始化，`key.js` 需要提供完整的导出项。COS 桶名、区域在 `node/cos/index.js` 的 `COS_CONFIG` 中配置；Cloudflare Pages 项目名在 `node/exec/deploy/cloudflare.js` 中配置。

QQ / 微信回调地址和回跳域名需要与部署域名、第三方平台登记值一致。前端来源白名单分别位于 `node/index.js` 和 `node/routes/front/auth.js`，更换访问域名时需要一起调整。

### 环境变量

| 变量 | 用途 / 默认值 |
| --- | --- |
| `PORT` | HTTP 端口；直接启动入口时默认 `3000` |
| `JWT_SECRET` | JWT 签名密钥；部署环境应显式设置 |
| `AI_CHAT_MODEL` | 首次模型迁移时优先选择的默认模型；之后以后台设置为准 |
| `AI_CONTEXT_LIMIT_TOKENS` | 模型未提供上下文上限时的回退值，默认 `1000000` |
| `AI_CONTEXT_COMPRESSION_RATIO` | 上下文压缩阈值比例，默认 `0.8` |
| `AI_SUMMARY_MAX_TOKENS` | 压缩摘要最大输出 Token，默认 `1600` |
| `AI_RECENT_TURNS_TO_KEEP` | 压缩时保留的最近用户轮次，默认 `3` |
| `BUILD_MAX_OLD_SPACE_SIZE` | 构建子进程的默认内存上限，默认 `512` MB |
| `AI_MODELS_DB_TEST` | 设置为 `1` 时启用数据库集成测试 |

环境变量通过终端或进程管理器注入。服务不会自动读取 `.env`；若采用该文件，可使用 `node --env-file=.env node/index.js` 启动。

## 本地启动

1. 安装依赖。

   ```sh
   pnpm install
   ```

2. 准备 MySQL、项目模板目录和 `key.js`，完成上述配置。

3. 按当前数据库状态初始化表结构。`Mysql/sql.sql` 是历史建表和升级记录，包含重复示例、说明文字及一次性 `ALTER`，需要选取对应语句执行，不能作为可重复运行的完整初始化脚本直接导入。

4. 基础表已存在后，执行模型增量迁移和首次同步。

   ```sh
   pnpm db:migrate:models
   pnpm models:sync
   ```

5. 启动开发服务。

   ```sh
   pnpm dev
   ```

默认访问 `http://localhost:3000`，`GET /` 返回服务运行状态。配套前端的开发 API 地址也默认指向该端口。

`pnpm start` 使用现有 POSIX 脚本，将端口设为 `5000`。Windows PowerShell 可直接执行入口，并按需要设置端口：

```powershell
$env:PORT = '3000'
node node/index.js
```

首次创建管理账号时，在数据库中将指定用户的 `role` 设为 `super`。角色包括 `super`、`admin`、`normal`、`disabled`；`super` 和 `admin` 可访问管理端，部分操作仅允许 `super`。

## 数据与请求流程

`users` 和 `refresh_tokens` 保存账户及认证状态；`projects` 保存项目资料、实际文件目录和累计用量。`conversations` 是稳定的会话记录，`sessions` 保存每条消息，`messages` 保存关联的完整回复。项目文件保存在服务器目录，素材和生成图片保存在 COS。

AI 对话由后端托管：创建用户消息及助手消息后启动模型调用，将文本和工具事件通过 SSE 发送给前端，持续保存回复，结束时结算会话、项目和每日 Token。前端断开订阅时可通过消息 ID 重连；上下文过长时生成摘要并保留最近轮次。

生图任务单独保存到 `ai_generated_images`。模型返回的图片完成处理并入库 COS 后，前端通过任务查询或 SSE 获取结果。`snapshots`、`log` 保存版本与日志；`ai_usage_daily` 和存储统计表服务于管理控制台。

## 接口分组

后端路由本身不带 `/api` 前缀；生产环境的 `/api` 由反向代理转发。

| 分组 | 代表路径 |
| --- | --- |
| 账户与 OAuth | `/register`、`/login`、`/auth/*`、`/user/profile` |
| 项目 | `/project/create`、`/project/list`、`/project/update`、`/project/usage` |
| 文件与素材 | `/files`、`/file/*`、`/cos/credential` |
| 对话与消息 | `/chat/stream`、`/chat/messages/:messageId/stream`、`/chat/messages/:messageId/cancel` |
| 会话管理 | `/conversation/*`、`/session/*` |
| 图像生成 | `/agent/image-gen`、`/agent/image-gen/tasks/*` |
| 版本与部署 | `/snapshot/*`、`/temp/*`、`/project/build`、`/project/version` |
| 模型 | `/models`、`/admin/models`、`/admin/models/sync`、`/admin/models/default`、`/admin/models/availability` |
| 管理控制台 | `/admin/dashboard/*`、`/admin/users/*`、`/admin/projects/*`、`/admin/assets`、`/admin/image-generations/*` |

普通 JSON 响应采用 `{ status, message, data }`，成功 `status` 为 `0`，响应字段由中间件转为 camelCase。SSE 接口使用独立事件格式。需要登录的接口使用 `Authorization: Bearer <Access Token>`；管理端统一经过 JWT 和管理权限校验。

管理员可通过 `PATCH /admin/models/availability`，传入 `{ "model": "模型标识", "enabled": false }` 禁用模型，传 `true` 重新启用。人工禁用独立保存，每日目录同步不会覆盖；服务商已下线的模型不能手动启用。禁用默认模型后会自动选择其他可用模型，全部禁用时清空默认值。前台 `/models` 仅返回可用模型，admin 操作完成后立即刷新，并每 15 秒读取模型目录以反映外部修改。

上线此变更前运行 `pnpm db:migrate:models`，为已有模型目录补齐 `manual_disabled` 和 `provider_available`。运营总览的累计 Token 来自所有项目的累计用量（包括归档项目），与 7 / 30 天的期间用量分开展示；统计从系统首次记录用量开始。

当前部分基础文件复制、读取、写入和删除接口没有 JWT 中间件。对外部署时，应限制这些接口的访问范围或补齐鉴权；完整接口参数及权限以 `node/routes/` 中的实现为准。

## 模型与后台任务

- 管理端可手动同步模型并设置默认模型；新会话未指定模型时使用该默认值，已有会话沿用保存的选择。
- 同步完整获取服务商列表后在事务内更新目录，未返回的模型禁用，重新出现的模型启用。请求或写入失败保留原目录；成功返回空列表时全部禁用。
- 模型和实际推理强度同时记录到会话、消息中。模型未提供有效 `effort` 时不发送强度配置。
- 服务注册每日北京时间 `04:00` 的模型同步任务；COS 统计在启动约 30 秒后同步，之后每小时更新。定时任务依赖后端进程持续运行。

## 开发与验证

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | 使用 nodemon 监听后端及数据库模块 |
| `pnpm start` | 使用现有 POSIX 启动脚本运行服务，端口 `5000` |
| `pnpm test` | 运行模型配置、工具循环、上下文压缩和调度测试 |
| `pnpm db:migrate:models` | 可重复运行的模型与会话字段迁移 |
| `pnpm models:sync` | 从服务商获取并更新模型目录 |

数据库集成测试使用连接独享的 MySQL 临时表，覆盖同步回滚、失效恢复、默认模型、接口权限和会话配置保存。需要先准备数据库及迁移，再显式启用：

```powershell
$env:AI_MODELS_DB_TEST = '1'
pnpm test
```

## 部署要点

部署时需要同时配置数据库、项目目录、外部服务和访问域名。反向代理将前端 `/api/` 转到后端实际端口并移除该前缀；聊天、生图任务、OAuth 和构建进度使用 SSE，需要关闭响应缓冲并允许较长连接。

前端工作台的 WebContainer 预览运行在浏览器中；“构建部署”则由本服务在项目目录执行安装、构建和 Cloudflare Pages 发布，两者使用不同的运行环境。部署后的后端进程需要持续运行，以提供接口、托管生成任务和执行定时同步。
