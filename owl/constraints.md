# constraints

## isolation

- each agent gets its own workspace directory: ~/dev/claude/<agent-id>/
- agents must not access other agents' workspaces
- agents must not access ~/.ssh, ~/.aws, ~/.config/gcloud, or other credential stores
- the supervisor may mount specific secrets into agent workspaces via config (explicit opt-in)

## identity

- each agent gets a unique agentchat identity generated at spawn time
- identities are stored in the agent's workspace: <workspace>/.agentchat/identities/<name>.json
- agent names follow the pattern: swarm-<role>-<index> (e.g., swarm-builder-003)
- identities are ephemeral by default — destroyed on swarm shutdown unless persist: true in config

## resource limits

- max concurrent active (promoted) agents is configurable, default 5
- idle daemons have no resource cap (they burn minimal tokens)
- per-agent memory limit is configurable, enforced via process group cgroups or ulimit
- total swarm token budget is configurable — supervisor pauses promotions when budget threshold is reached

## communication

- all agents connect to the same agentchat server
- agents join a configured work channel (default: #agents)
- supervisor listens on #agents for status messages
- agents must not send messages to channels outside their assigned list

## process management

- supervisor is the parent process of all daemons
- daemons are child processes, not detached — they die if supervisor dies
- supervisor writes a pidfile at ~/.agentctl/swarm.pid
- only one swarm instance per machine (enforced via pidfile lock)

## config location

- swarm config file: ~/.agentctl/swarm.yaml (or AGENTCTL_SWARM_CONFIG env var)
- per-agent overrides: ~/.agentctl/roles/<role-name>.yaml
- config is read at startup and on SIGHUP (live reload)
