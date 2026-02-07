# daemon

a lightweight idle process that listens for tasks on agentchat and promotes to a full agent session when work is available. there is one daemon per swarm slot.

## state

- agent identity (agentchat id + name)
- workspace path
- assigned role (builder, auditor, qa, or general)
- status: idle, promoting, active, demoting, crashed
- agentchat connection (websocket)
- current task (null when idle)

## capabilities

- connect to agentchat server and join the work channel
- listen for task announcements and ASSIGN messages
- evaluate whether a task matches its role
- request promotion from supervisor when a matching task is found
- on promotion: spawn a claude -p session with the task prompt and workspace context
- forward agent output to agentchat as status messages
- detect when the claude session exits (success or failure)
- report task completion or failure to the work channel
- return to idle state after task completion (demotion)
- save minimal context to <workspace>/context.md on demotion for potential resume

## interfaces

exposes:
- CLAIM <component> - sent to work channel when daemon wants a task
- HEARTBEAT <agent-id> <status> - periodic health signal to supervisor
- DONE <task-id> <result> - task completed successfully
- FAIL <task-id> <reason> - task failed

depends on:
- supervisor for lifecycle management (start, stop, promote, demote)
- agentchat server for communication
- claude CLI for active work sessions
- spawner-provisioned workspace and identity

## invariants

- an idle daemon sends only HEARTBEAT messages — no other agentchat traffic
- a daemon never starts a claude session without supervisor approval (promotion)
- workspace files are only modified during active (promoted) state
- context.md is written on every demotion for crash recovery
