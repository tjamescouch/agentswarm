/**
 * Health Monitor
 * Tracks agent health via heartbeats and resource usage.
 * Reports problems to the supervisor for action.
 */

import { execFileSync } from 'child_process';
import { EventEmitter } from 'events';

/**
 * @typedef {object} AgentHealth
 * @property {number} lastSeen - timestamp of last heartbeat
 * @property {'alive'|'unresponsive'|'dead'} status
 * @property {number} consecutiveMisses - missed heartbeat count
 * @property {number|null} pid - OS process ID (if tracked)
 * @property {number|null} memoryMb - memory usage in MB
 * @property {number|null} cpuPct - CPU usage percentage
 * @property {number} uptimeSeconds - seconds since agent was registered
 */

/**
 * @typedef {object} HealthMonitorOptions
 * @property {number} [heartbeatIntervalMs] - expected heartbeat interval (default 30000)
 * @property {number} [missThreshold] - consecutive misses before dead (default 3)
 * @property {number} [checkIntervalMs] - how often to run health checks (default 10000)
 * @property {number} [memoryLimitMb] - memory limit before alerting (default 0 = no limit)
 * @property {number} [cpuLimitPct] - CPU limit before alerting (default 0 = no limit)
 */

export class HealthMonitor extends EventEmitter {
  /**
   * @param {HealthMonitorOptions} [options]
   */
  constructor(options = {}) {
    super();
    this.heartbeatIntervalMs = options.heartbeatIntervalMs || 30000;
    this.missThreshold = options.missThreshold || 3;
    this.checkIntervalMs = options.checkIntervalMs || 10000;
    this.memoryLimitMb = options.memoryLimitMb || 0;
    this.cpuLimitPct = options.cpuLimitPct || 0;

    /** @type {Map<string, AgentHealth>} */
    this.agents = new Map();

    this._checkTimer = null;
  }

  /**
   * Register an agent for health tracking.
   * @param {string} agentId
   * @param {number|null} [pid] - OS process ID
   */
  register(agentId, pid = null) {
    this.agents.set(agentId, {
      lastSeen: Date.now(),
      status: 'alive',
      consecutiveMisses: 0,
      pid,
      memoryMb: null,
      cpuPct: null,
      uptimeSeconds: 0,
      registeredAt: Date.now(),
    });
  }

  /**
   * Remove an agent from health tracking.
   * @param {string} agentId
   */
  unregister(agentId) {
    this.agents.delete(agentId);
  }

  /**
   * Record a heartbeat from an agent.
   * @param {string} agentId
   */
  heartbeat(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    agent.lastSeen = Date.now();
    agent.consecutiveMisses = 0;
    agent.status = 'alive';
  }

  /**
   * Update the PID for an agent (e.g., after promotion).
   * @param {string} agentId
   * @param {number} pid
   */
  updatePid(agentId, pid) {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    agent.pid = pid;
  }

  /**
   * Get health status for a single agent.
   * @param {string} agentId
   * @returns {{ alive: boolean, lastSeen: number, memoryMb: number|null, cpuPct: number|null } | null}
   */
  healthStatus(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;

    return {
      alive: agent.status === 'alive',
      lastSeen: agent.lastSeen,
      memoryMb: agent.memoryMb,
      cpuPct: agent.cpuPct,
    };
  }

  /**
   * Get health summary for all agents.
   * @returns {Array<{ agentId: string, alive: boolean, status: string, lastSeen: number, consecutiveMisses: number, memoryMb: number|null, cpuPct: number|null, uptimeSeconds: number }>}
   */
  healthSummary() {
    const now = Date.now();
    const result = [];
    for (const [agentId, agent] of this.agents) {
      result.push({
        agentId,
        alive: agent.status === 'alive',
        status: agent.status,
        lastSeen: agent.lastSeen,
        consecutiveMisses: agent.consecutiveMisses,
        memoryMb: agent.memoryMb,
        cpuPct: agent.cpuPct,
        uptimeSeconds: Math.floor((now - agent.registeredAt) / 1000),
      });
    }
    return result;
  }

  /**
   * Run a single health check cycle.
   * Checks heartbeat freshness and resource usage.
   * Emits 'alert' events for the supervisor.
   */
  check() {
    const now = Date.now();

    for (const [agentId, agent] of this.agents) {
      // Update uptime
      agent.uptimeSeconds = Math.floor((now - agent.registeredAt) / 1000);

      // Check heartbeat freshness
      const timeSinceHeartbeat = now - agent.lastSeen;
      if (timeSinceHeartbeat > this.heartbeatIntervalMs) {
        const missedCycles = Math.floor(timeSinceHeartbeat / this.heartbeatIntervalMs);
        agent.consecutiveMisses = missedCycles;

        if (missedCycles >= this.missThreshold) {
          if (agent.status !== 'dead') {
            agent.status = 'dead';
            this.emit('alert', {
              agentId,
              reason: 'unresponsive',
              detail: `${missedCycles} consecutive heartbeat misses (threshold: ${this.missThreshold})`,
            });
          }
        } else if (agent.status !== 'dead') {
          agent.status = 'unresponsive';
        }
      }

      // Query process stats if PID is known
      if (agent.pid) {
        const stats = this._queryProcessStats(agent.pid);
        if (stats) {
          agent.memoryMb = stats.memoryMb;
          agent.cpuPct = stats.cpuPct;

          // Check resource limits
          if (this.memoryLimitMb > 0 && stats.memoryMb > this.memoryLimitMb) {
            this.emit('alert', {
              agentId,
              reason: 'memory_limit',
              detail: `${stats.memoryMb.toFixed(1)}MB exceeds limit of ${this.memoryLimitMb}MB`,
            });
          }
          if (this.cpuLimitPct > 0 && stats.cpuPct > this.cpuLimitPct) {
            this.emit('alert', {
              agentId,
              reason: 'cpu_limit',
              detail: `${stats.cpuPct.toFixed(1)}% exceeds limit of ${this.cpuLimitPct}%`,
            });
          }
        }
      }
    }
  }

  /**
   * Query process stats via ps (works on macOS and Linux).
   * Read-only — does not interfere with the process.
   * @param {number} pid
   * @returns {{ memoryMb: number, cpuPct: number } | null}
   */
  _queryProcessStats(pid) {
    try {
      const output = execFileSync('ps', ['-p', String(pid), '-o', 'rss=,pcpu='], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      }).trim();

      if (!output) return null;

      const parts = output.split(/\s+/);
      if (parts.length < 2) return null;

      const rssKb = parseFloat(parts[0]);
      const cpuPct = parseFloat(parts[1]);

      return {
        memoryMb: rssKb / 1024,
        cpuPct,
      };
    } catch {
      return null;
    }
  }

  /**
   * Start periodic health checks.
   */
  start() {
    if (this._checkTimer) return;
    this._checkTimer = setInterval(() => this.check(), this.checkIntervalMs);
  }

  /**
   * Stop periodic health checks.
   */
  stop() {
    if (this._checkTimer) {
      clearInterval(this._checkTimer);
      this._checkTimer = null;
    }
  }
}
