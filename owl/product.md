# agentctl-swarm

a supervisor for spawning, managing, and recovering fleets of AI agents that coordinate through agentchat.

agentctl-swarm starts N lightweight daemon processes, each with its own workspace, agentchat identity, and role. daemons idle until a task is available, then promote to full claude code sessions to execute work. the supervisor monitors health, restarts crashed agents with backoff, and enforces resource limits.

## components

- [supervisor](components/supervisor.md) - spawns and monitors agent processes, handles lifecycle
- [daemon](components/daemon.md) - lightweight idle listener that promotes to active agent on task claim
- [spawner](components/spawner.md) - creates isolated workspaces and agent identities
- [health-monitor](components/health-monitor.md) - heartbeat checks, crash detection, resource tracking

## behaviors

- [swarm-lifecycle](behaviors/swarm-lifecycle.md) - from spawn to shutdown
- [promotion](behaviors/promotion.md) - daemon claims task and promotes to active builder
- [recovery](behaviors/recovery.md) - handling crashes, quota exhaustion, and disconnects
- [scaling](behaviors/scaling.md) - adding and removing agents from a running swarm

## constraints

see [constraints.md](constraints.md)
