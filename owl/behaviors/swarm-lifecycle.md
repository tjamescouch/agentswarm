# swarm-lifecycle

the full sequence from starting a swarm to shutting it down.

## startup flow

1. user runs: agentctl swarm start --count 10 --config swarm.yaml
2. supervisor reads and validates config
3. supervisor acquires pidfile lock (fails if another swarm is running)
4. supervisor invokes spawner to create N workspaces and identities
5. supervisor starts N daemon processes, one per workspace
6. each daemon connects to agentchat and joins the work channel
7. each daemon sends its first HEARTBEAT
8. supervisor logs: "swarm started: N daemons, 0 active"

## steady state

1. daemons idle, sending HEARTBEAT every 30s
2. health-monitor tracks heartbeats and resource usage
3. when a task appears on the work channel, eligible daemons send CLAIM
4. coordinator ACKs one daemon — daemon requests promotion from supervisor
5. supervisor approves promotion if budget and active-limit allow
6. daemon spawns claude -p session, transitions to active
7. active agent works until task completes or fails
8. agent reports DONE or FAIL, supervisor demotes back to daemon
9. daemon saves context.md and returns to idle

## shutdown flow

1. user runs: agentctl swarm stop (or supervisor receives SIGTERM)
2. supervisor sends SIGTERM to all child processes
3. active agents save context.md and exit
4. daemons disconnect from agentchat and exit
5. supervisor waits up to 10s for clean exits
6. supervisor sends SIGKILL to any remaining children
7. supervisor removes pidfile
8. if config has persist: false, spawner tears down all workspaces
9. supervisor logs: "swarm stopped: N agents shutdown"
