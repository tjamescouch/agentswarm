/**
 * MessageBus Tests
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'events';
import { MessageBus, EventEmitterBus, AgentChatBus } from './message-bus.js';

describe('MessageBus base class', () => {
  test('throws on unimplemented methods', async () => {
    const bus = new MessageBus();
    await assert.rejects(() => bus.connect(), /must be implemented/);
    await assert.rejects(() => bus.join('#test'), /must be implemented/);
    await assert.rejects(() => bus.send('#test', 'hi'), /must be implemented/);
    await assert.rejects(() => bus.disconnect(), /must be implemented/);
  });

  test('initializes with default state', () => {
    const bus = new MessageBus();
    assert.strictEqual(bus.connected, false);
    assert.strictEqual(bus.agentId, null);
    assert.strictEqual(bus.channels.size, 0);
  });
});

describe('EventEmitterBus', () => {
  test('connect sets connected and returns agentId', async () => {
    const bus = new EventEmitterBus({ agentId: 'test-001' });
    const result = await bus.connect();
    assert.strictEqual(result.agentId, 'test-001');
    assert.strictEqual(bus.connected, true);
    await bus.disconnect();
  });

  test('generates random agentId if not provided', async () => {
    const bus = new EventEmitterBus();
    const result = await bus.connect();
    assert.ok(result.agentId.startsWith('local-'));
    assert.ok(result.agentId.length > 6);
    await bus.disconnect();
  });

  test('join adds channel to set', async () => {
    const bus = new EventEmitterBus();
    await bus.connect();
    await bus.join('#agents');
    await bus.join('#general');
    assert.ok(bus.channels.has('#agents'));
    assert.ok(bus.channels.has('#general'));
    await bus.disconnect();
  });

  test('disconnect clears state', async () => {
    const bus = new EventEmitterBus();
    await bus.connect();
    await bus.join('#agents');
    assert.strictEqual(bus.connected, true);
    assert.strictEqual(bus.channels.size, 1);

    await bus.disconnect();
    assert.strictEqual(bus.connected, false);
    assert.strictEqual(bus.channels.size, 0);
  });

  test('send throws when not connected', async () => {
    const bus = new EventEmitterBus();
    await assert.rejects(() => bus.send('#test', 'hi'), /Not connected/);
  });

  test('messages route between buses via shared hub', async () => {
    const hub = new EventEmitter();
    const bus1 = new EventEmitterBus({ hub, agentId: 'agent-1' });
    const bus2 = new EventEmitterBus({ hub, agentId: 'agent-2' });

    await bus1.connect();
    await bus2.connect();
    await bus1.join('#work');
    await bus2.join('#work');

    const received = [];
    bus2.on('message', (msg) => received.push(msg));

    await bus1.send('#work', 'hello from agent-1');

    assert.strictEqual(received.length, 1);
    assert.strictEqual(received[0].content, 'hello from agent-1');
    assert.strictEqual(received[0].from, 'agent-1');
    assert.strictEqual(received[0].to, '#work');

    await bus1.disconnect();
    await bus2.disconnect();
  });

  test('sender does not receive own messages', async () => {
    const hub = new EventEmitter();
    const bus = new EventEmitterBus({ hub, agentId: 'agent-1' });

    await bus.connect();
    await bus.join('#work');

    const received = [];
    bus.on('message', (msg) => received.push(msg));

    await bus.send('#work', 'echo test');

    assert.strictEqual(received.length, 0);
    await bus.disconnect();
  });

  test('messages only delivered to joined channels', async () => {
    const hub = new EventEmitter();
    const bus1 = new EventEmitterBus({ hub, agentId: 'agent-1' });
    const bus2 = new EventEmitterBus({ hub, agentId: 'agent-2' });

    await bus1.connect();
    await bus2.connect();
    await bus1.join('#work');
    // bus2 does NOT join #work

    const received = [];
    bus2.on('message', (msg) => received.push(msg));

    await bus1.send('#work', 'should not arrive');

    assert.strictEqual(received.length, 0);

    await bus1.disconnect();
    await bus2.disconnect();
  });

  test('direct messages route to target agent', async () => {
    const hub = new EventEmitter();
    const bus1 = new EventEmitterBus({ hub, agentId: 'agent-1' });
    const bus2 = new EventEmitterBus({ hub, agentId: 'agent-2' });

    await bus1.connect();
    await bus2.connect();

    const received = [];
    bus2.on('message', (msg) => received.push(msg));

    await bus1.send('@agent-2', 'direct message');

    assert.strictEqual(received.length, 1);
    assert.strictEqual(received[0].content, 'direct message');
    assert.strictEqual(received[0].to, '@agent-2');

    await bus1.disconnect();
    await bus2.disconnect();
  });

  test('direct messages do not leak to other agents', async () => {
    const hub = new EventEmitter();
    const bus1 = new EventEmitterBus({ hub, agentId: 'agent-1' });
    const bus2 = new EventEmitterBus({ hub, agentId: 'agent-2' });
    const bus3 = new EventEmitterBus({ hub, agentId: 'agent-3' });

    await bus1.connect();
    await bus2.connect();
    await bus3.connect();

    const received3 = [];
    bus3.on('message', (msg) => received3.push(msg));

    await bus1.send('@agent-2', 'private');

    assert.strictEqual(received3.length, 0);

    await bus1.disconnect();
    await bus2.disconnect();
    await bus3.disconnect();
  });

  test('multiple channels work independently', async () => {
    const hub = new EventEmitter();
    const bus1 = new EventEmitterBus({ hub, agentId: 'agent-1' });
    const bus2 = new EventEmitterBus({ hub, agentId: 'agent-2' });

    await bus1.connect();
    await bus2.connect();
    await bus1.join('#work');
    await bus1.join('#chat');
    await bus2.join('#work');
    // bus2 NOT in #chat

    const received = [];
    bus2.on('message', (msg) => received.push(msg));

    await bus1.send('#work', 'work msg');
    await bus1.send('#chat', 'chat msg');

    assert.strictEqual(received.length, 1);
    assert.strictEqual(received[0].content, 'work msg');

    await bus1.disconnect();
    await bus2.disconnect();
  });

  test('message has correct shape', async () => {
    const hub = new EventEmitter();
    const bus1 = new EventEmitterBus({ hub, agentId: 'sender' });
    const bus2 = new EventEmitterBus({ hub, agentId: 'receiver' });

    await bus1.connect();
    await bus2.connect();
    await bus1.join('#test');
    await bus2.join('#test');

    const received = [];
    bus2.on('message', (msg) => received.push(msg));

    await bus1.send('#test', 'payload');

    const msg = received[0];
    assert.strictEqual(msg.type, 'MSG');
    assert.strictEqual(msg.from, 'sender');
    assert.strictEqual(msg.to, '#test');
    assert.strictEqual(msg.content, 'payload');
    assert.ok(typeof msg.ts === 'number');

    await bus1.disconnect();
    await bus2.disconnect();
  });
});

describe('AgentChatBus', () => {
  test('constructor requires server URL', () => {
    assert.throws(() => new AgentChatBus({}), /requires server URL/);
  });

  test('constructor accepts server URL', () => {
    const bus = new AgentChatBus({ server: 'wss://example.com' });
    assert.strictEqual(bus.server, 'wss://example.com');
    assert.strictEqual(bus.connected, false);
  });

  test('connect fails gracefully without agentchat client', async () => {
    const bus = new AgentChatBus({
      server: 'wss://example.com',
      clientModule: './nonexistent-module.js',
    });
    await assert.rejects(() => bus.connect(), /Failed to load AgentChatClient/);
  });

  test('join/send throw when not connected', async () => {
    const bus = new AgentChatBus({ server: 'wss://example.com' });
    await assert.rejects(() => bus.join('#test'), /Not connected/);
    await assert.rejects(() => bus.send('#test', 'hi'), /Not connected/);
  });

  test('disconnect when not connected is safe', async () => {
    const bus = new AgentChatBus({ server: 'wss://example.com' });
    await bus.disconnect(); // Should not throw
    assert.strictEqual(bus.connected, false);
  });
});

describe('EventEmitterBus task routing', () => {
  test('structured TASK_AVAILABLE messages flow through', async () => {
    const hub = new EventEmitter();
    const coordinator = new EventEmitterBus({ hub, agentId: 'coordinator' });
    const worker = new EventEmitterBus({ hub, agentId: 'worker-1' });

    await coordinator.connect();
    await worker.connect();
    await coordinator.join('#agents');
    await worker.join('#agents');

    const received = [];
    worker.on('message', (msg) => received.push(msg));

    const taskPayload = JSON.stringify({
      type: 'TASK_AVAILABLE',
      task: { role: 'builder', component: 'auth', prompt: 'Build auth system' },
    });

    await coordinator.send('#agents', taskPayload);

    assert.strictEqual(received.length, 1);
    const parsed = JSON.parse(received[0].content);
    assert.strictEqual(parsed.type, 'TASK_AVAILABLE');
    assert.strictEqual(parsed.task.component, 'auth');

    await coordinator.disconnect();
    await worker.disconnect();
  });

  test('structured ASSIGN messages flow through', async () => {
    const hub = new EventEmitter();
    const coordinator = new EventEmitterBus({ hub, agentId: 'coordinator' });
    const worker = new EventEmitterBus({ hub, agentId: 'worker-1' });

    await coordinator.connect();
    await worker.connect();
    await coordinator.join('#agents');
    await worker.join('#agents');

    const received = [];
    worker.on('message', (msg) => received.push(msg));

    const assignPayload = JSON.stringify({
      type: 'ASSIGN',
      agentId: 'worker-1',
      task: { component: 'auth', prompt: 'Build auth' },
    });

    await coordinator.send('#agents', assignPayload);

    assert.strictEqual(received.length, 1);
    const parsed = JSON.parse(received[0].content);
    assert.strictEqual(parsed.type, 'ASSIGN');
    assert.strictEqual(parsed.agentId, 'worker-1');

    await coordinator.disconnect();
    await worker.disconnect();
  });

  test('CLAIM responses flow back', async () => {
    const hub = new EventEmitter();
    const coordinator = new EventEmitterBus({ hub, agentId: 'coordinator' });
    const worker = new EventEmitterBus({ hub, agentId: 'worker-1' });

    await coordinator.connect();
    await worker.connect();
    await coordinator.join('#agents');
    await worker.join('#agents');

    const received = [];
    coordinator.on('message', (msg) => received.push(msg));

    await worker.send('#agents', JSON.stringify({
      type: 'CLAIM',
      agentId: 'worker-1',
      component: 'auth',
      role: 'builder',
    }));

    assert.strictEqual(received.length, 1);
    const parsed = JSON.parse(received[0].content);
    assert.strictEqual(parsed.type, 'CLAIM');

    await coordinator.disconnect();
    await worker.disconnect();
  });
});
