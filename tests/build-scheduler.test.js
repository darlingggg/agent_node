import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as tick, setTimeout as delay } from 'node:timers/promises';
import { BuildScheduler } from '../node/exec/build/scheduler.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function input(projectId, revision, run, kind = 'preview') {
  return { projectId, account: 'test', kind, revision, run, dispose: async () => {} };
}

async function idle(scheduler) {
  for (let i = 0; i < 100 && (scheduler.active || scheduler.queue.length); i++) await tick();
  assert.equal(scheduler.active, null);
  assert.equal(scheduler.queue.length, 0);
}

test('A1 completes, A2/A3/A4 coalesce to A4 without bypassing another queued project', async () => {
  const scheduler = new BuildScheduler();
  const gate = deferred();
  const order = [];
  let running = 0;
  let maxRunning = 0;
  const run = (name, wait = Promise.resolve()) => async () => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    order.push(name);
    await wait;
    running--;
    return { link: name };
  };
  const first = await scheduler.submit(input(1, 'A1', run('A1', gate.promise)));
  await tick();
  const other = await scheduler.submit(input(2, 'B1', run('B1')));
  const second = await scheduler.submit(input(1, 'A2', run('A2')));
  const queuedAt = second.queuedAt;
  assert.equal(await scheduler.submit(input(1, 'A3', run('A3'))), second);
  assert.equal(await scheduler.submit(input(1, 'A4', run('A4'))), second);
  assert.equal(second.queuedAt, queuedAt);
  assert.equal(scheduler.queue.length, 2);
  gate.resolve();
  await Promise.all([first.completion, other.completion, second.completion]);
  await idle(scheduler);
  assert.deepEqual(order, ['A1', 'B1', 'A4']);
  assert.equal(maxRunning, 1);
});

test('duplicate content reuses the task; reverting to running content removes the pending target', async () => {
  const saved = new Map();
  const scheduler = new BuildScheduler({ save: async (task) => saved.set(task.id, task) });
  const gate = deferred();
  const first = await scheduler.submit(input(1, 'A', () => gate.promise));
  await tick();
  const queued = await scheduler.submit(input(1, 'B', async () => assert.fail('B should be skipped')));
  const reused = await scheduler.submit(input(1, 'A', async () => assert.fail('duplicate must not execute')));
  assert.equal(reused.id, first.id);
  assert.equal(queued.status, 'superseded');
  assert.equal(scheduler.queue.length, 0);
  assert.ok(saved.get(first.id).requestedAt > saved.get(queued.id).requestedAt);
  gate.resolve({ link: 'A' });
  await first.completion;
  await idle(scheduler);
});

test('publications have priority, reuse duplicate submissions and hold the slot through finalization', async () => {
  const scheduler = new BuildScheduler();
  const firstGate = deferred();
  const finalize = deferred();
  const order = [];
  const first = await scheduler.submit(input(1, 'A', () => firstGate.promise));
  await tick();
  const preview = await scheduler.submit(input(2, 'B', async () => { order.push('preview'); }));
  let finalized = false;
  const publication = await scheduler.submit(input(3, 'P1', async () => {
    order.push('publish');
    await finalize.promise;
    finalized = true;
    return { success: true };
  }, 'publish'));
  const duplicate = await scheduler.submit(input(3, 'P2', async () => assert.fail(), 'publish'));
  assert.equal(duplicate, publication);
  const events = [];
  scheduler.subscribe(publication, (event) => {
    if (event.event === 'done') assert.equal(finalized, true);
    events.push(event);
  });
  firstGate.resolve();
  await first.completion;
  for (let i = 0; i < 10 && scheduler.active !== publication; i++) await tick();
  assert.deepEqual(order, ['publish']);
  finalize.resolve();
  await Promise.all([publication.completion, preview.completion]);
  await idle(scheduler);
  assert.deepEqual(order, ['publish', 'preview']);
  assert.equal(events.filter((event) => event.event === 'done').length, 1);
});

test('capacity counts distinct projects, so latest updates do not consume another slot', async () => {
  const scheduler = new BuildScheduler({ maxProjects: 2 });
  const gate = deferred();
  const first = await scheduler.submit(input(1, 'A', () => gate.promise));
  await tick();
  const second = await scheduler.submit(input(2, 'B', async () => {}));
  const latest = await scheduler.submit(input(1, 'A2', async () => {}));
  await assert.rejects(scheduler.submit(input(3, 'C', async () => {})), /队列已满/);
  gate.resolve();
  await Promise.all([first.completion, second.completion, latest.completion]);
  await idle(scheduler);
});

test('replacement keeps the original queue deadline; expiration releases its project slot', async () => {
  const scheduler = new BuildScheduler({ queueTimeout: 30 });
  const gate = deferred();
  const first = await scheduler.submit(input(1, 'A', () => gate.promise));
  await tick();
  const queued = await scheduler.submit(input(2, 'B', async () => assert.fail()));
  const timer = queued.timer;
  await scheduler.submit(input(2, 'B2', async () => assert.fail()));
  assert.equal(queued.timer, timer);
  await assert.rejects(queued.completion, /排队|队列/);
  assert.equal(scheduler.queue.length, 0);
  gate.resolve();
  await first.completion;
  await idle(scheduler);
});

test('process and persistence failures release the execution slot for subsequent work', async () => {
  let failWrite = false;
  const scheduler = new BuildScheduler({ save: async () => {
    if (failWrite) { failWrite = false; throw new Error('write failed'); }
  } });
  const first = await scheduler.submit(input(1, 'A', async (send) => {
    failWrite = true;
    send({ event: 'step', data: { key: 'build' } });
    await delay(1);
    throw new Error('build failed');
  }));
  const second = await scheduler.submit(input(2, 'B', async () => ({ link: 'B' })));
  await assert.rejects(first.completion, /build failed/);
  assert.equal((await second.completion).link, 'B');
  await idle(scheduler);
});
