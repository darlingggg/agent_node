# WebContainer 兼容预览与构建调度

## 请求链路

工作台先尝试 WebContainer。初始化 20 秒、依赖安装 60 秒、开发服务启动 20 秒、整个本地启动 90 秒均有超时；失败后自动使用兼容预览，同一浏览器会话按账号和项目记住该模式。

兼容预览通过 `POST /project/preview` 提交，仅传 `projectId`。JWT 和项目所属账号校验通过后，后端从数据库读取目录，忽略客户端传来的目录。`GET /project/preview?projectId=...` 返回 `desiredRevision`、`active`、`pending`、`lastReady` 和 `latest`。前端有任务时每 2 秒查询，完成、失败或请求错误后停止，不无限重试。

只有兼容模式会提交服务端预览。AI 文件工具仅标记文件变化，一轮回复正常结束或取消后更新；手动保存、素材变更、快照恢复、模板升级停顿 2 秒后更新。AI 正在生成时不因单个文件更新而构建。

## 文件与缓存

`project-input.js` 使用流式哈希计算源码指纹，复制到独立输入目录，并比较复制前、复制后和副本的指纹。不稳定时最多重试 3 次。构建期间继续编辑不会改变该任务输入，正式快照也从该副本读取，文件路径仍保存为原项目路径。

`node_modules`、构建产物、Git、编辑器配置、模板版本历史不进入输入副本。Linux 默认缓存位于服务用户的 `~/.cache/agent-project-builds/<projectId>/`，其他平台使用系统临时目录；可用 `BUILD_CACHE_ROOT` 覆盖：

```text
inputs/<uuid>/             不可变任务输入，完成、替换或超时后删除
work/                      每项目独立构建目录，保留 node_modules
dependencies.json          依赖声明、锁文件、安装配置、补丁及运行时的指纹
artifacts/<revision>/      成功构建产物，每项目保留最近两份
upload/dist/               本次上传副本
```

已成功发布相同源码时直接复用链接；依赖未变时跳过安装；上传失败后重试优先复用本地构建产物，甚至无需重新准备依赖。pnpm 的自动安装检查由服务端指纹接管，避免 `pnpm run build` 隐式启动第二次安装。

服务启动时清理遗留输入副本。依赖目录保留以减少冷启动，项目很多时需要监测磁盘容量；停止服务后可以删除对应项目的本地缓存，后续按需重新安装和构建，已有 Cloudflare 链接不受影响。

## 调度与版本

`scheduler.js` 负责一个资源槽：正式发布和兼容预览串行执行，全局最多容纳 5 个项目，输入准备中的项目也计入容量。

- 相同内容重复请求复用任务。
- 排队任务收到新内容时替换输入，保留任务 ID、排队位置和原超时。
- 正在执行的预览继续完成，仅保留一个下一次目标；A1 执行时连续收到 A2、A3、A4，最终只执行 A1、A4。
- 内容恢复为执行中的版本时，删除多余待执行目标；恢复为已有成功版本时直接复用链接。
- 正式发布优先于尚未执行的预览，但不打断正在执行的任务。重复正式发布订阅同一任务，不自动追加正式发布。
- 预览排队最多 60 秒，开始执行后共用 300 秒期限。命令同时有 systemd 独立超时；超时终止整个进程组，退出后释放资源。
- 相同源码失败后，重新打开页面不自动重试；显式刷新传入 `force: true` 后可重试。

正在显示的成功版本与用户最新请求的版本独立返回。因此 A1 完成时不会抹掉 A4 的排队状态，旧画面会标注“较早版本”；新构建失败仍保留旧画面。

MySQL 的 `project_build_tasks` 保存任务、阶段、错误和成功链接。服务重启把遗留的 queued/running 任务标为失败，保留成功记录；不自动重跑中断的发布，防止重复产生正式版本。

## Cloudflare 与正式发布

复用 `gen-agent`，临时预览使用 `preview-p<projectId>` 分支，返回该次部署的独立链接。预览不改 `projects.link`、`cloudflare_id`、`current_vision`，不创建正式快照。

执行预览时先读取 Cloudflare 项目配置，确认目标分支不是生产分支；查询最多 10 秒，配置不可读或分支冲突时直接失败，避免误发布到生产入口。

上传从独立目录执行，避免读取生成项目的 Wrangler 配置和 Functions。当前范围是三个 Vite 静态模板，不支持 Pages Functions / `_worker.js`。预览上传副本附加 COOP/COEP/CORP 响应头和页面加载确认脚本；工作台核对 iframe 来源、窗口和 revision，15 秒未收到确认则提示访问失败，不误报加载成功。

构建子进程只继承运行时路径、临时目录、语言和代理等必要环境，不继承业务密钥；仅 Wrangler 阶段提供 Cloudflare 凭据。`BUILD_MAX_OLD_SPACE_SIZE` 默认 512 MB，仅限制 V8 堆，不是进程总内存的硬限制。

Linux 通过用户级 systemd/cgroup 对全部构建子进程设置总资源上限：默认 1 核 CPU、640MiB 内存、768MiB Swap，并记录阶段和资源采样。预览关闭压缩、源码映射和 gzip 统计，所有依赖仍完整打包；预览、发布和构建器版本使用不同的产物缓存键。部署前执行 `deploy/install-build-guard.sh`，详见 [覆盖部署说明](../deploy/README.md)。

正式发布沿用 `/project/build` SSE，增加 `task` 事件和完成结果中的 `taskId`。快照、发布记录、活跃时间保存及旧部署清理完成后，才保存任务完成状态并发送 `done`。前端断开只取消订阅，不终止后台任务。

## 部署与验证

1. 更新后端代码，执行 `pnpm db:migrate:builds`，该迁移可重复执行。
2. 根据磁盘情况设置可写的 `BUILD_CACHE_ROOT`，继续使用现有 Cloudflare Account ID / Token。
3. 后端按**单进程**运行；当前调度器不支持 PM2 cluster 或多个后端实例同时接单。进程管理器应在重启时终止旧进程的子进程，避免残留构建。
4. 更新前端构建。无需创建新的 Pages 项目，也无需增加预览域名。

常规验证：`pnpm test`。数据库集成测试设置 `BUILD_DB_TEST=1` 后运行 `node --test tests/build-preview-api.test.js`，使用连接独享的临时表。模板构建测试设置 `BUILD_TEMPLATE_TEST=1` 后运行 `node --test tests/build-templates.test.js`，要求同级前端模板已有依赖；执行真实 Vite 构建，Cloudflare 上传使用替身。

上线后仍需在目标网络验证真实 Cloudflare 上传、页面访问和 COEP 嵌入。缓存和任务合并减少重复工作，不保证冷启动秒开，也不增加服务器的实际构建并发能力。预览链接默认可被持有者访问。
