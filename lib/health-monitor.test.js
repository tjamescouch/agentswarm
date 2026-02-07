/**
 * Health Monitor Tests
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { HealthMonitor } from './health-monitor.js';

describe('HealthMonitor', () => {
  test('register and heartbeat', () => {
    const hm = new HealthMonitor();
    hm.register('agent-001');

    const status = hm.healthStatus('agent-001');
    assert.strictEqual(status.alive, true);
    assert.ok(status.lastSeen > 0);
  });

  test('healthStatus returns null for unknown agent', () => {
    const hm = new HealthMonitor();
    assert.strictEqual(hm.healthStatus('nonexistent'), null);
  });

  test('heartbeat resets consecutive misses', () => {
    const hm = new HealthMonitor({ heartbeatIntervalMs: 50 });
    hm.register('agent-001');

    // Simulate time passing by backdating lastSeen
    hm.agents.get('agent-001').lastSeen = Date.now() - 200;
    hm.check();

    const summary = hm.healthSummary();
    const agent = summary.find(a => a.agentId === 'agent-001');
    assert.ok(agent.consecutiveMisses > 0);

    // Heartbeat resets
    hm.heartbeat('agent-001');
    const afterHb = hm.healthSummary().find(a => a.agentId === 'agent-001');
    assert.strictEqual(afterHb.consecutiveMisses, 0);
    assert.strictEqual(afterHb.status, 'alive');
  });

  test('agent declared dead after threshold misses', () => {
    const alerts = [];
    const hm = new HealthMonitor({ heartbeatIntervalMs: 10, missThreshold: 3 });
    hm.on('alert', a => alerts.push(a));

    hm.register('agent-001');

    // Backdate to simulate 5 missed intervals (50ms with 10ms interval)
    hm.agents.get('agent-001').lastSeen = Date.now() - 50;
    hm.check();

    assert.strictEqual(hm.agents.get('agent-001').status, 'dead');
    assert.strictEqual(alerts.length, 1);
    assert.strictEqual(alerts[0].agentId, 'agent-001');
    assert.strictEqual(alerts[0].reason, 'unresponsive');
  });

  test('no single-miss kill — unresponsive then dead', () => {
    const alerts = [];
    const hm = new HealthMonitor({ heartbeatIntervalMs: 100, missThreshold: 3 });
    hm.on('alert', a => alerts.push(a));

    hm.register('agent-001');

    // 1 missed interval — should be unresponsive, not dead
    hm.agents.get('agent-001').lastSeen = Date.now() - 150;
    hm.check();
    assert.strictEqual(hm.agents.get('agent-001').status, 'unresponsive');
    assert.strictEqual(alerts.length, 0);

    // 3+ missed intervals — now dead
    hm.agents.get('agent-001').lastSeen = Date.now() - 350;
    hm.check();
    assert.strictEqual(hm.agents.get('agent-001').status, 'dead');
    assert.strictEqual(alerts.length, 1);
  });

  test('dead alert emitted only once', () => {
    const alerts = [];
    const hm = new HealthMonitor({ heartbeatIntervalMs: 10, missThreshold: 2 });
    hm.on('alert', a => alerts.push(a));

    hm.register('agent-001');
    hm.agents.get('agent-001').lastSeen = Date.now() - 100;

    hm.check();
    hm.check();
    hm.check();

    // Only one unresponsive alert, not three
    const unresponsiveAlerts = alerts.filter(a => a.reason === 'unresponsive');
    assert.strictEqual(unresponsiveAlerts.length, 1);
  });

  test('healthSummary returns all agents', () => {
    const hm = new HealthMonitor();
    hm.register('a');
    hm.register('b');
    hm.register('c');

    const summary = hm.healthSummary();
    assert.strictEqual(summary.length, 3);
    assert.ok(summary.every(s => s.alive));
    assert.ok(summary.every(s => typeof s.uptimeSeconds === 'number'));
  });

  test('unregister removes agent', () => {
    const hm = new HealthMonitor();
    hm.register('agent-001');
    assert.ok(hm.healthStatus('agent-001'));

    hm.unregister('agent-001');
    assert.strictEqual(hm.healthStatus('agent-001'), null);
    assert.strictEqual(hm.healthSummary().length, 0);
  });

  test('updatePid sets pid on agent', () => {
    const hm = new HealthMonitor();
    hm.register('agent-001');
    assert.strictEqual(hm.agents.get('agent-001').pid, null);

    hm.updatePid('agent-001', 12345);
    assert.strictEqual(hm.agents.get('agent-001').pid, 12345);
  });

  test('resource limit alerts', () => {
    const alerts = [];
    const hm = new HealthMonitor({ memoryLimitMb: 100, cpuLimitPct: 80 });
    hm.on('alert', a => alerts.push(a));

    hm.register('agent-001', process.pid);

    // Manually set stats to trigger alerts (since process.pid stats are real)
    const agent = hm.agents.get('agent-001');
    // Override _queryProcessStats to return known values
    hm._queryProcessStats = () => ({ memoryMb: 150, cpuPct: 90 });

    hm.check();

    const memAlert = alerts.find(a => a.reason === 'memory_limit');
    const cpuAlert = alerts.find(a => a.reason === 'cpu_limit');
    assert.ok(memAlert, 'Should have memory limit alert');
    assert.ok(cpuAlert, 'Should have CPU limit alert');
  });

  test('process stats query for current process', () => {
    const hm = new HealthMonitor();
    const stats = hm._queryProcessStats(process.pid);
    // Should return stats for our own process
    assert.ok(stats, 'Should get stats for current process');
    assert.ok(stats.memoryMb > 0);
    assert.ok(typeof stats.cpuPct === 'number');
  });

  test('process stats returns null for nonexistent pid', () => {
    const hm = new HealthMonitor();
    const stats = hm._queryProcessStats(999999999);
    assert.strictEqual(stats, null);
  });

  test('start and stop periodic checks', () => {
    const hm = new HealthMonitor({ checkIntervalMs: 50 });
    hm.start();
    assert.ok(hm._checkTimer);

    // Start is idempotent
    hm.start();

    hm.stop();
    assert.strictEqual(hm._checkTimer, null);
  });

  test('never kills processes — only emits alerts', () => {
    // Verify the monitor has no kill/signal methods
    const hm = new HealthMonitor();
    assert.strictEqual(typeof hm.kill, 'undefined');
    assert.strictEqual(typeof hm.signal, 'undefined');
    // Only emits events, supervisor decides what to do
    assert.ok(typeof hm.emit === 'function');
  });
});
