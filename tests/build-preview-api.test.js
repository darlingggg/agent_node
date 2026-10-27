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
import { createBuildService } from '../node/exec/build/service.js';
import { buildTaskStore } from '../node/exec/build/task-store.js';
import { finalizePublication } from '../node/exec/build/index.js';
import { createPreviewRouter } from '../node/routes/front/preview.js';
import { createBuildRouter } from '../node/routes/front/build.js';

test('real JWT routes and isolated MySQL: ownership, durable status, duplicate publications and restart recovery',
  { skip: process.env.BUILD_DB_TEST !== '1' }, async () => {
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
      const source = path.join(root, 'input');
      await fs.mkdir(source);
      await fs.writeFile(path.join(root, 'index.html'), '<html>newer live source</html>');
      await fs.writeFile(path.join(source, 'index.html'), '<html>immutable source</html>');
      await db.query(`INSERT INTO users (id, account, password, nickname, role, storage_key)
        VALUES (9999111, 'build-owner', 'test', 'owner', 'normal', 'build-owner'),
               (9999112, 'build-other', 'test', 'other', 'normal', 'build-other')`);
      await db.query(`INSERT INTO projects (id, account, dir_path, title, \`desc\`, temp_version, type)
        VALUES (9999111, 'build-owner', ?, 'test', 'test', '1.0.0', 'tool')`, [root]);
      const capture = async () => ({ directory: source, revision: 'a'.repeat(64), dispose: async () => {} });
      const builds = createBuildService({ store: buildTaskStore, capture,
        build: async ({ kind }) => {
          buildCount++;
          if (kind === 'publish') await new Promise((resolve) => { unblock = resolve; });
          return { success: true, link: 'https://test.gen-agent.pages.dev', deploymentId: null,
            completedAt: new Date().toISOString() };
        },
        publish: async (args) => {
          await finalizePublication(args);
          published = await db.query('SELECT link, current_vision FROM projects WHERE id = 9999111');
        },
      });
      const app = express();
      app.use(express.json(), resCC, createPreviewRouter({ builds }), createBuildRouter({ builds }));
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
