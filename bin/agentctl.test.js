/**
 * CLI Tests
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { parseArgs } from './agentctl.js';

const exec = promisify(execFile);
const CLI = path.join(import.meta.dirname, 'agentctl.js');
const tmpBase = path.join(os.tmpdir(), `agentctl-test-${Date.now()}`);

describe('parseArgs', () => {
  test('parses command', () => {
    const result = parseArgs(['node', 'agentctl', 'start']);
    assert.strictEqual(result.command, 'start');
  });

  test('parses long flags', () => {
    const result = parseArgs(['node', 'agentctl', 'start', '--count', '5', '--role', 'auditor']);
    assert.strictEqual(result.flags.count, '5');
    assert.strictEqual(result.flags.role, 'auditor');
  });

  test('parses short flags', () => {
    const result = parseArgs(['node', 'agentctl', 'start', '-n', '3', '-r', 'builder']);
    assert.strictEqual(result.flags.count, '3');
    assert.strictEqual(result.flags.role, 'builder');
  });

  test('parses boolean flags', () => {
    const result = parseArgs(['node', 'agentctl', 'start', '--persist', '--verbose']);
    assert.strictEqual(result.flags.persist, true);
    assert.strictEqual(result.flags.verbose, true);
  });

  test('parses positional args', () => {
    const result = parseArgs(['node', 'agentctl', 'assign', 'agent-123', 'build', 'the', 'auth']);
    assert.strictEqual(result.command, 'assign');
    assert.deepStrictEqual(result.positional, ['agent-123', 'build', 'the', 'auth']);
  });

  test('defaults to help when no command', () => {
    const result = parseArgs(['node', 'agentctl']);
    assert.strictEqual(result.command, 'help');
  });

  test('parses server flag', () => {
    const result = parseArgs(['node', 'agentctl', 'start', '-s', 'wss://example.com']);
    assert.strictEqual(result.flags.server, 'wss://example.com');
  });

  test('parses channels', () => {
    const result = parseArgs(['node', 'agentctl', 'start', '-c', '#agents,#work']);
    assert.strictEqual(result.flags.channels, '#agents,#work');
  });
});

describe('CLI commands', () => {
  before(() => {
    fs.mkdirSync(tmpBase, { recursive: true });
  });

  after(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  test('help outputs usage', async () => {
    const { stdout } = await exec('node', [CLI, 'help']);
    assert.ok(stdout.includes('agentctl'));
    assert.ok(stdout.includes('Commands:'));
    assert.ok(stdout.includes('start'));
    assert.ok(stdout.includes('scale'));
  });

  test('--help flag works', async () => {
    const { stdout } = await exec('node', [CLI, '--help']);
    assert.ok(stdout.includes('agentctl'));
  });

  test('unknown command exits with error', async () => {
    try {
      await exec('node', [CLI, 'nosuchcommand']);
      assert.fail('Should have exited with error');
    } catch (err) {
      assert.ok(err.stderr.includes('Unknown command'));
    }
  });

  test('stop outputs instructions', async () => {
    const { stdout } = await exec('node', [CLI, 'stop']);
    assert.ok(stdout.includes('SIGTERM') || stdout.includes('SIGINT'));
  });

  test('scale without number shows usage', async () => {
    try {
      await exec('node', [CLI, 'scale']);
      assert.fail('Should have exited with error');
    } catch (err) {
      assert.ok(err.stderr.includes('Usage'));
    }
  });

  test('assign without args shows usage', async () => {
    try {
      await exec('node', [CLI, 'assign']);
      assert.fail('Should have exited with error');
    } catch (err) {
      assert.ok(err.stderr.includes('Usage'));
    }
  });

  test('broadcast without prompt shows usage', async () => {
    try {
      await exec('node', [CLI, 'broadcast']);
      assert.fail('Should have exited with error');
    } catch (err) {
      assert.ok(err.stderr.includes('Usage'));
    }
  });

  test('start without server uses local bus', async () => {
    const basePath = path.join(tmpBase, 'start-test');
    const proc = spawn('node', [
      CLI, 'start',
      '--count', '1',
      '--base-path', basePath,
      '--heartbeat-interval', '500',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    proc.stdout.on('data', d => stdout += d.toString());

    // Wait for startup
    await new Promise(r => setTimeout(r, 2000));

    // Send SIGTERM for graceful stop
    proc.kill('SIGTERM');

    // Wait for exit
    await new Promise((resolve) => {
      proc.on('close', resolve);
      setTimeout(resolve, 3000); // Fallback timeout
    });

    assert.ok(
      stdout.includes('local EventEmitterBus') || stdout.includes('Swarm started'),
      `Expected startup output, got: ${stdout.slice(0, 200)}`
    );
  });
});
