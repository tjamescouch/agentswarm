# scaling

how to add or remove agents from a running swarm without disrupting active work.

## scale up

1. user runs: agentctl swarm scale 20 (current count is 10)
2. supervisor calculates delta: 20 - 10 = 10 new agents needed
3. supervisor invokes spawner to create 10 new workspaces and identities
4. supervisor starts 10 new daemon processes
5. new daemons connect to agentchat and begin sending HEARTBEAT
6. supervisor updates process table with new entries
7. supervisor logs: "scaled up: 10 -> 20 daemons"

## scale down

1. user runs: agentctl swarm scale 5 (current count is 20)
2. supervisor calculates delta: 20 - 5 = 15 agents to remove
3. supervisor selects agents to remove: idle daemons first, then longest-idle
4. active agents are NEVER selected for removal — they finish their current task
5. supervisor sends SIGTERM to selected daemons
6. daemons disconnect from agentchat and exit cleanly
7. if persist: false, spawner tears down removed workspaces
8. supervisor updates process table
9. supervisor logs: "scaled down: 20 -> 5 daemons (15 removed, 0 active preserved)"

## scale to zero

1. user runs: agentctl swarm scale 0
2. equivalent to agentctl swarm stop — full shutdown flow applies
3. active agents are given 10s to save context before SIGKILL

## live reconfig

1. user modifies swarm.yaml and sends SIGHUP to supervisor
2. supervisor reloads config
3. changes to max-active, token-budget, and heartbeat-interval take effect immediately
4. changes to workspace-base or identity-template only affect newly spawned agents
5. supervisor logs: "config reloaded: max-active 5->10, budget 100k->200k"
