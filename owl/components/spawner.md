# spawner

creates isolated workspaces and agent identities for new swarm members. invoked by the supervisor at startup and when scaling up.

## state

- base workspace path (configurable, default ~/dev/claude/)
- identity template (role-based prompts and CLAUDE.md files)
- list of created workspaces (for cleanup on shutdown)

## capabilities

- create a workspace directory: ~/dev/claude/<agent-name>/
- clone the target repo into the workspace (if specified in config)
- create a feature branch: swarm/<agent-name>/<task-id>
- generate an agentchat identity and write it to <workspace>/.agentchat/identities/<name>.json
- write a CLAUDE.md file with the agent's role, constraints, and channel assignments
- write a context.md file with initial state (empty or from previous session)
- set up .gitignore with security entries (*.key, *.pem, .env, etc.)
- clean up workspace on agent removal (rm -rf after confirmation)

## interfaces

exposes:
- spawn(config) -> {workspace, identity, pid-placeholder}
- teardown(agent-id) -> removes workspace and identity

depends on:
- git for repo cloning and branch creation
- filesystem for workspace creation
- agentchat identity format (Ed25519 keypair)

## invariants

- each workspace is a complete, independent directory — no shared state between agents
- spawner never starts an agent process — it only prepares the environment
- teardown requires explicit confirmation (no silent deletion)
- .gitignore is always written before any other files
