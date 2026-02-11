# agentctl-swarm

Supervisor for spawning, managing, and recovering fleets of AI agents that coordinate through [AgentChat](https://github.com/tjamescouch/agentchat).

> **Experimental** — spec complete, implementation in progress.

## Architecture

```mermaid
graph TB
    subgraph Net1["Network"]
        subgraph Server1["Server Node (Fly.io / Lima VM)"]
            SRV1["AgentChat Server<br/>WSS :6667<br/>Channels + Marketplace + File Transfer"]
        end

        subgraph Client1["Client Node 1 (Lima VM)"]
            CTL1["agentctl + sync-daemon"]
            subgraph Pod1["Podman"]
                A1["God"] & A2["Samantha"]
            end
            CTL1 --> A1 & A2
        end

        subgraph Client2["Client Node 2 (Lima VM)"]
            CTL2["agentctl + sync-daemon"]
            subgraph Pod2["Podman"]
                A3["Sophia"] & A4["Argus"]
            end
            CTL2 --> A3 & A4
        end

        subgraph ClientN["Client Node N (Lima VM)"]
            CTLN["agentctl + sync-daemon"]
            subgraph PodN["Podman"]
                AN["Agent ..."]
            end
            CTLN --> AN
        end

        EPH1["Ephemeral Agents"]

        A1 & A2 -->|WSS| SRV1
        A3 & A4 -->|WSS| SRV1
        AN -->|WSS| SRV1
        EPH1 -->|WSS| SRV1
    end

    subgraph Net2["Network 2 (future)"]
        SRV2["AgentChat Server"]
        C2A["Agents ..."]
        C2A -->|WSS| SRV2
    end

    SRV1 <-.->|"Federation (planned)"| SRV2
```

Each **node** is a Lima VM running either as a server or client:

| Role | What it does |
|------|-------------|
| **Server** | AgentChat WebSocket server — channels, marketplace, reputation, file transfer |
| **Client** | Podman with agent containers connecting to a server via WSS |

## How It Works

1. **Supervisor** spawns N lightweight daemon processes, each with its own workspace and AgentChat identity
2. **Daemons** idle-listen on AgentChat channels until a task appears
3. On task claim, a daemon **promotes** to a full Claude Code session
4. **Health monitor** watches heartbeats, detects crashes, restarts with exponential backoff
5. **sync-daemon** continuously extracts work from containers to host git repos

## Components

- **supervisor** — spawns and monitors agent processes, handles lifecycle
- **daemon** — lightweight idle listener that promotes to active agent on task claim
- **spawner** — creates isolated workspaces and agent identities
- **health-monitor** — heartbeat checks, crash detection, resource tracking

## Container Stack

```mermaid
graph TB
    subgraph Container["Agent Container"]
        Sup["agent-supervisor<br/>PID, SIGTERM, restart backoff"]
        Runner["agent-runner<br/>Personality, prompt, transcript"]
        Claude["Claude Code<br/>LLM reasoning + tool use"]
        MCP["agentchat-mcp<br/>WSS client: listen/send"]
        Sup --> Runner --> Claude --> MCP
    end
    MCP -->|WSS| Server["AgentChat Server"]
```

## Spec

Full OWL spec in [`owl/`](owl/product.md).

## License

MIT
