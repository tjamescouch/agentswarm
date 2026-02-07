/**
 * Supervisor
 * Top-level process that manages the swarm.
 * One supervisor per machine, enforced via pidfile.
 */

import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { Spawner } from './spawner.js';
import { HealthMonitor } from './health-monitor.js';
import { Daemon, DaemonState } from './daemon.js';

const DEFAULT_PIDFILE = path.join(process.env.HOME || '.', '.agentctl', 'swarm.pid');
const DEFAULT_LOGDIR = path.join(process.env.HOME || '.', '.agentctl', 'logs');

/**
 * @typedef {object} SwarmConfig
 * @property {number} [count] - number of daemons to spawn (default: 3)
 * @property {number} [maxActive] - max concurrent promoted agents (default: 5)
 * @property {string} [basePath] - workspace base directory
 * @property {string} [role] - default agent role (default: 'builder')
 * @property {string[]} [channels] - agentchat channels (default: ['#agents'])
 * @property {string} [repo] - git repo to clone into workspaces
 * @property {number} [tokenBudget] - total token budget (default: 0 = unlimited)
 * @property {number} [heartbeatIntervalMs] - heartbeat interval (default: 30000)
 * @property {number} [maxTaskDurationMs] - max task duration before kill (default: 1800000 = 30m)
 * @property {boolean} [persist] - keep workspaces on shutdown (default: false)
 * @property {string} [pidfile] - pidfile path
 * @property {string} [logDir] - log directory
 * @property {number} [shutdownTimeoutMs] - time to wait for clean exits (default: 10000)
 */

export class Supervisor extends EventEmitter {
  /**
   * @param {SwarmConfig} [config]
   */
  constructor(config = {}) {
    super();

    this.count = config.count || 3;
    this.maxActive = config.maxActive || 5;
    this.role = config.role || 'builder';
    this.channels = config.channels || ['#agents'];
    this.repo = config.repo || null;
    this.tokenBudget = config.tokenBudget || 0;
    this.tokensUsed = 0;
    this.heartbeatIntervalMs = config.heartbeatIntervalMs || 30000;
    this.maxTaskDurationMs = config.maxTaskDurationMs || 30 * 60 * 1000;
    this.persist = config.persist || false;
    this.pidfile = config.pidfile || DEFAULT_PIDFILE;
    this.logDir = config.logDir || DEFAULT_LOGDIR;
    this.shutdownTimeoutMs = config.shutdownTimeoutMs || 10000;

    // Components
    this.spawner = new Spawner({ basePath: config.basePath });
    this.healthMonitor = new HealthMonitor({
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      missThreshold: 3,
    });

    // Process table: agentId -> { daemon, restartCount, lastRestart, stable }
    this.processTable = new Map();

    // Promotion queue
    this.promotionQueue = [];
    this.activeCount = 0;
    this.promotionsPaused = false;

    // State
    this.running = false;
    this.startedAt = null;
  }

  /**
   * Start the swarm.
   * Acquires pidfile, spawns workspaces, starts daemons.
   */
  start() {
    if (this.running) throw new Error('Supervisor already running');

    // Acquire pidfile lock
    this._acquirePidfile();

    this.running = true;
    this.startedAt = Date.now();

    // Create log directory
    fs.mkdirSync(this.logDir, { recursive: true });

    // Wire up health monitor alerts
    this.healthMonitor.on('alert', (alert) => {
      this._log('health_alert', alert);
      this._handleHealthAlert(alert);
    });

    // Spawn N workspaces and daemons
    for (let i = 0; i < this.count; i++) {
      const name = `swarm-${this.role}-${String(i).padStart(3, '0')}`;
      this._spawnDaemon(name);
    }

    this.healthMonitor.start();

    this._log('swarm_started', {
      count: this.count,
      maxActive: this.maxActive,
      role: this.role,
    });

    this.emit('started', { count: this.count });
  }

  /**
   * Spawn a single daemon with workspace.
   * @param {string} name
   * @returns {Daemon}
   */
  _spawnDaemon(name) {
    const spawnResult = this.spawner.spawn({
      name,
      role: this.role,
      repo: this.repo,
      channels: this.channels,
    });

    const daemon = new Daemon({
      agentId: spawnResult.agentId,
      name,
      workspace: spawnResult.workspace,
      role: this.role,
      channels: this.channels,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
    });

    // Register with health monitor
    this.healthMonitor.register(spawnResult.agentId);

    // Wire daemon events
    daemon.on('heartbeat', (hb) => {
      this.healthMonitor.heartbeat(hb.agentId);
    });

    daemon.on('promote-request', (req) => {
      this._handlePromoteRequest(req);
    });

    daemon.on('promoted', (info) => {
      this.activeCount++;
      if (info.pid) {
        this.healthMonitor.updatePid(info.agentId, info.pid);
      }
      this._log('agent_promoted', { agentId: info.agentId, activeCount: this.activeCount });
    });

    daemon.on('done', (result) => {
      this._log('task_done', { agentId: result.agentId, task: result.task?.component });
    });

    daemon.on('fail', (result) => {
      this._log('task_fail', {
        agentId: result.agentId,
        task: result.task?.component,
        exitCode: result.exitCode,
        error: result.error,
      });
    });

    daemon.on('demoted', (info) => {
      this.activeCount = Math.max(0, this.activeCount - 1);
      this._log('agent_demoted', { agentId: info.agentId, activeCount: this.activeCount });
      this._processPromotionQueue();
    });

    daemon.on('crashed', (info) => {
      this._handleCrash(info.agentId, info.error);
    });

    // Track in process table
    this.processTable.set(spawnResult.agentId, {
      daemon,
      restartCount: 0,
      lastRestart: null,
      stableSince: Date.now(),
    });

    daemon.start();
    return daemon;
  }

  /**
   * Handle a promotion request from a daemon.
   */
  _handlePromoteRequest(req) {
    if (this.promotionsPaused) {
      const entry = this.processTable.get(req.agentId);
      if (entry) entry.daemon.denyPromotion('promotions paused (budget/quota)');
      return;
    }

    if (this.activeCount >= this.maxActive) {
      // Queue it
      this.promotionQueue.push(req);
      this._log('promotion_queued', { agentId: req.agentId, queueLength: this.promotionQueue.length });
      return;
    }

    // Check token budget
    if (this.tokenBudget > 0 && this.tokensUsed >= this.tokenBudget) {
      this.promotionsPaused = true;
      const entry = this.processTable.get(req.agentId);
      if (entry) entry.daemon.denyPromotion('token budget exhausted');
      this._log('promotions_paused', { reason: 'token_budget', used: this.tokensUsed, budget: this.tokenBudget });
      return;
    }

    // Approve
    const entry = this.processTable.get(req.agentId);
    if (entry) {
      entry.daemon.approvePromotion(req.task);
    }
  }

  /**
   * Process queued promotions when a slot opens.
   */
  _processPromotionQueue() {
    while (this.promotionQueue.length > 0 && this.activeCount < this.maxActive && !this.promotionsPaused) {
      const req = this.promotionQueue.shift();
      const entry = this.processTable.get(req.agentId);
      if (entry && entry.daemon.state === DaemonState.PROMOTING) {
        entry.daemon.approvePromotion(req.task);
      }
    }
  }

  /**
   * Handle a health alert.
   */
  _handleHealthAlert(alert) {
    if (alert.reason === 'unresponsive') {
      this._handleCrash(alert.agentId, 'heartbeat timeout');
    }
  }

  /**
   * Handle an agent crash — restart with exponential backoff.
   */
  _handleCrash(agentId, error) {
    const entry = this.processTable.get(agentId);
    if (!entry) return;

    entry.restartCount++;

    // Check if degraded (>5 restarts within 30 minutes)
    const thirtyMinAgo = Date.now() - 30 * 60 * 1000;
    if (entry.restartCount > 5 && entry.stableSince > thirtyMinAgo) {
      this._log('agent_degraded', { agentId, restartCount: entry.restartCount });
      this.emit('agent-degraded', { agentId, restartCount: entry.restartCount });
      return;
    }

    // Reset backoff if stable for 5+ minutes
    if (entry.stableSince && (Date.now() - entry.stableSince) > 5 * 60 * 1000) {
      entry.restartCount = 1;
    }

    // Exponential backoff: min(2^count seconds, 300s)
    const delaySec = Math.min(Math.pow(2, entry.restartCount), 300);
    const delayMs = delaySec * 1000;

    this._log('agent_restart_scheduled', { agentId, delay: delaySec, restartCount: entry.restartCount });

    setTimeout(() => {
      if (!this.running) return;

      // Clean up old daemon
      entry.daemon.stop();
      this.healthMonitor.unregister(agentId);
      if (entry.daemon.state === DaemonState.ACTIVE) {
        this.activeCount = Math.max(0, this.activeCount - 1);
      }
      this.processTable.delete(agentId);

      // Respawn with same name
      const newDaemon = this._spawnDaemon(entry.daemon.name);
      const newEntry = this.processTable.get(newDaemon.agentId);
      if (newEntry) {
        newEntry.restartCount = entry.restartCount;
        newEntry.stableSince = Date.now();
      }

      this._log('agent_restarted', { oldId: agentId, newId: newDaemon.agentId });
    }, delayMs);
  }

  /**
   * Scale the swarm to N total daemons.
   * @param {number} target
   */
  scale(target) {
    if (!this.running) throw new Error('Supervisor not running');

    const current = this.processTable.size;

    if (target === 0) {
      this.stop();
      return { from: current, to: 0, added: 0, removed: current };
    }

    if (target > current) {
      // Scale up
      const delta = target - current;
      for (let i = 0; i < delta; i++) {
        const idx = current + i;
        const name = `swarm-${this.role}-${String(idx).padStart(3, '0')}`;
        this._spawnDaemon(name);
      }
      this._log('scaled_up', { from: current, to: target, added: delta });
      return { from: current, to: target, added: delta, removed: 0 };
    }

    if (target < current) {
      // Scale down — remove idle daemons first
      const delta = current - target;
      const candidates = [];

      for (const [agentId, entry] of this.processTable) {
        if (entry.daemon.state === DaemonState.IDLE) {
          candidates.push({ agentId, entry });
        }
      }

      // Sort by longest idle (oldest stableSince)
      candidates.sort((a, b) => a.entry.stableSince - b.entry.stableSince);

      let removed = 0;
      for (const { agentId, entry } of candidates) {
        if (removed >= delta) break;

        entry.daemon.stop();
        this.healthMonitor.unregister(agentId);

        if (!this.persist) {
          this.spawner.teardown(agentId, { confirm: true });
        }

        this.processTable.delete(agentId);
        removed++;
      }

      this._log('scaled_down', {
        from: current,
        to: current - removed,
        removed,
        activePreserved: this.activeCount,
      });

      return { from: current, to: current - removed, added: 0, removed };
    }

    return { from: current, to: current, added: 0, removed: 0 };
  }

  /**
   * Get swarm status.
   */
  status() {
    const agents = [];
    for (const [agentId, entry] of this.processTable) {
      agents.push({
        agentId,
        name: entry.daemon.name,
        state: entry.daemon.state,
        role: entry.daemon.role,
        restartCount: entry.restartCount,
        currentTask: entry.daemon.currentTask,
      });
    }

    return {
      running: this.running,
      uptime: this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0,
      total: this.processTable.size,
      active: this.activeCount,
      idle: agents.filter(a => a.state === DaemonState.IDLE).length,
      promoting: agents.filter(a => a.state === DaemonState.PROMOTING).length,
      crashed: agents.filter(a => a.state === DaemonState.CRASHED).length,
      promotionsPaused: this.promotionsPaused,
      queueLength: this.promotionQueue.length,
      agents,
    };
  }

  /**
   * Graceful shutdown.
   */
  stop() {
    if (!this.running) return;

    this._log('swarm_stopping', { total: this.processTable.size, active: this.activeCount });

    this.running = false;
    this.healthMonitor.stop();

    // Send stop to all daemons
    for (const [agentId, entry] of this.processTable) {
      entry.daemon.stop();
      this.healthMonitor.unregister(agentId);
    }

    // Teardown workspaces if not persisting
    if (!this.persist) {
      for (const [agentId] of this.processTable) {
        this.spawner.teardown(agentId, { confirm: true });
      }
    }

    this.processTable.clear();
    this.promotionQueue = [];
    this.activeCount = 0;

    // Remove pidfile
    this._releasePidfile();

    this._log('swarm_stopped', { persisted: this.persist });
    this.emit('stopped');
  }

  /**
   * Reload config (simulates SIGHUP).
   * @param {Partial<SwarmConfig>} newConfig
   */
  reloadConfig(newConfig) {
    if (newConfig.maxActive !== undefined) {
      const old = this.maxActive;
      this.maxActive = newConfig.maxActive;
      this._log('config_reloaded', { field: 'maxActive', old, new: this.maxActive });
    }
    if (newConfig.tokenBudget !== undefined) {
      const old = this.tokenBudget;
      this.tokenBudget = newConfig.tokenBudget;
      if (this.promotionsPaused && this.tokensUsed < this.tokenBudget) {
        this.promotionsPaused = false;
      }
      this._log('config_reloaded', { field: 'tokenBudget', old, new: this.tokenBudget });
    }
    if (newConfig.heartbeatIntervalMs !== undefined) {
      this.heartbeatIntervalMs = newConfig.heartbeatIntervalMs;
      this._log('config_reloaded', { field: 'heartbeatIntervalMs', new: this.heartbeatIntervalMs });
    }

    // Process any queued promotions with new limits
    this._processPromotionQueue();
  }

  /**
   * Acquire pidfile lock.
   */
  _acquirePidfile() {
    const dir = path.dirname(this.pidfile);
    fs.mkdirSync(dir, { recursive: true });

    if (fs.existsSync(this.pidfile)) {
      const existingPid = fs.readFileSync(this.pidfile, 'utf8').trim();
      // Check if the process is still running
      try {
        process.kill(parseInt(existingPid), 0);
        throw new Error(`Another swarm is already running (PID ${existingPid})`);
      } catch (err) {
        if (err.code === 'ESRCH') {
          // Process is dead, stale pidfile — safe to take over
          this._log('stale_pidfile', { pid: existingPid });
        } else if (err.message.includes('already running')) {
          throw err;
        }
      }
    }

    fs.writeFileSync(this.pidfile, String(process.pid));
  }

  /**
   * Release pidfile.
   */
  _releasePidfile() {
    try {
      if (fs.existsSync(this.pidfile)) {
        const content = fs.readFileSync(this.pidfile, 'utf8').trim();
        if (content === String(process.pid)) {
          fs.unlinkSync(this.pidfile);
        }
      }
    } catch {
      // Best effort
    }
  }

  /**
   * Log a structured event.
   */
  _log(event, data = {}) {
    const entry = {
      ts: new Date().toISOString(),
      event,
      ...data,
    };
    this.emit('log', entry);
  }
}
