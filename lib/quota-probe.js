/**
 * QuotaProbe — tracks token usage per agent and enforces budgets.
 *
 * Since Claude CLI doesn't expose token counts directly, the probe uses
 * multiple estimation strategies:
 *   1. Output-based: estimates tokens from stdout character count (~4 chars/token)
 *   2. Duration-based: estimates from task duration (~1000 tokens/second)
 *   3. Reported: accepts explicit token counts from external sources
 *
 * The probe integrates with the supervisor to:
 *   - Track per-agent and aggregate usage
 *   - Pause promotions when budget is exhausted
 *   - Report usage summaries
 */

import { EventEmitter } from 'events';

const CHARS_PER_TOKEN = 4; // Rough estimate for English text
const DEFAULT_TOKENS_PER_SECOND = 50; // Conservative estimate for Claude output

/**
 * @typedef {object} QuotaConfig
 * @property {number} [budget] - total token budget (0 = unlimited)
 * @property {string} [estimationMethod] - 'output' | 'duration' | 'reported' (default: 'output')
 * @property {number} [charsPerToken] - chars per token for output estimation (default: 4)
 * @property {number} [tokensPerSecond] - tokens/sec for duration estimation (default: 50)
 * @property {number} [warningThreshold] - emit warning at this % of budget (default: 0.8)
 */

export class QuotaProbe extends EventEmitter {
  /**
   * @param {QuotaConfig} [config]
   */
  constructor(config = {}) {
    super();

    this.budget = config.budget || 0;
    this.estimationMethod = config.estimationMethod || 'output';
    this.charsPerToken = config.charsPerToken || CHARS_PER_TOKEN;
    this.tokensPerSecond = config.tokensPerSecond || DEFAULT_TOKENS_PER_SECOND;
    this.warningThreshold = config.warningThreshold || 0.8;

    // Per-agent tracking
    this._agents = new Map(); // agentId -> { totalTokens, tasks, lastTask }

    // Aggregate
    this._totalTokens = 0;
    this._warningEmitted = false;
  }

  /**
   * Record token usage for an agent.
   * Called when a task completes with output stats.
   *
   * @param {object} result
   * @param {string} result.agentId
   * @param {string} [result.output] - stdout from Claude session
   * @param {number} [result.durationMs] - task duration in ms
   * @param {number} [result.tokens] - explicit token count (overrides estimation)
   */
  record(result) {
    if (!result.agentId) return;

    let tokens = 0;

    if (result.tokens !== undefined && result.tokens > 0) {
      // Explicit count takes priority
      tokens = result.tokens;
    } else if (this.estimationMethod === 'output' && result.output) {
      tokens = Math.ceil(result.output.length / this.charsPerToken);
    } else if (this.estimationMethod === 'duration' && result.durationMs) {
      tokens = Math.ceil((result.durationMs / 1000) * this.tokensPerSecond);
    } else if (result.output) {
      // Fallback to output estimation
      tokens = Math.ceil(result.output.length / this.charsPerToken);
    }

    // Update per-agent tracking
    let agent = this._agents.get(result.agentId);
    if (!agent) {
      agent = { totalTokens: 0, tasks: 0, lastTask: null };
      this._agents.set(result.agentId, agent);
    }

    agent.totalTokens += tokens;
    agent.tasks++;
    agent.lastTask = {
      tokens,
      durationMs: result.durationMs || 0,
      ts: Date.now(),
    };

    // Update aggregate
    this._totalTokens += tokens;

    this.emit('usage', {
      agentId: result.agentId,
      tokens,
      totalTokens: this._totalTokens,
      budget: this.budget,
    });

    // Check budget thresholds
    if (this.budget > 0) {
      const pct = this._totalTokens / this.budget;

      if (pct >= 1) {
        this.emit('budget_exhausted', {
          totalTokens: this._totalTokens,
          budget: this.budget,
        });
      } else if (pct >= this.warningThreshold && !this._warningEmitted) {
        this._warningEmitted = true;
        this.emit('budget_warning', {
          totalTokens: this._totalTokens,
          budget: this.budget,
          pct: Math.round(pct * 100),
        });
      }
    }
  }

  /**
   * Get usage for a specific agent.
   * @param {string} agentId
   * @returns {{ totalTokens: number, tasks: number, lastTask: object | null } | null}
   */
  agentUsage(agentId) {
    return this._agents.get(agentId) || null;
  }

  /**
   * Get aggregate usage summary.
   * @returns {object}
   */
  summary() {
    const agents = [];
    for (const [agentId, data] of this._agents) {
      agents.push({
        agentId,
        totalTokens: data.totalTokens,
        tasks: data.tasks,
      });
    }

    // Sort by usage descending
    agents.sort((a, b) => b.totalTokens - a.totalTokens);

    return {
      totalTokens: this._totalTokens,
      budget: this.budget,
      remaining: this.budget > 0 ? Math.max(0, this.budget - this._totalTokens) : Infinity,
      pct: this.budget > 0 ? Math.round((this._totalTokens / this.budget) * 100) : 0,
      agents,
      estimationMethod: this.estimationMethod,
    };
  }

  /**
   * Check if budget is exhausted.
   * @returns {boolean}
   */
  isExhausted() {
    if (this.budget <= 0) return false;
    return this._totalTokens >= this.budget;
  }

  /**
   * Reset all usage counters.
   */
  reset() {
    this._agents.clear();
    this._totalTokens = 0;
    this._warningEmitted = false;
  }

  /**
   * Update the budget.
   * @param {number} newBudget
   */
  setBudget(newBudget) {
    this.budget = newBudget;
    // Reset warning if we now have headroom
    if (this.budget > 0 && this._totalTokens / this.budget < this.warningThreshold) {
      this._warningEmitted = false;
    }
  }

  /**
   * Get total tokens used.
   * @returns {number}
   */
  get totalTokens() {
    return this._totalTokens;
  }
}

/**
 * Wire a QuotaProbe to a Supervisor.
 * Listens for task completion events and updates token tracking.
 *
 * @param {import('./supervisor.js').Supervisor} supervisor
 * @param {QuotaProbe} probe
 */
export function attachQuotaProbe(supervisor, probe) {
  // Track task start times for duration estimation
  const taskStartTimes = new Map();

  // Listen to all daemon events through supervisor
  const wireAgent = (daemon) => {
    daemon.on('promoted', (info) => {
      taskStartTimes.set(info.agentId, Date.now());
    });

    daemon.on('done', (result) => {
      const startTime = taskStartTimes.get(result.agentId);
      const durationMs = startTime ? Date.now() - startTime : 0;
      taskStartTimes.delete(result.agentId);

      probe.record({
        agentId: result.agentId,
        output: result.output || '',
        durationMs,
        tokens: result.tokens,
      });

      // Sync to supervisor
      supervisor.tokensUsed = probe.totalTokens;
    });

    daemon.on('fail', (result) => {
      const startTime = taskStartTimes.get(result.agentId);
      const durationMs = startTime ? Date.now() - startTime : 0;
      taskStartTimes.delete(result.agentId);

      probe.record({
        agentId: result.agentId,
        output: result.output || '',
        durationMs,
        tokens: result.tokens,
      });

      // Sync to supervisor
      supervisor.tokensUsed = probe.totalTokens;
    });
  };

  // Wire existing daemons
  for (const [, entry] of supervisor.processTable) {
    wireAgent(entry.daemon);
  }

  // Wire daemons added after attachment (via scale up)
  const origSpawnDaemon = supervisor._spawnDaemon.bind(supervisor);
  supervisor._spawnDaemon = function (name) {
    const daemon = origSpawnDaemon(name);
    wireAgent(daemon);
    return daemon;
  };

  // Forward probe events to supervisor
  probe.on('budget_exhausted', (info) => {
    supervisor._log('budget_exhausted', info);
    supervisor.promotionsPaused = true;
  });

  probe.on('budget_warning', (info) => {
    supervisor._log('budget_warning', info);
  });

  probe.on('usage', (info) => {
    supervisor._log('token_usage', { agentId: info.agentId, tokens: info.tokens, total: info.totalTokens });
  });
}
