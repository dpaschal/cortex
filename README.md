# Cortex

<p align="center">
  <b>Distributed AI Mesh for Personal Infrastructure</b>
</p>

<p align="center">
  <a href="https://buymeacoffee.com/dpaschal">
    <img src="https://img.shields.io/badge/❤️🎆_THANKS!_🎆❤️-Support_This_Project-ff0000?style=for-the-badge" alt="Thanks!" height="40">
  </a>
</p>

<p align="center">
  <i>Every donation keeps the code flowing — these tools are built with your support.</i>
</p>

<p align="center">
  <a href="https://buymeacoffee.com/dpaschal">
    <img src="https://cdn.buymeacoffee.com/buttons/v2/default-red.png" alt="Buy Me A Coffee" height="50">
  </a>
</p>

---

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Cortex connects your machines into a single intelligent platform — P2P compute mesh, messaging bots, multi-provider LLM routing, distributed task execution, and Claude Code integration.

## Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                            C O R T E X                               │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐            │
│  │  forge   │  │ gauntlet │  │ terminus │  │ htnas02  │            │
│  │ (server) │  │(desktop) │  │  (work)  │  │  (NAS)   │            │
│  │  Leader  │  │ Follower │  │ Eligible │  │  Worker  │            │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘            │
│       │              │              │              │                  │
│       └──────────────┴──────┬───────┴──────────────┘                 │
│                             │                                        │
│                   ┌─────────┴─────────┐                              │
│                   │  Tailscale Mesh   │                              │
│                   └───────────────────┘                              │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                     Feature Modules                          │    │
│  ├──────────┬──────────┬──────────┬──────────┬────────────────┤    │
│  │   Mesh   │ Messaging│ Providers│  Skills  │   MCP Server   │    │
│  │   Raft   │ Discord  │ Anthropic│ SKILL.md │  Claude Code   │    │
│  │ gRPC     │ Telegram │ OpenAI   │ Loader   │  20+ Tools     │    │
│  │ Discovery│ Inbox    │ Ollama   │ Hot-load │  Timeline/DB   │    │
│  └──────────┴──────────┴──────────┴──────────┴────────────────┘    │
└──────────────────────────────────────────────────────────────────────┘
```

## Features

### Core Platform
- **Raft Consensus** — Fault-tolerant leader election across nodes
- **gRPC Transport** — Protocol Buffers for fast inter-node communication
- **Tailscale Discovery** — Automatic mesh discovery and node approval
- **ISSU Rolling Updates** — Zero-downtime upgrades with backup and rollback
- **Security** — mTLS, auth/authz, secrets management

### Messaging Gateway
- **Discord Bot** (@DALEK) — Receives and responds to messages
- **Telegram Bot** (@Cipher1112222Bot) — Receives and responds to messages
- **Raft-Aware Activation** — Only the leader node runs bots, automatic failover on leader change
- **Inbox** — Persistent message storage with read/unread tracking and archival

### Intelligence
- **Multi-Provider LLM Routing** — Anthropic, OpenAI, and Ollama with automatic fallback chains
- **SKILL.md System** — Load skills from YAML-frontmatter markdown files with hot-reload

### Agent (per-node)
- **Resource Monitoring** — CPU, GPU, memory, disk with real-time snapshots
- **Gaming Detection** — Auto-detect games, yield GPU to gaming, resume when done
- **Task Execution** — Distributed task scheduling and execution
- **Kubernetes** — Submit jobs to K8s/K3s clusters

### Claude Code Integration (MCP)
- **20+ MCP Tools** — Cluster ops, messaging, skills, timeline, context, network
- **Stdio Mode** — Run as MCP server for seamless Claude Code integration

## Quick Start

### Prerequisites

- Node.js 20+
- Tailscale connected to your network
- (Optional) Docker for container tasks
- (Optional) kubectl for Kubernetes integration

### Installation

```bash
git clone https://github.com/dpaschal/cortex.git
cd cortex
npm install
npm run build
```

### Running a Node

```bash
# Start as a new cluster (first node becomes leader)
npm start

# Join existing cluster
npm start -- --seed 100.94.211.117:50051
```

### Systemd Service

```bash
sudo cp cortex.service /etc/systemd/system/
sudo systemctl enable --now cortex
```

### Claude Code Integration

Add to your MCP configuration (`~/.claude/mcp.json`):

```json
{
  "mcpServers": {
    "cortex": {
      "command": "node",
      "args": ["/path/to/cortex/dist/index.js", "--mcp", "--seed", "100.94.211.117:50051"]
    }
  }
}
```

The `--mcp` flag runs Cortex as an MCP server. Logs go to `/tmp/cortex-mcp.log` to keep stdio clean.

## MCP Tools

### Cluster Operations
| Tool | Description |
|------|-------------|
| `cluster_status` | Get cluster state, leader, and node resources |
| `list_nodes` | List all nodes with status and capabilities |
| `submit_task` | Submit a distributed task to the scheduler |
| `run_distributed` | Run a command across multiple nodes |
| `dispatch_subagents` | Launch parallel Claude agents on cluster |
| `run_benchmark` | Measure compute performance (FLOPS) |
| `initiate_rolling_update` | Zero-downtime ISSU upgrade across nodes |

### Messaging
| Tool | Description |
|------|-------------|
| `messaging_send` | Send a message to the inbox |
| `messaging_check` | Check for new unread messages |
| `messaging_list` | List all conversations |
| `messaging_get` | Retrieve a specific message |
| `messaging_gateway_status` | Check bot connection status |

### Skills
| Tool | Description |
|------|-------------|
| `list_skills` | List all loaded SKILL.md skills |
| `get_skill` | Get a skill's full content by name |

### Kubernetes
| Tool | Description |
|------|-------------|
| `k8s_list_clusters` | List discovered Kubernetes clusters |
| `k8s_submit_job` | Submit a job to K8s/K3s |

## Configuration

Edit `config/default.yaml` for cluster settings. For local overrides with secrets (bot tokens, API keys), create `config/local.yaml` (gitignored).

```yaml
# Messaging gateway
messaging:
  enabled: true
  agent: "Cipher"
  channels:
    discord:
      enabled: true
      token: ${DISCORD_BOT_TOKEN}
      guildId: "your-guild-id"
    telegram:
      enabled: true
      token: ${TELEGRAM_BOT_TOKEN}

# LLM provider routing
providers:
  primary: anthropic
  fallback:
    - ollama
  anthropic:
    model: claude-sonnet-4-6
    apiKey: ${ANTHROPIC_API_KEY}
  ollama:
    model: llama3
    baseUrl: http://localhost:11434

# SKILL.md system
skills:
  enabled: true
  directories:
    - ~/.cortex/skills
  hotReload: true
```

## Architecture

```
src/
  cluster/      # Raft consensus, membership, state, scheduling, ISSU
  grpc/         # gRPC server, client pool, service handlers
  discovery/    # Tailscale mesh discovery, node approval
  agent/        # Resource monitor, task executor, health reporter
  messaging/    # Gateway, Discord/Telegram adapters, inbox
  providers/    # LLM routing — Anthropic, OpenAI, Ollama
  skills/       # SKILL.md loader with frontmatter parsing
  mcp/          # MCP server, 20+ tools for Claude Code
  kubernetes/   # K8s/K3s job submission
  security/     # mTLS, auth, secrets
```

## Contributing

Issues and PRs welcome.

- **Bugs**: [Create a bug report](https://github.com/dpaschal/cortex/issues/new?labels=bug)
- **Features**: [Request a feature](https://github.com/dpaschal/cortex/issues/new?labels=enhancement)

## License

MIT License - see [LICENSE](LICENSE) for details.

## Acknowledgments

- Built with [superpowers](https://github.com/anthropics/superpowers) workflow
- Uses [MCP SDK](https://github.com/anthropics/mcp) for Claude Code integration
- Messaging gateway absorbed from [OpenClaw](https://openclaw.ai) (MIT licensed)
