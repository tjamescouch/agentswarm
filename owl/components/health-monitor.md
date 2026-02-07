# health-monitor

tracks agent health via heartbeats and resource usage. reports problems to the supervisor for action.

## state

- heartbeat table: map of agent-id to {last-seen, status, consecutive-misses}
- resource table: map of agent-id to {memory-mb, cpu-percent, uptime-seconds}
- alert thresholds (from config)

## capabilities

- receive HEARTBEAT messages from daemons (via agentchat or IPC)
- track time since last heartbeat per agent
- detect missed heartbeats (configurable threshold, default 3 consecutive misses at 30s interval = 90s timeout)
- query process stats (memory, cpu) for each agent PID
- report unresponsive agents to supervisor for restart
- report resource limit violations to supervisor for throttling or kill
- log health events to ~/.agentctl/logs/health.log

## interfaces

exposes:
- health-status(agent-id) -> {alive, last-seen, memory-mb, cpu-pct}
- health-summary() -> status of all agents
- ALERT <agent-id> <reason> - sent to supervisor when intervention needed

depends on:
- daemon HEARTBEAT messages
- OS process stats (/proc or ps on darwin)
- supervisor for acting on alerts

## invariants

- health-monitor never kills processes directly — it only reports to supervisor
- an agent is declared dead only after consecutive-misses exceeds threshold (no single-miss kills)
- health checks do not interfere with agent work (read-only process inspection)
