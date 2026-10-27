/** 仅保留运行时路径和网络配置，不继承业务凭据。 */
export function buildEnvironment(source = process.env) {
  const allowed = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TMP|TEMP|TMPDIR|PNPM_HOME|LANG|LC_ALL|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|SSL_CERT_FILE|NODE_EXTRA_CA_CERTS)$/i;
  const env = Object.fromEntries(Object.entries(source).filter(([key]) => allowed.test(key)));
  const configured = Number.parseInt(source.BUILD_MAX_OLD_SPACE_SIZE || '', 10);
  const heap = Number.isInteger(configured) && configured >= 128 && configured <= 4096 ? configured : 512;
  env.NODE_OPTIONS = `--max-old-space-size=${heap}`;
  // 由服务端的依赖指纹判断是否需要安装，避免 pnpm run 隐式触发安装。
  env.pnpm_config_verify_deps_before_run = 'false';
  return env;
}
