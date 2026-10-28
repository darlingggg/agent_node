import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MIB = 1024 * 1024;
/** 解析有范围限制的整数配置；未配置或越界时使用默认值。 */
const integer = (value, fallback, min, max) => {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
};

/**
 * 读取构建进程组的资源预算：内存软/硬阈值、Swap、CPU 及服务器可用内存阈值。
 * 只在 Linux 且未显式 off 时启用 systemd 保护；返回策略，不启动进程。
 */
export function resourcePolicy(source = process.env) {
  const memoryMb = integer(source.BUILD_MEMORY_MB, 640, 256, 4096);
  return {
    enabled: process.platform === 'linux' && source.BUILD_RESOURCE_MODE !== 'off',
    memoryMb,
    memoryHighMb: integer(source.BUILD_MEMORY_HIGH_MB, Math.min(384, Math.floor(memoryMb * 0.8)), 128, memoryMb),
    swapMb: integer(source.BUILD_SWAP_MB, 768, 0, 4096),
    cpuPercent: integer(source.BUILD_CPU_PERCENT, 100, 10, 200),
    reserveMb: integer(source.BUILD_RESERVE_MB, 192, 64, 2048),
    startAvailableMb: integer(source.BUILD_START_AVAILABLE_MB, 384, 128, 4096),
  };
}

/** 可用内存连续 3 次低于保留量，或一次低于其一半时停止；恢复正常则清零连续计数。 */
export function memoryPressure(availableBytes, reserveMb, previousSamples = 0) {
  const samples = availableBytes < reserveMb * MIB ? previousSamples + 1 : 0;
  // 给 cgroup 的局部回收和 Swap 留出时间；严重不足时仍立即停止。
  return { samples, stop: availableBytes < reserveMb * MIB / 2 || samples >= 3 };
}

/** 从 Linux /proc/meminfo 文本读取 MemAvailable 并换算成字节；缺字段时抛错。 */
export function availableMemory(text) {
  const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(text);
  if (!match) throw new Error('无法读取系统可用内存，已停止启动构建');
  return Number(match[1]) * 1024;
}

/** 读取服务器当前可用内存（字节），用于命令启动前检查和运行中的余量保护。 */
export async function readAvailableMemory() {
  return availableMemory(await fs.readFile('/proc/meminfo', 'utf8'));
}

/** 为 systemd 用户管理器补齐运行目录和 D-Bus 地址，并固定诊断输出语言以便解析。 */
export function systemdManagerEnvironment(env, uid = process.getuid()) {
  const runtime = `/run/user/${uid}`;
  return { ...env, XDG_RUNTIME_DIR: runtime,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus`, LC_ALL: 'C', SYSTEMD_COLORS: '0' };
}

/**
 * 为真实命令组装 systemd-run 的 { file, args, env, unit, cgroup }，本函数不执行命令。
 * 临时用户服务限制完整进程组的 CPU/内存/Swap/时长；cgroup 路径供后续资源采样使用。
 * 按名称复制传入环境，不把凭据值放进命令行，并移除用户管理器中未获允许的变量。
 */
export function systemdLaunch(file, args, cwd, timeout, env, policy, uid = process.getuid(), managerKeys = []) {
  const unit = `agentbuild-${randomUUID()}.service`;
  const removed = managerKeys.filter((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !Object.hasOwn(env, key));
  return {
    file: 'systemd-run',
    args: ['--user', '--collect', '--wait', '--pipe', `--unit=${unit}`,
      '--expand-environment=no',
      '--slice=agentbuild.slice', `--working-directory=${cwd}`,
      `--property=CPUQuota=${policy.cpuPercent}%`, '--property=CPUWeight=10',
      `--property=MemoryHigh=${policy.memoryHighMb}M`,
      `--property=MemoryMax=${policy.memoryMb}M`, `--property=MemorySwapMax=${policy.swapMb}M`,
      '--property=TasksMax=256', '--property=KillMode=control-group',
      '--property=LimitCORE=0',
      '--property=TimeoutStopSec=5s', `--property=RuntimeMaxSec=${Math.ceil(timeout / 1000) + 1}s`,
      ...(removed.length ? [`--property=UnsetEnvironment=${removed.join(' ')}`] : []),
      ...Object.keys(env).map((key) => `--setenv=${key}`),
      '--', '/usr/bin/env', '--', file, ...args],
    env: systemdManagerEnvironment(env, uid), unit,
    cgroup: `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/agentbuild.slice/${unit}`,
  };
}

/** 从 systemd 退出报告提取结果（如 oom-kill/timeout）和内存峰值；未找到时返回空结果/0。 */
export function systemdReport(text) {
  const result = /Finished with result: ([\w-]+)/.exec(text)?.[1];
  const peak = /Memory peak: ([\d.]+)([KMGT]?)(?:B|\b)/i.exec(text);
  const exponent = peak?.[2] ? 'KMGT'.indexOf(peak[2].toUpperCase()) + 1 : 0;
  const memoryBytes = peak ? Number(peak[1]) * 1024 ** exponent : 0;
  return { result, memoryBytes };
}

/**
 * 采样服务器可用内存和该单元 cgroup 的内存/Swap 峰值，原地更新并返回 sample。
 * 单元尚未建立或已回收时文件可能不存在，独立忽略失败项，保留此前读到的统计。
 */
export async function sampleBuildResources(launch, sample = {}) {
  const number = async (name) => Number(await fs.readFile(path.join(launch.cgroup, name), 'utf8'));
  const values = await Promise.allSettled([readAvailableMemory(), number('memory.peak'), number('memory.swap.current')]);
  if (values[0].status === 'fulfilled') sample.availableBytes = values[0].value;
  if (values[1].status === 'fulfilled') sample.peakMemoryBytes = Math.max(sample.peakMemoryBytes || 0, values[1].value);
  if (values[2].status === 'fulfilled') sample.peakSwapBytes = Math.max(sample.peakSwapBytes || 0, values[2].value);
  return sample;
}

/**
 * 将阶段结果、尾部输出和资源统计追加到 cwd/.agent-build-logs/commands.jsonl。
 * 超过 2 MiB 时轮换一份 previous；写日志失败仅告警，不改变原构建命令结果。
 */
export async function recordBuildCommand(cwd, stage, result, startedAt) {
  const directory = path.join(cwd, '.agent-build-logs');
  try {
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, 'commands.jsonl');
    const size = await fs.stat(file).then((stat) => stat.size, () => 0);
    if (size > 2 * MIB) {
      await fs.rm(file + '.previous', { force: true });
      await fs.rename(file, file + '.previous');
    }
    // 只记录尾部输出和资源统计，不记录命令环境或凭据。
    await fs.appendFile(file, JSON.stringify({
      startedAt: new Date(startedAt).toISOString(), durationMs: Date.now() - startedAt,
      stage, success: result.success, code: result.code, signal: result.signal,
      resources: result.resources, stdout: result.stdout?.slice(-4000), stderr: result.stderr?.slice(-4000),
    }) + '\n');
  } catch (error) {
    console.error('[build] 写入执行诊断失败:', error.message);
  }
}

/** 将字节转换为四舍五入的 MiB 数值，供错误提示展示。 */
export const bytesInMb = (value) => Math.round(value / MIB);
