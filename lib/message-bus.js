/**
 * MessageBus — abstraction over the communication transport.
 *
 * Two implementations:
 *   EventEmitterBus  — in-process, for testing
 *   AgentChatBus     — real WebSocket via agentchat client
 */

import { EventEmitter } from 'events';

// ============ Base class ============

/**
 * MessageBus base class.
 * Subclasses must implement: connect(), join(), send(), disconnect().
 * Emits 'message' events for incoming messages.
 */
export class MessageBus extends EventEmitter {
  constructor() {
    super();
    this.connected = false;
    this.channels = new Set();
    this.agentId = null;
  }

  /**
   * Connect to the transport.
   * @returns {Promise<{ agentId: string }>}
   */
  async connect() {
    throw new Error('MessageBus.connect() must be implemented');
  }

  /**
   * Join a channel.
   * @param {string} channel
   * @returns {Promise<void>}
   */
  async join(channel) {
    throw new Error('MessageBus.join() must be implemented');
  }

  /**
   * Send a message to a channel or agent.
   * @param {string} target — "#channel" or "@agentId"
   * @param {string} content
   * @returns {Promise<void>}
   */
  async send(target, content) {
    throw new Error('MessageBus.send() must be implemented');
  }

  /**
   * Disconnect from the transport.
   * @returns {Promise<void>}
   */
  async disconnect() {
    throw new Error('MessageBus.disconnect() must be implemented');
  }
}

// ============ EventEmitterBus ============

/**
 * In-process message bus for testing.
 * Messages sent via send() are delivered to all subscribers' 'message' handlers.
 * Multiple bus instances sharing the same hub simulate multi-agent communication.
 */
export class EventEmitterBus extends MessageBus {
  /**
   * @param {object} [opts]
   * @param {EventEmitter} [opts.hub] — shared hub for multi-bus testing
   * @param {string} [opts.agentId] — agent ID to use
   */
  constructor(opts = {}) {
    super();
    this._hub = opts.hub || new EventEmitter();
    this.agentId = opts.agentId || `local-${Math.random().toString(36).slice(2, 8)}`;
    this._hubListener = null;
  }

  async connect() {
    this.connected = true;

    // Listen to hub for messages directed at our channels or agent
    this._hubListener = (msg) => {
      const target = msg.to || '';
      if (target.startsWith('#') && this.channels.has(target)) {
        // Don't echo our own messages back
        if (msg.from !== this.agentId) {
          this.emit('message', msg);
        }
      } else if (target === `@${this.agentId}`) {
        this.emit('message', msg);
      }
    };
    this._hub.on('bus-message', this._hubListener);

    return { agentId: this.agentId };
  }

  async join(channel) {
    this.channels.add(channel);
  }

  async send(target, content) {
    if (!this.connected) throw new Error('Not connected');

    const msg = {
      type: 'MSG',
      from: this.agentId,
      to: target,
      content,
      ts: Date.now(),
    };

    this._hub.emit('bus-message', msg);
  }

  async disconnect() {
    if (this._hubListener) {
      this._hub.removeListener('bus-message', this._hubListener);
      this._hubListener = null;
    }
    this.connected = false;
    this.channels.clear();
  }
}

// ============ AgentChatBus ============

/**
 * Real WebSocket bus via agentchat client.
 * Connects to an agentchat server, joins channels, routes messages.
 */
export class AgentChatBus extends MessageBus {
  /**
   * @param {object} opts
   * @param {string} opts.server — WebSocket URL (e.g. "wss://agentchat-server.fly.dev")
   * @param {string} [opts.identity] — path to agentchat identity JSON file
   * @param {string} [opts.name] — agent name
   * @param {string} [opts.clientModule] — path to agentchat client module (for import)
   */
  constructor(opts) {
    super();

    if (!opts.server) throw new Error('AgentChatBus requires server URL');

    this.server = opts.server;
    this.identityPath = opts.identity || null;
    this.name = opts.name || null;
    this.clientModule = opts.clientModule || null;

    this._client = null;
  }

  async connect() {
    // Dynamic import of AgentChatClient
    let AgentChatClient;
    try {
      if (this.clientModule) {
        const mod = await import(this.clientModule);
        AgentChatClient = mod.AgentChatClient;
      } else {
        // Try @tjamescouch/agentchat package first, fall back to relative path
        try {
          const mod = await import('@tjamescouch/agentchat');
          AgentChatClient = mod.AgentChatClient;
        } catch {
          // Fall back to relative path to sibling agentchat repo
          const mod = await import('../../agentchat/dist/lib/client.js');
          AgentChatClient = mod.AgentChatClient;
        }
      }
    } catch (err) {
      throw new Error(`Failed to load AgentChatClient: ${err.message}. Install @tjamescouch/agentchat or set clientModule option.`);
    }

    const clientOpts = {
      server: this.server,
    };
    if (this.name) clientOpts.name = this.name;
    if (this.identityPath) clientOpts.identity = this.identityPath;

    this._client = new AgentChatClient(clientOpts);

    // Wire up message routing
    this._client.on('message', (msg) => {
      this.emit('message', {
        type: msg.type || 'MSG',
        from: msg.from,
        to: msg.to,
        content: msg.content,
        ts: msg.ts,
      });
    });

    this._client.on('disconnect', () => {
      this.connected = false;
      this.emit('disconnect');
    });

    this._client.on('error', (err) => {
      this.emit('error', err);
    });

    // Enable auto-verification for identity challenges
    this._client.enableAutoVerification(true);

    const welcome = await this._client.connect();
    this.agentId = welcome.agent_id;
    this.connected = true;

    return { agentId: this.agentId };
  }

  async join(channel) {
    if (!this._client || !this.connected) throw new Error('Not connected');
    await this._client.join(channel);
    this.channels.add(channel);
  }

  async send(target, content) {
    if (!this._client || !this.connected) throw new Error('Not connected');
    await this._client.send(target, content);
  }

  async disconnect() {
    if (this._client) {
      this._client.disconnect();
      this._client = null;
    }
    this.connected = false;
    this.channels.clear();
  }
}
