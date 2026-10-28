/**
 * 从后端环境挑选命令运行所需的路径、临时目录、语言和网络配置，返回新的环境对象。
 * 安装/构建不继承业务凭据；只有 runWrangler 再额外加入 Cloudflare 凭据。
 * 同时限制 Node 堆及原生工具线程数；整个进程组的内存/CPU 限制由 resource-policy 负责。
 */
export function buildEnvironment(source = process.env) {
  const allowed = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TMP|TEMP|TMPDIR|PNPM_HOME|LANG|LC_ALL|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|SSL_CERT_FILE|NODE_EXTRA_CA_CERTS)$/i;
  const env = Object.fromEntries(Object.entries(source).filter(([key]) => allowed.test(key)));
  const configured = Number.parseInt(source.BUILD_MAX_OLD_SPACE_SIZE || '', 10);
  const heap = Number.isInteger(configured) && configured >= 128 && configured <= 4096 ? configured : 512;
  env.NODE_OPTIONS = `--max-old-space-size=${heap}`;
  // 由服务端的依赖指纹判断是否需要安装，避免 pnpm run 隐式触发安装。
  env.pnpm_config_verify_deps_before_run = 'false';
  // 限制原生工具的线程数；系统级配额仍负责整个进程组的 CPU 上限。
  env.RAYON_NUM_THREADS = '1';
  env.GOMAXPROCS = '1';
  return env;
}
