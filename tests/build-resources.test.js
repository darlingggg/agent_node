import assert from 'node:assert/strict';
import { test } from 'node:test';
import { availableMemory, resourcePolicy, systemdLaunch, systemdReport, memoryPressure } from '../node/exec/build/resource-policy.js';

test('resource launcher bounds the entire process group and gives systemd an independent deadline', () => {
  const policy = resourcePolicy({});
  const env = { PATH: '/usr/bin', NODE_OPTIONS: '--max-old-space-size=512' };
  const launch = systemdLaunch('pnpm', ['run', 'build', 'literal;$(no-shell)'], '/project with spaces', 1501, env, policy, 1000);
  assert.equal(launch.file, 'systemd-run');
  assert.ok(launch.args.includes('--property=MemoryMax=640M'));
  assert.ok(launch.args.includes('--property=MemoryHigh=384M'));
  assert.ok(launch.args.includes('--property=MemorySwapMax=768M'));
  assert.ok(launch.args.includes('--property=CPUQuota=100%'));
  assert.ok(launch.args.includes('--property=RuntimeMaxSec=3s'));
  assert.ok(launch.args.includes('--property=KillMode=control-group'));
  assert.ok(launch.args.includes('--working-directory=/project with spaces'));
  assert.deepEqual(launch.args.slice(-4), ['pnpm', 'run', 'build', 'literal;$(no-shell)']);
  assert.ok(launch.args.includes('/usr/bin/env'));
  assert.ok(launch.args.includes('--setenv=PATH'));
  assert.ok(launch.args.includes('--expand-environment=no'));
  assert.equal(launch.env.XDG_RUNTIME_DIR, '/run/user/1000');
  assert.ok(launch.cgroup.endsWith(launch.unit));
});

test('credentials travel in environment only and inherited business variables are removed', () => {
  const env = { PATH: '/usr/bin', CLOUDFLARE_API_TOKEN: 'private-probe-value' };
  const launch = systemdLaunch('node', ['script.js'], '/project', 1000, env, resourcePolicy({}), 1000,
    ['PATH', 'OPENAI_API_KEY', 'JWT_SECRET', 'CLOUDFLARE_API_TOKEN']);
  assert.ok(launch.args.includes('--setenv=CLOUDFLARE_API_TOKEN'));
  assert.ok(launch.args.includes('--property=UnsetEnvironment=OPENAI_API_KEY JWT_SECRET'));
  assert.equal(launch.args.join(' ').includes(env.CLOUDFLARE_API_TOKEN), false);
  assert.equal(launch.env.CLOUDFLARE_API_TOKEN, env.CLOUDFLARE_API_TOKEN);
});

test('brief pressure allows cgroup reclaim while sustained or severe pressure stops the job', () => {
  const mb = 1024 * 1024;
  assert.deepEqual(memoryPressure(180 * mb, 192), { samples: 1, stop: false });
  assert.deepEqual(memoryPressure(220 * mb, 192, 2), { samples: 0, stop: false });
  assert.deepEqual(memoryPressure(180 * mb, 192, 2), { samples: 3, stop: true });
  assert.deepEqual(memoryPressure(80 * mb, 192), { samples: 1, stop: true });
});

test('systemd failure reports identify an OOM even when the launcher returns exit code one', () => {
  assert.deepEqual(systemdReport('Finished with result: oom-kill\nMemory peak: 96.0M\n'),
    { result: 'oom-kill', memoryBytes: 96 * 1024 * 1024 });
  assert.equal(systemdReport('Finished with result: timeout\nMemory peak: 256.0K\n').memoryBytes, 256 * 1024);
  assert.equal(systemdReport('Memory peak: 100B\n').memoryBytes, 100);
});

test('invalid resource settings cannot silently remove limits and MemAvailable drives admission', () => {
  const policy = resourcePolicy({ BUILD_MEMORY_MB: '-1', BUILD_SWAP_MB: 'Infinity', BUILD_CPU_PERCENT: '0' });
  assert.equal(policy.memoryMb, 640);
  assert.equal(policy.swapMb, 768);
  assert.equal(policy.cpuPercent, 100);
  assert.equal(resourcePolicy({ BUILD_SWAP_MB: '0' }).swapMb, 0);
  assert.equal(availableMemory('MemTotal: 1700000 kB\nMemFree: 100 kB\nMemAvailable: 700000 kB\n'), 700000 * 1024);
  assert.throws(() => availableMemory('MemFree: 100 kB'), /无法读取/);
});
