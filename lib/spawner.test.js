/**
 * Spawner Tests
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Spawner, generateIdentity, DEFAULT_GITIGNORE, buildClaudeMd } from './spawner.js';

const tmpBase = path.join(os.tmpdir(), `spawner-test-${Date.now()}`);

describe('generateIdentity', () => {
  test('returns Ed25519 keypair with agentId', () => {
    const id = generateIdentity('test-agent');
    assert.ok(id.publicKey.includes('BEGIN PUBLIC KEY'));
    assert.ok(id.privateKey.includes('BEGIN PRIVATE KEY'));
    assert.strictEqual(id.agentId.length, 8);
    assert.strictEqual(id.name, 'test-agent');
    assert.ok(id.created);
  });

  test('generates unique IDs', () => {
    const a = generateIdentity('a');
    const b = generateIdentity('b');
    assert.notStrictEqual(a.agentId, b.agentId);
    assert.notStrictEqual(a.publicKey, b.publicKey);
  });
});

describe('buildClaudeMd', () => {
  test('includes role and channels', () => {
    const md = buildClaudeMd({
      role: 'builder',
      agentId: 'abc12345',
      channels: ['#agents', '#general'],
    });
    assert.ok(md.includes('builder'));
    assert.ok(md.includes('@abc12345'));
    assert.ok(md.includes('#agents, #general'));
  });

  test('includes extra instructions when provided', () => {
    const md = buildClaudeMd({
      role: 'builder',
      agentId: 'abc12345',
      channels: ['#agents'],
      extraInstructions: 'Focus on the spawner component.',
    });
    assert.ok(md.includes('Focus on the spawner component.'));
    assert.ok(md.includes('Additional Instructions'));
  });
});

describe('Spawner', () => {
  let spawner;

  before(() => {
    fs.mkdirSync(tmpBase, { recursive: true });
    spawner = new Spawner({ basePath: tmpBase });
  });

  after(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  test('spawn creates workspace with correct structure', () => {
    const result = spawner.spawn({ name: 'swarm-builder-001' });

    assert.ok(result.workspace);
    assert.ok(result.agentId);
    assert.ok(result.identity);

    // .gitignore exists (written first per invariant)
    assert.ok(fs.existsSync(path.join(result.workspace, '.gitignore')));
    const gitignore = fs.readFileSync(path.join(result.workspace, '.gitignore'), 'utf8');
    assert.ok(gitignore.includes('*.key'));
    assert.ok(gitignore.includes('.env'));

    // git repo initialized
    assert.ok(fs.existsSync(path.join(result.workspace, '.git')));

    // identity file
    const identityPath = path.join(result.workspace, '.agentchat', 'identities', 'swarm-builder-001.json');
    assert.ok(fs.existsSync(identityPath));
    const identity = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
    assert.ok(identity.publicKey);
    assert.ok(identity.privateKey);
    assert.strictEqual(identity.name, 'swarm-builder-001');

    // CLAUDE.md
    assert.ok(fs.existsSync(path.join(result.workspace, 'CLAUDE.md')));
    const claudeMd = fs.readFileSync(path.join(result.workspace, 'CLAUDE.md'), 'utf8');
    assert.ok(claudeMd.includes('builder'));
    assert.ok(claudeMd.includes('#agents'));

    // context.md
    assert.ok(fs.existsSync(path.join(result.workspace, 'context.md')));
  });

  test('spawn rejects duplicate workspace', () => {
    assert.throws(
      () => spawner.spawn({ name: 'swarm-builder-001' }),
      /already exists/
    );
  });

  test('spawn requires name', () => {
    assert.throws(
      () => spawner.spawn({}),
      /requires a name/
    );
  });

  test('spawn with custom role and channels', () => {
    const result = spawner.spawn({
      name: 'swarm-auditor-001',
      role: 'auditor',
      channels: ['#agents', '#discovery'],
    });

    const claudeMd = fs.readFileSync(path.join(result.workspace, 'CLAUDE.md'), 'utf8');
    assert.ok(claudeMd.includes('auditor'));
    assert.ok(claudeMd.includes('#agents, #discovery'));
  });

  test('spawn with custom context', () => {
    const result = spawner.spawn({
      name: 'swarm-builder-002',
      context: '# My Context\n\nPrevious session data here.\n',
    });

    const contextMd = fs.readFileSync(path.join(result.workspace, 'context.md'), 'utf8');
    assert.ok(contextMd.includes('Previous session data here.'));
  });

  test('list tracks all spawned workspaces', () => {
    const entries = spawner.list();
    assert.ok(entries.length >= 3);
    assert.ok(entries.every(e => e.exists));
    assert.ok(entries.every(e => e.agentId && e.workspace));
  });

  test('teardown requires confirmation', () => {
    const entries = spawner.list();
    const first = entries[0];
    const result = spawner.teardown(first.agentId);
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('confirmation'));
    // Workspace should still exist
    assert.ok(fs.existsSync(first.workspace));
  });

  test('teardown with confirmation removes workspace', () => {
    const entries = spawner.list();
    const first = entries[0];
    const result = spawner.teardown(first.agentId, { confirm: true });
    assert.strictEqual(result.success, true);
    assert.ok(!fs.existsSync(first.workspace));
  });

  test('teardown unknown agent returns error', () => {
    const result = spawner.teardown('nonexistent', { confirm: true });
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('Unknown'));
  });

  test('workspaces are independent — no shared state', () => {
    const a = spawner.spawn({ name: 'independent-a' });
    const b = spawner.spawn({ name: 'independent-b' });

    // Different directories
    assert.notStrictEqual(a.workspace, b.workspace);
    // Different identities
    assert.notStrictEqual(a.agentId, b.agentId);

    // Writing to one doesn't affect the other
    fs.writeFileSync(path.join(a.workspace, 'test.txt'), 'a-data');
    assert.ok(!fs.existsSync(path.join(b.workspace, 'test.txt')));
  });
});
