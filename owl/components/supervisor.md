# supervisor

the top-level process that manages the swarm. there is one supervisor per machine.

## state

- swarm config (parsed from swarm.yaml)
- process table: map of agent-id to {pid, status, role, workspace, restart-count, last-heartbeat}
- promotion queue: ordered list of daemons waiting for an active slot
- token budget: remaining tokens across the swarm
- pidfile lock at ~/.agentctl/swarm.pid

## capabilities

- parse swarm config and validate settings
- invoke spawner to create N agent workspaces and identities
- start daemon processes and track their PIDs
- promote daemons to active agents when tasks are available and budget allows
- demote active agents back to daemon state when idle too long
- restart crashed agents with exponential backoff (1s, 2s, 4s, 8s... max 5m)
- enforce max concurrent active agent limit
- pause all promotions when token budget threshold reached
- graceful shutdown: send SIGTERM to all children, wait 10s, SIGKILL survivors
- respond to SIGHUP by reloading config without restarting agents
- write structured logs to ~/.agentctl/logs/supervisor.log

## interfaces

exposes:
- CLI: agentctl swarm start [--count N] [--config path]
- CLI: agentctl swarm stop
- CLI: agentctl swarm status
- CLI: agentctl swarm scale <N>
- CLI: agentctl swarm logs [agent-id]

depends on:
- spawner for workspace/identity creation
- health-monitor for heartbeat tracking
- agentchat server for agent communication
- claude CLI (claude -p) for running agent sessions

## invariants

- exactly one supervisor runs per machine (pidfile enforced)
- supervisor never executes agent work — it only manages processes
- all child processes die when supervisor dies (process group)
- restart backoff resets after 5 minutes of stable uptime
