# promotion

how a daemon transitions from idle listener to active agent executing a task.

## flow

1. daemon sees a task announcement or ASSIGN message on the work channel
2. daemon evaluates role match: does the task match its assigned role?
3. if match: daemon sends CLAIM <component> to the work channel
4. coordinator responds with ASSIGN <component> <agent-id> or REJECTED
5. if REJECTED: daemon returns to idle
6. if ASSIGNED: daemon sends PROMOTE-REQUEST to supervisor (via IPC)
7. supervisor checks: active count < max-active AND token budget remaining
8. if denied: daemon sends UNCLAIM <component> to work channel, returns to idle
9. if approved: supervisor marks daemon as "promoting"
10. daemon writes task context to <workspace>/context.md
11. daemon spawns: claude -p "<task prompt with spec context>" --cwd <workspace>
12. supervisor marks daemon as "active", starts tracking the claude PID
13. daemon monitors the claude process stdout/stderr
14. daemon forwards relevant output as status messages to work channel

## demotion

1. claude process exits (success or failure)
2. daemon captures exit code and final output
3. daemon sends DONE or FAIL to work channel
4. daemon saves summary to <workspace>/context.md
5. daemon sends DEMOTE notification to supervisor (via IPC)
6. supervisor marks daemon as "idle", decrements active count
7. daemon resumes listening on work channel
