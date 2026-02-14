/**
 * Logger Tests
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Logger, attachLogger } from './logger.js';
import { EventEmitter } from 'events';

const tmpBase = path.join(os.tmpdir(), `logger-test-${Date.now()}`);

function makeLogger(overrides = {}) {
  const id = Math.random().toString(36).slice(2, 8);
  const dir = path.join(tmpBase, `logs-${id}`);
  return new Logger({
    dir,
    filename: 'test.log',
    maxSizeBytes: 1024, // Small for testing rotation
    maxFiles: 3,
    ...overrides,
  });
}

describe('Logger', () => {
  before(() => {
    fs.mkdirSync(tmpBase, { recursive: true });
  });

  after(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  test('constructor requires dir', () => {
    assert.throws(() => new Logger({}), /requires dir/);
  });

  test('constructor sets defaults', () => {
    const logger = new Logger({ dir: '/tmp/test' });
    assert.strictEqual(logger.filename, 'swarm.log');
    assert.strictEqual(logger.maxSizeBytes, 10 * 1024 * 1024);
    assert.strictEqual(logger.maxFiles, 5);
    assert.strictEqual(logger.stdout, false);
  });

  test('open creates directory and file', () => {
    const logger = makeLogger();
    logger.open();
    assert.ok(fs.existsSync(logger.dir));
    logger.write('test', { msg: 'hello' });
    assert.ok(fs.existsSync(logger.logPath));
    logger.close();
  });

  test('write produces valid NDJSON', () => {
    const logger = makeLogger();
    logger.open();

    logger.write('event_a', { key: 'value1' });
    logger.write('event_b', { key: 'value2' });

    const entries = logger.read();
    assert.strictEqual(entries.length, 2);
    assert.strictEqual(entries[0].event, 'event_a');
    assert.strictEqual(entries[0].key, 'value1');
    assert.ok(entries[0].ts);
    assert.strictEqual(entries[1].event, 'event_b');

    logger.close();
  });

  test('writeEntry writes pre-formed entries', () => {
    const logger = makeLogger();
    logger.open();

    logger.writeEntry({ ts: '2026-01-01T00:00:00Z', event: 'custom', data: 42 });

    const entries = logger.read();
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].ts, '2026-01-01T00:00:00Z');
    assert.strictEqual(entries[0].data, 42);

    logger.close();
  });

  test('read with limit returns last N entries', () => {
    const logger = makeLogger();
    logger.open();

    for (let i = 0; i < 10; i++) {
      logger.write('entry', { i });
    }

    const last3 = logger.read(3);
    assert.strictEqual(last3.length, 3);
    assert.strictEqual(last3[0].i, 7);
    assert.strictEqual(last3[2].i, 9);

    logger.close();
  });

  test('read returns empty array for missing file', () => {
    const logger = makeLogger();
    // Don't open — file doesn't exist
    const entries = logger.read();
    assert.deepStrictEqual(entries, []);
  });

  test('size tracks current file size', () => {
    const logger = makeLogger();
    logger.open();
    assert.strictEqual(logger.size, 0);

    logger.write('test', { data: 'hello' });
    assert.ok(logger.size > 0);

    const sizeBefore = logger.size;
    logger.write('test2', { data: 'world' });
    assert.ok(logger.size > sizeBefore);

    logger.close();
  });

  test('rotation creates numbered files', () => {
    const logger = makeLogger({ maxSizeBytes: 100 }); // Very small — rotates quickly
    logger.open();

    // Write enough to trigger multiple rotations
    for (let i = 0; i < 20; i++) {
      logger.write('fill', { i, padding: 'x'.repeat(30) });
    }

    const files = logger.listFiles();
    assert.ok(files.length > 1, `Expected rotated files, got: ${files}`);
    assert.ok(fs.existsSync(files[0])); // Current file

    logger.close();
  });

  test('rotation respects maxFiles limit', () => {
    const logger = makeLogger({ maxSizeBytes: 80, maxFiles: 2 });
    logger.open();

    // Write a lot to trigger many rotations
    for (let i = 0; i < 50; i++) {
      logger.write('fill', { i, pad: 'x'.repeat(20) });
    }

    // Should have at most current + 2 rotated files
    const files = logger.listFiles();
    assert.ok(files.length <= 3, `Expected max 3 files (current + 2 rotated), got ${files.length}`);

    logger.close();
  });

  test('rotation preserves data across files', () => {
    const logger = makeLogger({ maxSizeBytes: 100 });
    logger.open();

    // Write entries that will span multiple files
    const written = [];
    for (let i = 0; i < 10; i++) {
      const entry = { i, data: `entry-${i}` };
      logger.write('test', entry);
      written.push(i);
    }

    // Current file should have the most recent entries
    const current = logger.read();
    assert.ok(current.length > 0);
    assert.ok(current.every(e => e.event === 'test'));

    logger.close();
  });

  test('close is safe to call multiple times', () => {
    const logger = makeLogger();
    logger.open();
    logger.close();
    logger.close(); // Should not throw
  });

  test('close without open is safe', () => {
    const logger = makeLogger();
    logger.close(); // Should not throw
  });

  test('listFiles returns only existing files', () => {
    const logger = makeLogger();
    logger.open();
    logger.write('test', {});

    const files = logger.listFiles();
    assert.strictEqual(files.length, 1);
    assert.strictEqual(files[0], logger.logPath);

    logger.close();
  });

  test('logPath returns correct path', () => {
    const logger = makeLogger();
    assert.ok(logger.logPath.endsWith('test.log'));
    assert.ok(logger.logPath.includes(logger.dir));
  });
});

describe('attachLogger', () => {
  test('wires supervisor log events to logger', () => {
    const logger = makeLogger();
    logger.open();

    // Mock supervisor with EventEmitter
    const supervisor = new EventEmitter();

    attachLogger(supervisor, logger);

    // Emit log events like supervisor does
    supervisor.emit('log', { ts: new Date().toISOString(), event: 'swarm_started', count: 3 });
    supervisor.emit('log', { ts: new Date().toISOString(), event: 'agent_promoted', agentId: 'test' });

    const entries = logger.read();
    assert.strictEqual(entries.length, 2);
    assert.strictEqual(entries[0].event, 'swarm_started');
    assert.strictEqual(entries[0].count, 3);
    assert.strictEqual(entries[1].event, 'agent_promoted');

    logger.close();
  });
});
