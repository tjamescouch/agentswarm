/**
 * Daemon Tests
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Daemon, DaemonState } from './daemon.js';

const tmpBase = path.join(os.tmpdir(), `daemon-test-${Date.now()}`);

function makeDaemon(overrides = {}) {
  const name = `test-daemon-${Math.random().toString(36).slice(2, 8)}`;
  const workspace = path.join(tmpBase, name);
  fs.mkdirSync(workspace, { recursive: true });

  return new Daemon({
    agentId: `agent-${name}`,
    name,
    workspace,
    heartbeatIntervalMs: 100,
    ...overrides,
  });
}

describe('Daemon', () => {
  before(() => {
    fs.mkdirSync(tmpBase, { recursive: true });
  });

  after(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  test('constructor requires agentId, name, workspace', () => {
    assert.throws(() => new Daemon({}), /agentId/);
    assert.throws(() => new Daemon({ agentId: 'a' }), /name/);
    assert.throws(() => new Daemon({ agentId: 'a', name: 'b' }), /workspace/);
  });

  test('starts in idle state', () => {
    const d = makeDaemon();
    assert.strictEqual(d.state, DaemonState.IDLE);
    d.stop();
  });

  test('start emits started event', () => {
    const d = makeDaemon();
    const events = [];
    d.on('started', e => events.push(e));
    d.start();
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].agentId, d.agentId);
    d.stop();
  });

  test('sends heartbeats when idle', async () => {
    const d = makeDaemon({ heartbeatIntervalMs: 50 });
    const heartbeats = [];
    d.on('heartbeat', h => heartbeats.push(h));
    d.start();

    await new Promise(r => setTimeout(r, 180));
    d.stop();

    assert.ok(heartbeats.length >= 2, `Expected >=2 heartbeats, got ${heartbeats.length}`);
    assert.strictEqual(heartbeats[0].status, DaemonState.IDLE);
  });

  test('matchesRole for builder', () => {
    const d = makeDaemon({ role: 'builder' });
    assert.strictEqual(d.matchesRole({ role: 'builder' }), true);
    assert.strictEqual(d.matchesRole({ role: 'auditor' }), false);
    d.stop();
  });

  test('matchesRole for general matches everything', () => {
    const d = makeDaemon({ role: 'general' });
    assert.strictEqual(d.matchesRole({ role: 'builder' }), true);
    assert.strictEqual(d.matchesRole({ role: 'auditor' }), true);
    assert.strictEqual(d.matchesRole({}), true);
    d.stop();
  });

  test('handleMessage ignores when not idle', () => {
    const d = makeDaemon();
    d.state = DaemonState.ACTIVE;
    const events = [];
    d.on('claim', e => events.push(e));
    d.on('promote-request', e => events.push(e));

    d.handleMessage({ type: 'TASK_AVAILABLE', task: { role: 'builder' } });
    d.handleMessage({ type: 'ASSIGN', agentId: d.agentId, task: {} });

    assert.strictEqual(events.length, 0);
    d.stop();
  });

  test('handleMessage emits claim for matching task', () => {
    const d = makeDaemon({ role: 'builder' });
    d.start();
    const claims = [];
    d.on('claim', c => claims.push(c));

    d.handleMessage({
      type: 'TASK_AVAILABLE',
      task: { role: 'builder', component: 'spawner' },
    });

    assert.strictEqual(claims.length, 1);
    assert.strictEqual(claims[0].component, 'spawner');
    d.stop();
  });

  test('handleMessage does not claim non-matching role', () => {
    const d = makeDaemon({ role: 'builder' });
    d.start();
    const claims = [];
    d.on('claim', c => claims.push(c));

    d.handleMessage({
      type: 'TASK_AVAILABLE',
      task: { role: 'auditor', component: 'qa' },
    });

    assert.strictEqual(claims.length, 0);
    d.stop();
  });

  test('ASSIGN triggers promote-request', () => {
    const d = makeDaemon();
    d.start();
    const requests = [];
    d.on('promote-request', r => requests.push(r));

    d.handleMessage({
      type: 'ASSIGN',
      agentId: d.agentId,
      task: { component: 'spawner', prompt: 'build it' },
    });

    assert.strictEqual(requests.length, 1);
    assert.strictEqual(d.state, DaemonState.PROMOTING);
    d.stop();
  });

  test('denyPromotion returns to idle', () => {
    const d = makeDaemon();
    d.start();
    const unclaims = [];
    d.on('unclaim', u => unclaims.push(u));

    d.handleMessage({
      type: 'ASSIGN',
      agentId: d.agentId,
      task: { component: 'spawner' },
    });

    assert.strictEqual(d.state, DaemonState.PROMOTING);
    d.denyPromotion('quota exceeded');

    assert.strictEqual(d.state, DaemonState.IDLE);
    assert.strictEqual(d.currentTask, null);
    assert.strictEqual(unclaims.length, 1);
    assert.ok(unclaims[0].reason.includes('quota'));
    d.stop();
  });

  test('approvePromotion in wrong state emits error', () => {
    const d = makeDaemon();
    d.start();
    const errors = [];
    d.on('error', e => errors.push(e));

    d.approvePromotion({ prompt: 'test' });
    assert.strictEqual(errors.length, 1);
    assert.ok(errors[0].error.includes('not in promoting'));
    d.stop();
  });

  test('approvePromotion writes context.md', () => {
    const d = makeDaemon();
    d.start();

    // Get into promoting state
    d.handleMessage({
      type: 'ASSIGN',
      agentId: d.agentId,
      task: { component: 'test-comp', prompt: 'build the test component' },
    });

    // Override _spawnClaude to avoid actually running claude
    d._spawnClaude = () => {
      d.state = DaemonState.ACTIVE;
    };

    d.approvePromotion({ component: 'test-comp', prompt: 'build the test component' });

    const contextPath = path.join(d.workspace, 'context.md');
    assert.ok(fs.existsSync(contextPath));
    const content = fs.readFileSync(contextPath, 'utf8');
    assert.ok(content.includes('test-comp'));
    d.stop();
  });

  test('demotion writes context and returns to idle', () => {
    const d = makeDaemon();
    d.start();
    const doneEvents = [];
    const demotedEvents = [];
    d.on('done', e => doneEvents.push(e));
    d.on('demoted', e => demotedEvents.push(e));

    // Simulate full lifecycle
    d.state = DaemonState.ACTIVE;
    d.currentTask = { component: 'test', prompt: 'test task' };

    // Simulate claude exit
    d._handleClaudeExit(0, null, 'build complete', '');

    assert.strictEqual(d.state, DaemonState.IDLE);
    assert.strictEqual(d.currentTask, null);
    assert.strictEqual(doneEvents.length, 1);
    assert.strictEqual(doneEvents[0].success, true);
    assert.strictEqual(demotedEvents.length, 1);

    // context.md written
    const content = fs.readFileSync(path.join(d.workspace, 'context.md'), 'utf8');
    assert.ok(content.includes('SUCCESS'));
    d.stop();
  });

  test('failed claude exit emits fail', () => {
    const d = makeDaemon();
    d.start();
    const failEvents = [];
    d.on('fail', e => failEvents.push(e));

    d.state = DaemonState.ACTIVE;
    d.currentTask = { component: 'broken', prompt: 'fail' };

    d._handleClaudeExit(1, null, '', 'error output');

    assert.strictEqual(d.state, DaemonState.IDLE);
    assert.strictEqual(failEvents.length, 1);
    assert.strictEqual(failEvents[0].success, false);
    assert.strictEqual(failEvents[0].exitCode, 1);
    d.stop();
  });

  test('claude spawn error sets crashed state', () => {
    const d = makeDaemon();
    d.start();
    const crashEvents = [];
    d.on('crashed', e => crashEvents.push(e));

    d.state = DaemonState.ACTIVE;
    d.currentTask = { component: 'broken' };

    d._handleClaudeError(new Error('command not found'));

    assert.strictEqual(d.state, DaemonState.CRASHED);
    assert.strictEqual(crashEvents.length, 1);
    assert.ok(crashEvents[0].error.includes('command not found'));

    // context.md has crash info
    const content = fs.readFileSync(path.join(d.workspace, 'context.md'), 'utf8');
    assert.ok(content.includes('Crash'));
    d.stop();
  });

  test('idle daemon only sends heartbeats', () => {
    const d = makeDaemon();
    // Verify no claim/output/done/fail emissions from an idle daemon
    // that receives non-matching messages
    const badEvents = [];
    d.on('output', e => badEvents.push(e));
    d.on('done', e => badEvents.push(e));
    d.on('fail', e => badEvents.push(e));
    d.on('promoted', e => badEvents.push(e));

    d.start();
    d.handleMessage({ type: 'MSG', content: 'hello' });
    d.handleMessage({ type: 'UNKNOWN', data: 'noise' });

    assert.strictEqual(badEvents.length, 0);
    d.stop();
  });

  test('info returns current state', () => {
    const d = makeDaemon({ role: 'auditor' });
    d.start();

    const info = d.info();
    assert.strictEqual(info.agentId, d.agentId);
    assert.strictEqual(info.role, 'auditor');
    assert.strictEqual(info.state, DaemonState.IDLE);
    assert.strictEqual(info.currentTask, null);
    assert.strictEqual(info.hasClaude, false);
    d.stop();
  });

  test('stop cleans up timers', () => {
    const d = makeDaemon({ heartbeatIntervalMs: 50 });
    d.start();
    assert.ok(d._heartbeatTimer);

    d.stop();
    assert.strictEqual(d._heartbeatTimer, null);
    assert.strictEqual(d.state, DaemonState.IDLE);
  });
});
