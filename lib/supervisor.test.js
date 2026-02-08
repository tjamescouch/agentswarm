/**
 * Supervisor Tests
 */

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Supervisor } from './supervisor.js';
import { DaemonState } from './daemon.js';

const tmpBase = path.join(os.tmpdir(), `supervisor-test-${Date.now()}`);

function makeConfig(overrides = {}) {
  const id = Math.random().toString(36).slice(2, 8);
  return {
    count: 3,
    maxActive: 2,
    basePath: path.join(tmpBase, `workspace-${id}`),
    pidfile: path.join(tmpBase, `swarm-${id}.pid`),
    logDir: path.join(tmpBase, `logs-${id}`),
    heartbeatIntervalMs: 100,
    persist: false,
    ...overrides,
  };
}

describe('Supervisor', () => {
  before(() => {
    fs.mkdirSync(tmpBase, { recursive: true });
  });

  after(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  test('start spawns N daemons', async () => {
    const sup = new Supervisor(makeConfig({ count: 5 }));
    await sup.start();

    const status = sup.status();
    assert.strictEqual(status.total, 5);
    assert.strictEqual(status.idle, 5);
    assert.strictEqual(status.active, 0);
    assert.strictEqual(status.running, true);

    await sup.stop();
  });

  test('pidfile prevents double start', async () => {
    const config = makeConfig();
    const sup1 = new Supervisor(config);
    await sup1.start();

    const sup2 = new Supervisor(config);
    await assert.rejects(() => sup2.start(), /already running/);

    await sup1.stop();
  });

  test('pidfile removed on stop', async () => {
    const config = makeConfig();
    const sup = new Supervisor(config);
    await sup.start();
    assert.ok(fs.existsSync(config.pidfile));

    await sup.stop();
    assert.ok(!fs.existsSync(config.pidfile));
  });

  test('stale pidfile is cleaned up', async () => {
    const config = makeConfig();
    // Write a pidfile with a dead PID
    fs.mkdirSync(path.dirname(config.pidfile), { recursive: true });
    fs.writeFileSync(config.pidfile, '999999999');

    const sup = new Supervisor(config);
    await sup.start(); // Should succeed despite stale pidfile

    assert.strictEqual(sup.status().running, true);
    await sup.stop();
  });

  test('stop cleans up all daemons', async () => {
    const sup = new Supervisor(makeConfig({ count: 3, persist: false }));
    await sup.start();
    assert.strictEqual(sup.processTable.size, 3);

    await sup.stop();
    assert.strictEqual(sup.processTable.size, 0);
    assert.strictEqual(sup.running, false);
  });

  test('stop with persist keeps workspaces', async () => {
    const config = makeConfig({ count: 2, persist: true });
    const sup = new Supervisor(config);
    await sup.start();

    // Get workspace paths before stopping
    const workspaces = [];
    for (const [, entry] of sup.processTable) {
      workspaces.push(entry.daemon.workspace);
    }

    await sup.stop();

    // Workspaces should still exist
    for (const ws of workspaces) {
      assert.ok(fs.existsSync(ws), `Workspace should persist: ${ws}`);
    }
  });

  test('promotion respects maxActive', async () => {
    const sup = new Supervisor(makeConfig({ count: 3, maxActive: 1 }));
    await sup.start();

    const agents = [...sup.processTable.values()];

    // Override _spawnClaude BEFORE handleMessage (supervisor auto-approves synchronously)
    agents[0].daemon._spawnClaude = function () {
      this.state = DaemonState.ACTIVE;
      this.emit('promoted', { agentId: this.agentId, pid: null, task: this.currentTask });
    };

    // First promotion — auto-approved by supervisor
    agents[0].daemon.handleMessage({
      type: 'ASSIGN',
      agentId: agents[0].daemon.agentId,
      task: { component: 'test1', prompt: 'task 1' },
    });

    assert.strictEqual(sup.activeCount, 1);

    // Second promotion should be queued (maxActive=1)
    agents[1].daemon.handleMessage({
      type: 'ASSIGN',
      agentId: agents[1].daemon.agentId,
      task: { component: 'test2', prompt: 'task 2' },
    });

    assert.strictEqual(sup.activeCount, 1);
    assert.strictEqual(sup.promotionQueue.length, 1);

    await sup.stop();
  });

  test('promotion queue drains on demotion', async () => {
    const sup = new Supervisor(makeConfig({ count: 3, maxActive: 1 }));
    await sup.start();
    const logs = [];
    sup.on('log', l => logs.push(l));

    const agents = [...sup.processTable.values()];

    // Override _spawnClaude BEFORE triggering promotions
    agents[0].daemon._spawnClaude = function () {
      this.state = DaemonState.ACTIVE;
      this.emit('promoted', { agentId: this.agentId, pid: null, task: this.currentTask });
    };
    agents[1].daemon._spawnClaude = function () {
      this.state = DaemonState.ACTIVE;
      this.emit('promoted', { agentId: this.agentId, pid: null, task: this.currentTask });
    };

    // Promote first (auto-approved)
    agents[0].daemon.handleMessage({
      type: 'ASSIGN',
      agentId: agents[0].daemon.agentId,
      task: { component: 'test1', prompt: 'task 1' },
    });

    // Queue second (maxActive=1, slot full)
    agents[1].daemon.handleMessage({
      type: 'ASSIGN',
      agentId: agents[1].daemon.agentId,
      task: { component: 'test2', prompt: 'task 2' },
    });
    assert.strictEqual(sup.promotionQueue.length, 1);

    // Demote first — should auto-promote second from queue
    agents[0].daemon._handleClaudeExit(0, null, 'done', '');

    assert.strictEqual(sup.promotionQueue.length, 0);

    await sup.stop();
  });

  test('token budget pauses promotions', async () => {
    const sup = new Supervisor(makeConfig({ count: 2, maxActive: 5, tokenBudget: 100 }));
    await sup.start();

    sup.tokensUsed = 100; // Exhaust budget

    const agents = [...sup.processTable.values()];
    const unclaims = [];
    agents[0].daemon.on('unclaim', u => unclaims.push(u));

    agents[0].daemon.handleMessage({
      type: 'ASSIGN',
      agentId: agents[0].daemon.agentId,
      task: { component: 'test', prompt: 'task' },
    });

    assert.strictEqual(sup.promotionsPaused, true);
    assert.strictEqual(unclaims.length, 1);
    assert.ok(unclaims[0].reason.includes('budget'));

    await sup.stop();
  });

  test('scale up adds daemons', async () => {
    const sup = new Supervisor(makeConfig({ count: 2 }));
    await sup.start();
    assert.strictEqual(sup.processTable.size, 2);

    const result = await sup.scale(5);
    assert.strictEqual(result.from, 2);
    assert.strictEqual(result.to, 5);
    assert.strictEqual(result.added, 3);
    assert.strictEqual(sup.processTable.size, 5);

    await sup.stop();
  });

  test('scale down removes idle daemons', async () => {
    const sup = new Supervisor(makeConfig({ count: 5 }));
    await sup.start();

    const result = await sup.scale(2);
    assert.strictEqual(result.from, 5);
    assert.strictEqual(result.removed, 3);
    assert.strictEqual(sup.processTable.size, 2);

    await sup.stop();
  });

  test('scale down preserves active agents', async () => {
    const sup = new Supervisor(makeConfig({ count: 3, maxActive: 3 }));
    await sup.start();

    const agents = [...sup.processTable.values()];

    // Override _spawnClaude BEFORE handleMessage
    agents[0].daemon._spawnClaude = function () {
      this.state = DaemonState.ACTIVE;
      this.emit('promoted', { agentId: this.agentId, pid: null, task: this.currentTask });
    };

    // Promote one agent (auto-approved)
    agents[0].daemon.handleMessage({
      type: 'ASSIGN',
      agentId: agents[0].daemon.agentId,
      task: { component: 'busy', prompt: 'working' },
    });

    // Scale down to 1 — should only remove idle daemons
    const result = await sup.scale(1);
    assert.strictEqual(result.removed, 2); // 2 idle removed
    // The active agent should still be in the process table
    assert.ok(sup.processTable.size >= 1);

    await sup.stop();
  });

  test('scale to zero stops swarm', async () => {
    const sup = new Supervisor(makeConfig({ count: 3 }));
    await sup.start();
    await sup.scale(0);
    assert.strictEqual(sup.running, false);
    assert.strictEqual(sup.processTable.size, 0);
  });

  test('reloadConfig updates maxActive', async () => {
    const sup = new Supervisor(makeConfig({ count: 2, maxActive: 1 }));
    await sup.start();

    assert.strictEqual(sup.maxActive, 1);
    sup.reloadConfig({ maxActive: 10 });
    assert.strictEqual(sup.maxActive, 10);

    await sup.stop();
  });

  test('reloadConfig resumes promotions if budget increased', async () => {
    const sup = new Supervisor(makeConfig({ count: 2, tokenBudget: 100 }));
    await sup.start();
    sup.tokensUsed = 100;
    sup.promotionsPaused = true;

    sup.reloadConfig({ tokenBudget: 200 });
    assert.strictEqual(sup.promotionsPaused, false);

    await sup.stop();
  });

  test('status returns complete swarm info', async () => {
    const sup = new Supervisor(makeConfig({ count: 3 }));
    await sup.start();

    const status = sup.status();
    assert.strictEqual(status.running, true);
    assert.ok(status.uptime >= 0);
    assert.strictEqual(status.total, 3);
    assert.strictEqual(status.active, 0);
    assert.strictEqual(status.idle, 3);
    assert.strictEqual(status.agents.length, 3);
    assert.ok(status.agents[0].agentId);
    assert.ok(status.agents[0].name);
    assert.strictEqual(status.agents[0].state, DaemonState.IDLE);

    await sup.stop();
  });

  test('supervisor never executes agent work', () => {
    const sup = new Supervisor(makeConfig());
    // Verify no execute/run/build methods exist on supervisor
    assert.strictEqual(typeof sup.execute, 'undefined');
    assert.strictEqual(typeof sup.run, 'undefined');
    assert.strictEqual(typeof sup.build, 'undefined');
    // It only manages — start, stop, scale, status
    assert.strictEqual(typeof sup.start, 'function');
    assert.strictEqual(typeof sup.stop, 'function');
    assert.strictEqual(typeof sup.scale, 'function');
    assert.strictEqual(typeof sup.status, 'function');
  });

  test('broadcastTask sends to bus and local daemons', async () => {
    const sup = new Supervisor(makeConfig({ count: 2 }));
    await sup.start();

    const claims = [];
    const agents = [...sup.processTable.values()];
    agents[0].daemon.on('claim', c => claims.push(c));
    agents[1].daemon.on('claim', c => claims.push(c));

    await sup.broadcastTask({ role: 'builder', component: 'test', prompt: 'do it' });

    // Both daemons should see the task and emit claims (both are idle builders)
    assert.strictEqual(claims.length, 2);

    await sup.stop();
  });

  test('assignTask sends to specific daemon', async () => {
    const sup = new Supervisor(makeConfig({ count: 2 }));
    await sup.start();

    const agents = [...sup.processTable.values()];
    const targetId = agents[0].daemon.agentId;

    // Override _spawnClaude to prevent actual process spawn
    agents[0].daemon._spawnClaude = function () {
      this.state = DaemonState.ACTIVE;
      this.emit('promoted', { agentId: this.agentId, pid: null, task: this.currentTask });
    };

    await sup.assignTask(targetId, { component: 'auth', prompt: 'build auth' });

    assert.strictEqual(agents[0].daemon.state, DaemonState.ACTIVE);
    assert.strictEqual(agents[1].daemon.state, DaemonState.IDLE);

    await sup.stop();
  });

  test('message bus routes TASK_AVAILABLE to daemons', async () => {
    const sup = new Supervisor(makeConfig({ count: 2 }));
    await sup.start();

    const claims = [];
    const agents = [...sup.processTable.values()];
    agents[0].daemon.on('claim', c => claims.push(c));

    // Simulate an external message arriving on the bus
    sup.messageBus.emit('message', {
      from: 'external-coordinator',
      to: '#agents',
      content: JSON.stringify({
        type: 'TASK_AVAILABLE',
        task: { role: 'builder', component: 'external-task' },
      }),
    });

    assert.ok(claims.length > 0);
    assert.strictEqual(claims[0].component, 'external-task');

    await sup.stop();
  });
});
