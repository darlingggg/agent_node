import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import jwt from 'jsonwebtoken';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { setImmediate as tick } from 'node:timers/promises';
import connection from '../Mysql/index.js';
import resCC from '../node/middleware/resCC.js';
import { projectBuilds } from '../node/exec/build/service.js';
import { buildTaskStore } from '../node/exec/build/task-store.js';
import previewRouter from '../node/routes/front/preview.js';
import buildRouter from '../node/routes/front/build.js';

test('real JWT routes and isolated MySQL: ownership, durable status, duplicate publications and restart recovery',
  { skip: process.env.BUILD_DB_TEST !== '1' }, async (t) => {
    const db = await connection.getConnection();
    const originalQuery = connection.query;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-build-api-'));
    let server;
    let buildCount = 0;
    let unblock;
    let published;
    try {
      const schema = await fs.readFile(new URL('../Mysql/build-tasks.sql', import.meta.url), 'utf8');
      await db.query(schema.replace('CREATE TABLE IF NOT EXISTS', 'CREATE TEMPORARY TABLE'));
      for (const name of ['users', 'projects', 'snapshots']) {
        const [[table]] = await db.query(`SHOW CREATE TABLE ${name}`);
        await db.query(table['Create Table'].replace('CREATE TABLE', 'CREATE TEMPORARY TABLE'));
      }
      connection.query = (...args) => db.query(...args);
      await fs.writeFile(path.join(root, 'index.html'), '<html>newer live source</html>');
      await db.query(`INSERT INTO users (id, account, password, nickname, role, storage_key)
        VALUES (9999111, 'build-owner', 'test', 'owner', 'normal', 'build-owner'),
               (9999112, 'build-other', 'test', 'other', 'normal', 'build-other')`);
      await db.query(`INSERT INTO projects (id, account, dir_path, title, \`desc\`, temp_version, type)
        VALUES (9999111, 'build-owner', ?, 'test', 'test', '1.0.0', 'tool')`, [root]);
      const builds = projectBuilds;
      t.mock.method(builds, 'captureSource', async (project) => {
        assert.equal(project.dir_path, root);
        const directory = await fs.mkdtemp(path.join(root, 'input-'));
        await fs.writeFile(path.join(directory, 'index.html'), '<html>immutable source</html>');
        return { directory, revision: 'a'.repeat(64) };
      });
      t.mock.method(builds.pipeline, 'build', async ({ kind }) => {
        buildCount++;
        if (kind === 'publish') await new Promise((resolve) => { unblock = resolve; });
        return { success: true, link: 'https://test.gen-agent.pages.dev', deploymentId: null,
          completedAt: new Date().toISOString() };
      });
      const finalizePublication = builds.finalizePublication;
      t.mock.method(builds, 'finalizePublication', async (job, result) => {
        await finalizePublication.call(builds, job, result);
        published = await db.query('SELECT link, current_vision FROM projects WHERE id = 9999111');
      });
      const app = express();
      app.use(express.json(), resCC, previewRouter, buildRouter);
      server = await new Promise((resolve) => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
      });
      const base = `http://127.0.0.1:${server.address().port}`;
      const token = (id) => jwt.sign({ id }, process.env.JWT_SECRET || 'agentNode_dev_secret');
      const request = (route, id = 9999111, method = 'GET', body) => fetch(base + route, {
        method, headers: { ...(id ? { Authorization: `Bearer ${token(id)}` } : {}), 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      assert.equal((await request('/project/preview?projectId=9999111', null)).status, 401);
      assert.equal((await (await request('/project/preview?projectId=9999111', 9999112)).json()).status, 1);
      assert.equal((await (await request('/project/preview?projectId=../outside')).json()).status, 1);
      const preview = await (await request('/project/preview', 9999111, 'POST', { projectId: 9999111, dir: '/outside' })).json();
      assert.equal(preview.status, 0);
      for (let i = 0; i < 100 && builds.scheduler.active; i++) await tick();
      const ready = await (await request('/project/preview?projectId=9999111')).json();
      assert.equal(ready.data.lastReady.result.link, 'https://test.gen-agent.pages.dev');
      await request('/project/preview', 9999111, 'POST', { projectId: 9999111 });
      assert.equal(buildCount, 1);
      const [[before]] = await db.query('SELECT COUNT(*) AS count FROM snapshots');
      assert.equal(before.count, 0);

      const first = await request('/project/build', 9999111, 'POST', { projectId: 9999111, dir: '/outside' });
      for (let i = 0; i < 100 && !unblock; i++) await tick();
      const second = await request('/project/build', 9999111, 'POST', { projectId: 9999111 });
      unblock();
      const [firstEvents, secondEvents] = await Promise.all([first.text(), second.text()]);
      assert.equal(buildCount, 2);
      const done = (source) => source.split('\n').filter((line) => line.startsWith('data: '))
        .map((line) => JSON.parse(line.slice(6))).find((event) => event.event === 'done');
      assert.equal(done(firstEvents).data.taskId, done(secondEvents).data.taskId);
      assert.equal(published[0][0].link, 'https://test.gen-agent.pages.dev');
      assert.ok(published[0][0].current_vision);
      const [[snapshots]] = await db.query('SELECT COUNT(DISTINCT version) AS count FROM snapshots');
      assert.equal(snapshots.count, 1);
      const [[snapshot]] = await db.query('SELECT file_path, file_content FROM snapshots LIMIT 1');
      assert.equal(snapshot.file_path, path.join(root, 'index.html'));
      assert.match(snapshot.file_content, /immutable source/);

      const interrupted = { id: randomUUID(), projectId: 9999111, account: 'build-owner', kind: 'preview',
        revision: 'b'.repeat(64), status: 'running', phase: 'build', error: '', result: null,
        requestedAt: Date.now() + 10_000, queuedAt: new Date().toISOString(), completedAt: null };
      await buildTaskStore.save(interrupted);
      await builds.recover();
      const recovered = await builds.previewState(9999111);
      assert.equal(recovered.latest.status, 'failed');
      assert.match(recovered.latest.error, /重启/);
      assert.equal(recovered.lastReady.result.link, 'https://test.gen-agent.pages.dev');
    } finally {
      unblock?.();
      if (server) await new Promise((resolve) => server.close(resolve));
      connection.query = originalQuery;
      db.release();
      await connection.end();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('direct preview/build routers preserve auth, nonblocking submission, cached URLs and SSE completion', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-build-routes-'));
  const tasks = new Map();
  const matching = (projectId, kind) => [...tasks.values()]
    .filter((task) => task.projectId === projectId && task.kind === kind);
  const store = {
    async save(task) { tasks.set(task.id, structuredClone(task)); },
    async latest(projectId, kind) {
      return matching(projectId, kind).sort((a, b) => b.requestedAt - a.requestedAt)[0] || null;
    },
    async ready(projectId, revision) {
      return matching(projectId, 'preview')
        .filter((task) => task.status === 'ready' && (!revision || task.revision === revision))
        .sort((a, b) => b.completedAt.localeCompare(a.completedAt))[0] || null;
    },
  };
  const originalStore = projectBuilds.store;
  projectBuilds.store = store;
  projectBuilds.scheduler.store = store;
  const previewGate = Promise.withResolvers();
  const finalizeGate = Promise.withResolvers();
  const finalizeStarted = Promise.withResolvers();
  let finalized = false;
  let builds = 0;
  let server;
  t.mock.method(connection, 'query', async (sql, params) => {
    if (sql.includes('FROM users')) {
      return [[{ id: params[0], account: params[0] === 1 ? 'owner' : 'other', role: 'normal' }]];
    }
    if (sql.includes('FROM projects')) {
      return [params[0] === 7777111 && params[1] === 'owner'
        ? [{ id: 7777111, account: 'owner', dir_path: root }] : []];
    }
    assert.fail('Unexpected database access: ' + sql);
  });
  t.mock.method(projectBuilds.pipeline, 'build', async (job, scheduler) => {
    builds++;
    assert.equal(await fs.readFile(path.join(job.source.directory, 'index.html'), 'utf8'), 'fixed source');
    scheduler.reportProgress(job, { event: 'step', data: { key: 'build', status: 'running' } });
    if (job.kind === 'preview') await previewGate.promise;
    return { link: 'https://routes.gen-agent.pages.dev', revision: job.revision };
  });
  t.mock.method(projectBuilds, 'finalizePublication', async () => {
    finalizeStarted.resolve();
    await finalizeGate.promise;
    finalized = true;
  });
  try {
    await fs.writeFile(path.join(root, 'index.html'), 'fixed source');
    const app = express();
    app.use(express.json(), resCC, previewRouter, buildRouter);
    server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const base = 'http://127.0.0.1:' + server.address().port;
    const request = (route, { id = 1, method = 'GET', body } = {}) => fetch(base + route, {
      method,
      signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json', ...(id ? {
        Authorization: 'Bearer ' + jwt.sign({ id }, process.env.JWT_SECRET || 'agentNode_dev_secret'),
      } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const get = '/project/preview?projectId=7777111';
    assert.equal((await request(get, { id: null })).status, 401);
    assert.equal((await (await request(get, { id: 2 })).json()).status, 1);
    assert.equal((await (await request('/project/preview?projectId=bad')).json()).status, 1);
    const initial = await (await request(get)).json();
    assert.equal(initial.data.lastReady, null);
    assert.equal(tasks.size, 0);
    const invalid = await (await request('/project/preview', {
      method: 'POST', body: { projectId: 7777111, force: 'true' },
    })).json();
    assert.equal(invalid.status, 1);
    assert.equal(tasks.size, 0);

    const submitted = await (await request('/project/preview', {
      method: 'POST', body: { projectId: 7777111, dir: '/outside' },
    })).json();
    assert.equal(submitted.status, 0);
    assert.ok(submitted.data.active || submitted.data.pending);
    assert.equal(submitted.data.lastReady, null); // POST 已返回，而构建仍被 gate 阻塞。
    const preview = projectBuilds.scheduler.find(7777111, 'preview')[0];
    previewGate.resolve();
    await preview.completion;
    for (let i = 0; i < 100 && projectBuilds.scheduler.active; i++) await tick();
    const ready = await (await request(get)).json();
    assert.equal(ready.data.lastReady.result.link, 'https://routes.gen-agent.pages.dev');
    assert.equal(ready.data.lastReady.source, undefined); // 内部目录/用户信息不进入 HTTP 或数据库。
    assert.equal(ready.data.lastReady.user, undefined);
    await request('/project/preview', { method: 'POST', body: { projectId: 7777111, force: true } });
    assert.equal(builds, 1);

    const first = await request('/project/build', { method: 'POST', body: { projectId: 7777111 } });
    await finalizeStarted.promise;
    const second = await request('/project/build', { method: 'POST', body: { projectId: 7777111 } });
    assert.equal(finalized, false);
    assert.equal(builds, 2);
    finalizeGate.resolve();
    const streams = await Promise.all([first.text(), second.text()]);
    assert.equal(finalized, true);
    const done = streams.map((stream) => stream.split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)))
      .filter((event) => event.event === 'done'));
    assert.equal(done[0].length, 1);
    assert.equal(done[1].length, 1);
    assert.equal(done[0][0].data.taskId, done[1][0].data.taskId);
    assert.equal(builds, 2);
  } finally {
    previewGate.resolve();
    finalizeGate.resolve();
    const jobs = [projectBuilds.scheduler.active, ...projectBuilds.scheduler.queue].filter(Boolean);
    await Promise.allSettled(jobs.map((job) => job.completion));
    for (let i = 0; i < 100 && projectBuilds.scheduler.active; i++) await tick();
    if (server) await new Promise((resolve) => server.close(resolve));
    projectBuilds.store = originalStore;
    projectBuilds.scheduler.store = originalStore;
    await fs.rm(root, { recursive: true, force: true });
  }
});
