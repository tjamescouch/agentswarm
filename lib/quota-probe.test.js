/**
 * QuotaProbe Tests
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'events';
import { QuotaProbe, attachQuotaProbe } from './quota-probe.js';

describe('QuotaProbe', () => {
  test('constructor defaults', () => {
    const probe = new QuotaProbe();
    assert.strictEqual(probe.budget, 0);
    assert.strictEqual(probe.estimationMethod, 'output');
    assert.strictEqual(probe.totalTokens, 0);
    assert.strictEqual(probe.isExhausted(), false);
  });

  test('constructor accepts config', () => {
    const probe = new QuotaProbe({
      budget: 10000,
      estimationMethod: 'duration',
      warningThreshold: 0.9,
    });
    assert.strictEqual(probe.budget, 10000);
    assert.strictEqual(probe.estimationMethod, 'duration');
    assert.strictEqual(probe.warningThreshold, 0.9);
  });

  test('record with output estimation', () => {
    const probe = new QuotaProbe({ estimationMethod: 'output' });

    probe.record({
      agentId: 'agent-1',
      output: 'x'.repeat(400), // 400 chars = 100 tokens at 4 chars/token
    });

    assert.strictEqual(probe.totalTokens, 100);
    const usage = probe.agentUsage('agent-1');
    assert.strictEqual(usage.totalTokens, 100);
    assert.strictEqual(usage.tasks, 1);
  });

  test('record with duration estimation', () => {
    const probe = new QuotaProbe({ estimationMethod: 'duration', tokensPerSecond: 100 });

    probe.record({
      agentId: 'agent-1',
      durationMs: 5000, // 5 seconds = 500 tokens at 100/sec
    });

    assert.strictEqual(probe.totalTokens, 500);
  });

  test('record with explicit token count', () => {
    const probe = new QuotaProbe();

    probe.record({
      agentId: 'agent-1',
      tokens: 1234,
      output: 'ignored since explicit count provided',
    });

    assert.strictEqual(probe.totalTokens, 1234);
  });

  test('record accumulates across tasks', () => {
    const probe = new QuotaProbe();

    probe.record({ agentId: 'agent-1', tokens: 100 });
    probe.record({ agentId: 'agent-1', tokens: 200 });
    probe.record({ agentId: 'agent-2', tokens: 300 });

    assert.strictEqual(probe.totalTokens, 600);

    const a1 = probe.agentUsage('agent-1');
    assert.strictEqual(a1.totalTokens, 300);
    assert.strictEqual(a1.tasks, 2);

    const a2 = probe.agentUsage('agent-2');
    assert.strictEqual(a2.totalTokens, 300);
    assert.strictEqual(a2.tasks, 1);
  });

  test('record ignores entries without agentId', () => {
    const probe = new QuotaProbe();
    probe.record({ tokens: 100 }); // No agentId
    assert.strictEqual(probe.totalTokens, 0);
  });

  test('agentUsage returns null for unknown agent', () => {
    const probe = new QuotaProbe();
    assert.strictEqual(probe.agentUsage('unknown'), null);
  });

  test('isExhausted with no budget is always false', () => {
    const probe = new QuotaProbe({ budget: 0 });
    probe.record({ agentId: 'agent-1', tokens: 999999 });
    assert.strictEqual(probe.isExhausted(), false);
  });

  test('isExhausted detects budget breach', () => {
    const probe = new QuotaProbe({ budget: 1000 });
    assert.strictEqual(probe.isExhausted(), false);

    probe.record({ agentId: 'agent-1', tokens: 500 });
    assert.strictEqual(probe.isExhausted(), false);

    probe.record({ agentId: 'agent-1', tokens: 500 });
    assert.strictEqual(probe.isExhausted(), true);
  });

  test('emits budget_exhausted event', () => {
    const probe = new QuotaProbe({ budget: 100 });
    const events = [];
    probe.on('budget_exhausted', e => events.push(e));

    probe.record({ agentId: 'a', tokens: 100 });

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].totalTokens, 100);
    assert.strictEqual(events[0].budget, 100);
  });

  test('emits budget_warning at threshold', () => {
    const probe = new QuotaProbe({ budget: 100, warningThreshold: 0.8 });
    const warnings = [];
    probe.on('budget_warning', e => warnings.push(e));

    probe.record({ agentId: 'a', tokens: 70 });
    assert.strictEqual(warnings.length, 0);

    probe.record({ agentId: 'a', tokens: 15 });
    assert.strictEqual(warnings.length, 1);
    assert.strictEqual(warnings[0].pct, 85);
  });

  test('budget_warning emitted only once', () => {
    const probe = new QuotaProbe({ budget: 100, warningThreshold: 0.8 });
    const warnings = [];
    probe.on('budget_warning', e => warnings.push(e));

    probe.record({ agentId: 'a', tokens: 85 });
    probe.record({ agentId: 'a', tokens: 5 });

    assert.strictEqual(warnings.length, 1);
  });

  test('emits usage event on each record', () => {
    const probe = new QuotaProbe();
    const events = [];
    probe.on('usage', e => events.push(e));

    probe.record({ agentId: 'a', tokens: 50 });
    probe.record({ agentId: 'b', tokens: 30 });

    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].agentId, 'a');
    assert.strictEqual(events[0].tokens, 50);
    assert.strictEqual(events[1].totalTokens, 80);
  });

  test('summary returns sorted agent list', () => {
    const probe = new QuotaProbe({ budget: 1000 });

    probe.record({ agentId: 'a', tokens: 100 });
    probe.record({ agentId: 'b', tokens: 300 });
    probe.record({ agentId: 'c', tokens: 200 });

    const summary = probe.summary();
    assert.strictEqual(summary.totalTokens, 600);
    assert.strictEqual(summary.budget, 1000);
    assert.strictEqual(summary.remaining, 400);
    assert.strictEqual(summary.pct, 60);
    assert.strictEqual(summary.agents.length, 3);
    assert.strictEqual(summary.agents[0].agentId, 'b'); // Highest usage first
    assert.strictEqual(summary.agents[1].agentId, 'c');
    assert.strictEqual(summary.agents[2].agentId, 'a');
  });

  test('summary with no budget shows infinity remaining', () => {
    const probe = new QuotaProbe({ budget: 0 });
    probe.record({ agentId: 'a', tokens: 100 });

    const summary = probe.summary();
    assert.strictEqual(summary.remaining, Infinity);
    assert.strictEqual(summary.pct, 0);
  });

  test('reset clears all state', () => {
    const probe = new QuotaProbe({ budget: 100 });
    probe.record({ agentId: 'a', tokens: 50 });

    assert.strictEqual(probe.totalTokens, 50);
    assert.ok(probe.agentUsage('a'));

    probe.reset();

    assert.strictEqual(probe.totalTokens, 0);
    assert.strictEqual(probe.agentUsage('a'), null);
    assert.strictEqual(probe.summary().agents.length, 0);
  });

  test('setBudget updates and resets warning', () => {
    const probe = new QuotaProbe({ budget: 100, warningThreshold: 0.8 });
    probe.record({ agentId: 'a', tokens: 85 }); // Triggers warning

    const warnings = [];
    probe.on('budget_warning', e => warnings.push(e));

    // Increase budget so we're below threshold again
    probe.setBudget(200);

    // Recording more should trigger warning again at new threshold (160)
    probe.record({ agentId: 'a', tokens: 80 }); // Total 165, above 80% of 200
    assert.strictEqual(warnings.length, 1);
  });

  test('fallback to output estimation when method is duration but no durationMs', () => {
    const probe = new QuotaProbe({ estimationMethod: 'duration' });

    probe.record({
      agentId: 'a',
      output: 'x'.repeat(80), // 80 chars = 20 tokens at 4 chars/token
      // No durationMs provided
    });

    assert.strictEqual(probe.totalTokens, 20);
  });
});

describe('attachQuotaProbe', () => {
  test('wires probe to supervisor done events', () => {
    const probe = new QuotaProbe();
    const supervisor = new EventEmitter();
    supervisor.processTable = new Map();
    supervisor.tokensUsed = 0;
    supervisor._log = () => {};
    supervisor._spawnDaemon = () => {};

    // Create a mock daemon
    const daemon = new EventEmitter();
    daemon.agentId = 'agent-1';
    supervisor.processTable.set('agent-1', { daemon });

    attachQuotaProbe(supervisor, probe);

    // Simulate task lifecycle
    daemon.emit('promoted', { agentId: 'agent-1', pid: 123 });

    // Wait a tiny bit for "duration"
    daemon.emit('done', {
      agentId: 'agent-1',
      output: 'x'.repeat(200), // 50 tokens
    });

    assert.strictEqual(probe.totalTokens, 50);
    assert.strictEqual(supervisor.tokensUsed, 50);
  });

  test('wires probe to supervisor fail events', () => {
    const probe = new QuotaProbe();
    const supervisor = new EventEmitter();
    supervisor.processTable = new Map();
    supervisor.tokensUsed = 0;
    supervisor._log = () => {};
    supervisor._spawnDaemon = () => {};

    const daemon = new EventEmitter();
    supervisor.processTable.set('agent-1', { daemon });

    attachQuotaProbe(supervisor, probe);

    daemon.emit('promoted', { agentId: 'agent-1' });
    daemon.emit('fail', {
      agentId: 'agent-1',
      output: 'x'.repeat(100), // 25 tokens
    });

    assert.strictEqual(probe.totalTokens, 25);
    assert.strictEqual(supervisor.tokensUsed, 25);
  });

  test('budget_exhausted pauses supervisor promotions', () => {
    const probe = new QuotaProbe({ budget: 100 });
    const supervisor = new EventEmitter();
    supervisor.processTable = new Map();
    supervisor.tokensUsed = 0;
    supervisor.promotionsPaused = false;
    supervisor._log = () => {};
    supervisor._spawnDaemon = () => {};

    const daemon = new EventEmitter();
    supervisor.processTable.set('agent-1', { daemon });

    attachQuotaProbe(supervisor, probe);

    daemon.emit('done', {
      agentId: 'agent-1',
      tokens: 100,
    });

    assert.strictEqual(supervisor.promotionsPaused, true);
  });
});
