# recovery

how the swarm handles things going wrong. each failure mode has a distinct recovery strategy.

## ws disconnect

1. daemon detects websocket close or error event
2. daemon attempts reconnect with backoff: 1s, 2s, 4s, 8s, max 30s
3. on reconnect: daemon re-joins work channel, sends HEARTBEAT
4. if reconnect fails after 5 attempts: daemon reports to supervisor via IPC
5. supervisor may restart the daemon process entirely

an active agent that loses WS connection continues working locally. it queues status messages and flushes them on reconnect.

## agent crash

1. supervisor detects child process exit via SIGCHLD
2. supervisor checks exit code: 0 = clean exit, non-zero = crash
3. on crash: supervisor increments restart-count for that agent
4. supervisor applies exponential backoff: delay = min(2^restart-count seconds, 300s)
5. after delay: supervisor invokes spawner to verify workspace integrity
6. supervisor starts a new daemon process in the same workspace
7. new daemon reads context.md to understand what it was doing
8. if restart-count > 5 within 30 minutes: supervisor marks agent as "degraded" and stops retrying

## quota exhaustion

1. claude -p exits with a quota-exceeded error (detected via exit code or stderr)
2. daemon reports QUOTA-EXHAUSTED to supervisor
3. supervisor pauses ALL promotions across the swarm
4. supervisor logs alert and waits for quota reset
5. supervisor periodically tests quota availability (one small probe every 5 minutes)
6. on quota restoration: supervisor resumes promotions, requeues the failed task

## context overflow

1. claude session runs out of context window and exits
2. daemon detects context-overflow in stderr
3. daemon saves partial work to context.md
4. daemon reports FAIL <task> context-overflow to work channel
5. coordinator may break the task into smaller subtasks and re-assign
6. if task cannot be broken down: escalate to human

## tool loop

1. supervisor detects that an active agent has been running for longer than max-task-duration (configurable, default 30m)
2. supervisor sends SIGTERM to the claude process
3. daemon captures partial output, saves to context.md
4. daemon reports FAIL <task> timeout to work channel
5. coordinator decides whether to retry with a more focused prompt or escalate

## sandbox denial

1. claude session fails because a required tool was denied by the sandbox
2. daemon detects permission-denied pattern in stderr
3. daemon reports BLOCKED <task> sandbox-denied to work channel
4. coordinator may reassign to an agent with broader permissions
5. if no agent has the required permissions: escalate to human
