import { spawn } from 'child_process';
import { createRequire } from 'module';
import { CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN } from '../../key.js';
import { buildEnvironment } from './build/environment.js';

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

    child.on('close', (code, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (forceKillTimer) clearTimeout(forceKillTimer);
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

export function runPnpm(args, projectPath, timeout, options = {}) {
  if (process.platform === 'win32') {
    return execCommand(
      process.env.ComSpec || 'cmd.exe',
      ['/d', '/s', '/c', ['pnpm', ...args.map((arg) => `"${arg}"`)].join(' ')],
      projectPath,
      { ...options, timeout, windowsVerbatimArguments: true },
    );
  }
  return execCommand('pnpm', args, projectPath, { ...options, timeout });
}

export function runWrangler(args, projectPath, timeout = CLOUDFLARE_QUERY_TIMEOUT_MS, options = {}) {
  const env = { ...buildEnvironment(), CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID };
  return execCommand(process.execPath, [WRANGLER_CLI_PATH, ...args], projectPath, { ...options, timeout, env });
}
