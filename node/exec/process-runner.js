import { spawn } from 'child_process';
import { createRequire } from 'module';
import { CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN } from '../../key.js';
import { buildEnvironment } from './build/environment.js';
import { resourcePolicy, readAvailableMemory, systemdLaunch, sampleBuildResources,
  recordBuildCommand, bytesInMb, systemdReport, memoryPressure, systemdManagerEnvironment } from './build/resource-policy.js';

const require = createRequire(import.meta.url);
const WRANGLER_CLI_PATH = require.resolve('wrangler');
const COMMAND_MAX_BUFFER = 8 * 1024 * 1024;

export const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
export const BUILD_TIMEOUT_MS = 5 * 60 * 1000;
export const DEPLOY_TIMEOUT_MS = 5 * 60 * 1000;
export const CLOUDFLARE_QUERY_TIMEOUT_MS = 60 * 1000;

/** 保存最近 maxBytes 字节输出，丢弃较早内容，避免安装日志无限占用后端内存。 */
function createOutputCollector(maxBytes = COMMAND_MAX_BUFFER) {
  const chunks = [];
  let size = 0;
  let omittedBytes = 0;
  return {
    /** 接收 stdout/stderr 数据块；超过上限时从最早的块开始裁剪。 */
    push(chunk) {
      const buffer = Buffer.from(chunk);
      chunks.push(buffer);
      size += buffer.length;
      while (size > maxBytes && chunks.length) {
        const overflow = size - maxBytes;
        const first = chunks[0];
        if (first.length <= overflow) {
          chunks.shift();
          size -= first.length;
          omittedBytes += first.length;
        } else {
          chunks[0] = first.subarray(overflow);
          size -= overflow;
          omittedBytes += overflow;
        }
      }
    },
    /** 按编码合并保留的字节，并提示省略量；命令关闭后用于组装返回结果。 */
    read(encoding) {
      if (size === 0) return '';
      const output = new TextDecoder(encoding).decode(Buffer.concat(chunks, size));
      return omittedBytes ? `...(${omittedBytes} bytes omitted)\n${output}` : output;
    },
  };
}

/** 终止命令及其派生进程：Windows 使用 taskkill，类 Unix 优先向独立进程组发 SIGTERM。 */
function terminateProcessTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.on('error', () => {});
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

/**
 * 最底层命令执行器：在 projectPath 启动 file/args，收集输出并等待 close 后返回命令结果。
 * options 可指定 env、timeout、AbortSignal、输出编码和 onStop（清理 systemd 单元）。
 * 命令失败/超时/取消以 { success: false, code, stdout, stderr, ... } 返回，由 pipeline.runCommand 转成异常。
 * 不会在超时触发时立即返回，需等待子进程关闭及 onStop 完成，避免过早释放构建槽。
 */
export function execCommand(file, args, projectPath, options = {}) {
  return new Promise((resolve) => {
    const { encoding = 'utf-8', timeout = BUILD_TIMEOUT_MS, signal, env = buildEnvironment() } = options;
    if (signal?.aborted) {
      resolve({ success: false, code: 'ABORT_ERR', timedOut: false, stdout: '', stderr: '任务已取消' });
      return;
    }
    const stdout = createOutputCollector();
    const stderr = createOutputCollector();
    let timedOut = false;
    let spawnError = null;
    let forceKillTimer = null;
    let stopping = false;
    let stopPromise = Promise.resolve();
    const child = spawn(file, args, {
      cwd: projectPath,
      env,
      detached: process.platform !== 'win32',
      windowsHide: true,
      windowsVerbatimArguments: options.windowsVerbatimArguments,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout?.on('data', (chunk) => stdout.push(chunk));
    child.stderr?.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      spawnError = error;
    });

    // 超时与外部取消共用幂等停止流程；Linux 先温和终止，5 秒后仍未退出则强杀进程组。
    const stop = () => {
      if (stopping) return;
      stopping = true;
      if (options.onStop) stopPromise = Promise.resolve().then(options.onStop).catch(() => {});
      terminateProcessTree(child);
      if (process.platform !== 'win32' && child.pid) {
        forceKillTimer = setTimeout(() => {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            // The process group already exited after SIGTERM.
          }
        }, 5000);
        forceKillTimer.unref?.();
      }
    };
    const onAbort = () => stop();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeout);
    timer.unref?.();

    child.on('close', async (code, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      await stopPromise;
      const stderrText = stderr.read(encoding);
      resolve({
        success: !spawnError && !timedOut && !signal?.aborted && code === 0,
        code: signal?.aborted ? 'ABORT_ERR' : timedOut ? 'ETIMEDOUT' : spawnError?.code || code,
        signal: exitSignal,
        timedOut,
        stdout: stdout.read(encoding),
        stderr: spawnError ? `${stderrText}\n${spawnError.message}`.trim() : stderrText,
      });
    });
  });
}

/**
 * 安装/构建/上传共用的资源保护入口，包装 execCommand，返回同样的命令结果并附资源统计。
 * Linux 默认经 systemd 用户服务限制整组进程的内存、Swap、CPU，并定时检查服务器内存余量。
 * 保护未启用时直接运行；启用但环境未就绪/内存不足时返回失败，不绕过保护继续执行。
 * stage 与 auditDirectory 由 pipeline 传入，用于记录这次命令的阶段、结果及诊断日志。
 */
export async function runProtectedCommand(file, args, projectPath, timeout, options = {}) {
  const startedAt = Date.now();
  const policy = resourcePolicy();
  const env = options.env || buildEnvironment();
  let result;
  // 各返回分支统一记录命令诊断，包括命令尚未启动就被资源检查拒绝的情况。
  const finish = async (value) => {
    await recordBuildCommand(options.auditDirectory || projectPath, options.stage || args[0], value, startedAt);
    return value;
  };
  if (!policy.enabled) {
    result = await execCommand(file, args, projectPath, { ...options, timeout, env });
  } else {
    let initial;
    try { initial = await readAvailableMemory(); }
    catch (error) {
      return finish({ success: false, code: 'BUILD_RESOURCE_UNAVAILABLE', stdout: '', stderr: error.message });
    }
    if (initial < policy.startAvailableMb * 1024 * 1024) {
      return finish({ success: false, code: 'BUILD_RESOURCE_PRESSURE', stdout: '',
        stderr: `当前可用内存 ${bytesInMb(initial)}MB，暂不足以启动构建，请稍后手动重试` });
    }
    // 只使用管理器环境的键名，不记录其值；业务凭据不会进入生成项目。
    const manager = await execCommand('systemctl', ['--user', 'show-environment'], projectPath,
      { timeout: 5000, signal: options.signal, env: systemdManagerEnvironment(env) });
    if (!manager.success) return finish({ ...manager, code: manager.code === 'ABORT_ERR' ? manager.code : 'BUILD_RESOURCE_UNAVAILABLE',
      stdout: '', stderr: '构建资源隔离未就绪，请先执行 install-build-guard.sh。\n' + manager.stderr });
    const managerKeys = manager.stdout.split('\n').map((line) => /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1]).filter(Boolean);
    // systemdLaunch 只组装启动描述；真正启动仍由下面的 execCommand 执行。
    const launch = systemdLaunch(file, args, projectPath, timeout, env, policy, process.getuid(), managerKeys);
    const controller = new AbortController();
    // 合并 pipeline 的总期限取消和本层的内存保护取消，共同停止同一个 systemd 服务。
    const onAbort = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });
    const resources = { unit: launch.unit, memoryLimitMb: policy.memoryMb, swapLimitMb: policy.swapMb,
      cpuPercent: policy.cpuPercent, availableBytes: initial };
    let pressure = false;
    let pressureSamples = 0;
    let sampling = false;
    // 每秒采样；sampling 防止上次磁盘读取未结束时再次启动采样。
    const timer = setInterval(async () => {
      if (sampling) return;
      sampling = true;
      try {
        await sampleBuildResources(launch, resources);
        const state = memoryPressure(resources.availableBytes, policy.reserveMb, pressureSamples);
        pressureSamples = state.samples;
        if (state.stop) {
          pressure = true;
          controller.abort();
        }
      } finally { sampling = false; }
    }, 1000);
    timer.unref?.();
    try {
      result = await execCommand(launch.file, launch.args, projectPath, {
        timeout, signal: controller.signal, env: launch.env,
        onStop: async () => {
          // 结束 systemd-run 客户端不等于结束实际构建，所以还需停止其完整服务控制组。
          const stopped = await execCommand('systemctl', ['--user', 'stop', launch.unit], projectPath,
            { timeout: 10_000, env: launch.env });
          if (!stopped.success) await execCommand('systemctl',
            ['--user', 'kill', '--kill-whom=all', '--signal=SIGKILL', launch.unit], projectPath,
            { timeout: 5000, env: launch.env });
        },
      });
      const report = systemdReport(result.stderr);
      resources.systemdResult = report.result;
      resources.peakMemoryBytes = Math.max(resources.peakMemoryBytes || 0, report.memoryBytes);
      result.resources = resources;
      // 将系统级退出原因映射成稳定错误码，便于区分服务器余量不足、构建超限和超时。
      if (pressure) {
        result.code = 'BUILD_RESOURCE_PRESSURE';
        result.stderr = `服务器内存余量过低，已停止本次构建以保护业务服务。\n${result.stderr}`;
      } else if (report.result === 'oom-kill') {
        result.code = 'BUILD_MEMORY_LIMIT';
        result.stderr = `本次构建达到内存上限（${policy.memoryMb}MB），已单独终止；可减少依赖或调整构建预算后重试。\n${result.stderr}`;
      } else if (report.result === 'timeout') {
        result.code = 'ETIMEDOUT';
        result.timedOut = true;
      } else if (!result.success && /Failed to connect to bus|No medium found|Permission denied/i.test(result.stderr)) {
        result.code = 'BUILD_RESOURCE_UNAVAILABLE';
        result.stderr = '构建资源隔离未就绪，请先执行部署目录中的 install-build-guard.sh。\n' + result.stderr;
      } else if (!result.success && !result.stderr) {
        result.stderr = `构建子进程退出（${result.signal || result.code}），可能达到资源限制或超时，请查看构建日志`;
      }
    } finally {
      clearInterval(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }
  return finish(result);
}

/** 按平台启动 pnpm 并复用资源保护；Windows 通过 cmd 调用命令脚本，其他平台直接启动。 */
export function runPnpm(args, projectPath, timeout, options = {}) {
  if (process.platform === 'win32') {
    return runProtectedCommand(
      process.env.ComSpec || 'cmd.exe',
      ['/d', '/s', '/c', ['pnpm', ...args.map((arg) => `"${arg}"`)].join(' ')],
      projectPath,
      timeout,
      { ...options, windowsVerbatimArguments: true },
    );
  }
  return runProtectedCommand('pnpm', args, projectPath, timeout, options);
}

/** 用当前 Node 执行已安装的 Wrangler CLI；只在部署命令环境中补入 Cloudflare 凭据。 */
export function runWrangler(args, projectPath, timeout = CLOUDFLARE_QUERY_TIMEOUT_MS, options = {}) {
  const env = { ...buildEnvironment(), CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID };
  return runProtectedCommand(process.execPath, [WRANGLER_CLI_PATH, ...args], projectPath, timeout, { ...options, env });
}
