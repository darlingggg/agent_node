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

function createOutputCollector(maxBytes = COMMAND_MAX_BUFFER) {
  const chunks = [];
  let size = 0;
  let omittedBytes = 0;
  return {
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
    read(encoding) {
      if (size === 0) return '';
      const output = new TextDecoder(encoding).decode(Buffer.concat(chunks, size));
      return omittedBytes ? `...(${omittedBytes} bytes omitted)\n${output}` : output;
    },
  };
}

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

/** 所有安装、构建、上传命令共用资源保护，而不是按依赖名称特殊处理。 */
export async function runProtectedCommand(file, args, projectPath, timeout, options = {}) {
  const startedAt = Date.now();
  const policy = resourcePolicy();
  const env = options.env || buildEnvironment();
  let result;
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
    const launch = systemdLaunch(file, args, projectPath, timeout, env, policy, process.getuid(), managerKeys);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });
    const resources = { unit: launch.unit, memoryLimitMb: policy.memoryMb, swapLimitMb: policy.swapMb,
      cpuPercent: policy.cpuPercent, availableBytes: initial };
    let pressure = false;
    let pressureSamples = 0;
    let sampling = false;
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

export function runWrangler(args, projectPath, timeout = CLOUDFLARE_QUERY_TIMEOUT_MS, options = {}) {
  const env = { ...buildEnvironment(), CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID };
  return runProtectedCommand(process.execPath, [WRANGLER_CLI_PATH, ...args], projectPath, timeout, { ...options, env });
}
