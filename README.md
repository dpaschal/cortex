# Cortex

<p align="center">
  <a href="https://buymeacoffee.com/dpaschal">
    <img src="https://img.shields.io/badge/❤️🎆_THANKS!_🎆❤️-Support_This_Project-ff0000?style=for-the-badge" alt="Thanks!" height="40">
  </a>
</p>

<p align="center">
  <b>☕ Buy me Claude Code credits or support a project! ☕</b>
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

**Distributed AI Mesh for Personal Infrastructure**

Cortex connects your machines into a single intelligent platform — P2P compute mesh with a pluggable architecture, Raft-replicated shared memory, persistent distributed task execution with DAG workflows, and Claude Code integration via MCP.

## Features

- **Raft Consensus** — Fault-tolerant leader election, log replication, and automatic failover across all nodes
- **gRPC Transport** — Protocol Buffers for fast, typed inter-node communication
- **Tailscale Discovery** — Automatic mesh discovery via `tag:cortex`, secure WireGuard tunnels, node approval workflow
- **Shared Memory (CSM)** — Raft-replicated SQLite database for timeline threads, context, and state — reads local, writes through leader
- **Plugin Architecture** — Core + plugins design; each node enables/disables plugins via per-node YAML config; failed plugins never affect core
- **47 MCP Tools** — Full Claude Code integration via stdio MCP server; tools collected from all enabled plugins
- **CLI Management** — `cctl status`, `cctl deploy`, `cctl squelch`, `cctl switch-leader` for cluster operations
- **Persistent Task Execution** — SQLite-backed tasks with retry policies, dead letter queues, and node draining
- **DAG Workflows** — Multi-task workflows with dependency graphs, parallel execution, and per-task state tracking
- **Distributed Commands** — Run shell commands or dispatch Claude subagents across multiple nodes in parallel
- **ISSU Rolling Updates** — In-Service Software Upgrade with backup/rollback, health verification, and "Tap on Shoulder" notifications
- **Cluster Health Monitoring** — Term velocity tracking, quorum safety, replication lag detection, Telegram alerts with squelch
- **LLM Provider Router** — Anthropic (Claude), OpenAI (GPT), and Ollama (local models) with primary + fallback routing
- **Messaging Gateway** — Leader-only activation, Discord and Telegram adapters, conversation routing, message splitting
- **Gaming Detection** — Detects Steam/Proton/Wine processes and GPU utilization; marks nodes as gaming to avoid task scheduling
- **Resource Monitoring** — CPU, memory, disk, GPU tracking with configurable thresholds and health reporting
- **Kubernetes Hybrid** — K8s/K3s cluster discovery, job submission, and scaling alongside bare-metal nodes
- **Invisible Mode** — Nodes can join the cluster without being announced (for MCP or monitoring)

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
│                   └─────────┬─────────┘                              │
│                             │                                        │
│  ┌──────────────────────────┴───────────────────────────────────┐   │
│  │                      FIXED CORE                               │   │
│  │  Raft · gRPC · Membership · Shared Memory · Scheduler        │   │
│  └──────────────────────────┬───────────────────────────────────┘   │
│                             │                                        │
│  ┌──────────────────────────┴───────────────────────────────────┐   │
│  │                      PLUGINS (per-node YAML)                  │   │
│  ├──────────┬──────────┬──────────┬──────────┬────────────────┤   │
│  │ Memory   │ Cluster  │ Task     │ Updater  │  Kubernetes    │   │
│  │ 12 tools │  8 tools │ Engine   │ ISSU     │  4 tools       │   │
│  │          │          │ 12 tools │          │                │   │
│  ├──────────┼──────────┼──────────┼──────────┴────────────────┤   │
│  │ Health   │Messaging │ Skills   │  MCP Server (47 tools,     │   │
│  │ Monitor  │ Discord  │ SKILL.md │    9 resources)             │   │
│  │ Telegram │ Telegram │ Hot-load │  Stdio mode for Claude Code │   │
│  └──────────┴──────────┴──────────┴───────────────────────────┘   │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

## CLI

Cortex includes a management CLI accessible as `cortex` or `cctl`:

```bash
cctl status                 # Cluster health, leader, nodes, tasks
cctl deploy                 # Build → sync → rolling restart → verify
cctl deploy --no-build      # Skip build, just sync and restart
cctl squelch 10             # Suppress health alerts for 10 minutes
cctl squelch 0              # Re-enable alerts
cctl switch-leader forge    # Step down leader, prefer forge in next election
```

### Deploy Options

| Flag | Default | Description |
|------|---------|-------------|
| `--no-build` | (builds) | Skip `npm run build` |
| `--squelch <min>` | `10` | Alert squelch duration |
| `--pause <sec>` | `15` | Pause between node restarts |
| `--user <user>` | `paschal` | SSH user for remote nodes |
| `--dist <path>` | `./dist` | Local dist directory |
| `--remote-dist <path>` | `/home/paschal/claudecluster/dist` | Remote dist directory |

## Plugins

| Plugin | Tools | Description |
|--------|-------|-------------|
| **memory** | 12 | Timeline threads, thoughts, context — Raft-replicated across nodes |
| **cluster-tools** | 8 | Cluster status, membership, sessions, leadership transfer, context sharing |
| **task-engine** | 12 | Persistent task execution, DAG workflows, dead letter queue, node draining |
| **cluster-health** | 2 | Raft health monitoring, term velocity, Telegram alerts, alert squelch |
| **resource-monitor** | — | CPU/GPU/memory/disk monitoring, gaming detection, health reporting |
| **updater** | 1 | ISSU rolling updates with backup, rollback, and "Tap on Shoulder" notifications |
| **kubernetes** | 4 | K8s/K3s cluster discovery, job submission, scaling |
| **skills** | 2 | SKILL.md loader with YAML-frontmatter and hot-reload |
| **messaging** | 6 | Discord, Telegram bots, inbox with read/unread tracking, alert notifications |

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
npm link    # Makes 'cortex' and 'cctl' available globally
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

## MCP Tools (47)

### Memory Plugin (12 tools)
| Tool | Description |
|------|-------------|
| `memory_query` | Query the shared memory database |
| `memory_write` | Write to shared memory (Raft-replicated) |
| `memory_schema` | View database schema |
| `memory_stats` | Database statistics |
| `memory_log_thought` | Log a thought to a timeline thread |
| `memory_whereami` | Active threads, positions, pinned context |
| `memory_handoff` | End-of-session structured summary |
| `memory_set_context` | Set/update pinned context entries |
| `memory_get_context` | Retrieve context by category or key |
| `memory_search` | Full-text search across thoughts |
| `memory_network_lookup` | Query network device inventory |
| `memory_list_threads` | List timeline threads with details |

### Cluster Tools Plugin (8 tools)
| Tool | Description |
|------|-------------|
| `cluster_status` | Get cluster state, leader, and node resources |
| `list_nodes` | List all nodes with status and capabilities |
| `scale_cluster` | Scale cluster membership |
| `list_sessions` | List active MCP sessions |
| `relay_to_session` | Relay a message to another session |
| `publish_context` | Publish context to the cluster |
| `query_context` | Query shared context |
| `transfer_leadership` | Step down current leader, trigger new election |

### Task Engine Plugin (12 tools)
| Tool | Description |
|------|-------------|
| `submit_task` | Submit a task with resource constraints and retry policy |
| `get_task_result` | Get task status and result (persistent in SQLite) |
| `list_tasks` | List/filter tasks by state, workflow, or node |
| `cancel_task` | Cancel a queued or running task |
| `list_dead_letter_tasks` | Inspect tasks that exhausted retries |
| `retry_dead_letter_task` | Manually re-queue a dead letter task |
| `drain_node_tasks` | Gracefully migrate tasks off a node |
| `run_distributed` | Run a command across multiple nodes in parallel |
| `dispatch_subagents` | Launch Claude subagents on multiple nodes |
| `submit_workflow` | Submit a DAG workflow with task dependencies |
| `list_workflows` | List workflows with state filter |
| `get_workflow_status` | Get workflow status with per-task states |

### Cluster Health Plugin (2 tools)
| Tool | Description |
|------|-------------|
| `cluster_health` | Cluster health report: leader stability, term velocity, replication lag, alerts |
| `squelch_alerts` | Suppress/unsquelch health alert notifications for maintenance windows |

### Updater Plugin (1 tool)
| Tool | Description |
|------|-------------|
| `initiate_rolling_update` | ISSU rolling update: backup → sync → restart → verify per node |

### Kubernetes Plugin (4 tools)
| Tool | Description |
|------|-------------|
| `k8s_list_clusters` | List discovered Kubernetes clusters |
| `k8s_submit_job` | Submit a job to K8s/K3s |
| `k8s_get_resources` | Get cluster resource usage |
| `k8s_scale` | Scale a deployment |

### Skills Plugin (2 tools)
| Tool | Description |
|------|-------------|
| `list_skills` | List all loaded SKILL.md skills |
| `get_skill` | Get a skill's full content by name |

### Messaging Plugin (6 tools)
| Tool | Description |
|------|-------------|
| `messaging_send` | Send a message to the inbox |
| `messaging_check` | Check for new unread messages |
| `messaging_list` | List all conversations |
| `messaging_get` | Retrieve a specific message |
| `messaging_gateway_status` | Check bot connection status |
| `messaging_notify` | Send alert notification (used by cluster-health and updater plugins) |

## Configuration

Edit `config/default.yaml` for cluster settings. For local overrides with secrets (bot tokens, API keys), create `config/local.yaml` (gitignored).

### Plugin Configuration

Each node enables/disables plugins independently. Restart required to apply changes.

```yaml
plugins:
  memory:
    enabled: true          # Raft-replicated shared memory (12 tools)
  cluster-tools:
    enabled: true          # Cluster operations (8 tools)
  task-engine:
    enabled: true          # Persistent task execution, DAG workflows (12 tools)
  cluster-health:
    enabled: true          # Raft health monitoring, Telegram alerts (2 tools)
  resource-monitor:
    enabled: true          # CPU/GPU/memory/disk monitoring, gaming detection
  updater:
    enabled: true          # ISSU rolling updates (1 tool)
  kubernetes:
    enabled: false         # K8s adapter (enable on nodes with kubeconfig)
  skills:
    enabled: false         # SKILL.md loader
    directories:
      - ~/.cortex/skills
  messaging:
    enabled: false         # Discord/Telegram bots (enable on leader)
    agent: "Cipher"
    inboxPath: ~/.cortex/inbox
```

### Messaging & Provider Config

```yaml
messaging:
  channels:
    discord:
      enabled: true
      token: ${DISCORD_BOT_TOKEN}
      guildId: "your-guild-id"
    telegram:
      enabled: true
      token: ${TELEGRAM_BOT_TOKEN}

providers:
  primary: anthropic
  fallback:
    - ollama
  anthropic:
    model: claude-sonnet-4-6
    apiKey: ${ANTHROPIC_API_KEY}
  openai:
    model: gpt-4o
    apiKey: ${OPENAI_API_KEY}
  ollama:
    model: llama3.2
    baseUrl: http://localhost:11434
```

## Architecture

```
src/
  index.ts        # Core startup: security → tailscale → gRPC → raft → plugins → MCP
  cli.ts          # CLI subcommands: status, deploy, squelch, switch-leader
  cluster/        # Raft consensus, membership, state, scheduling, ISSU, announcements
  grpc/           # gRPC server, client pool, service handlers
  discovery/      # Tailscale mesh discovery, node approval
  memory/         # SharedMemoryDB (csm), Raft replication, memory MCP tools
  agent/          # Resource monitor, task executor, health reporter, gaming detection
  messaging/      # Gateway (leader-only), Discord/Telegram adapters, inbox
  providers/      # LLM routing — Anthropic, OpenAI, Ollama with fallback
  skills/         # SKILL.md loader with frontmatter parsing
  mcp/            # MCP server, tool/resource factories
  kubernetes/     # K8s/K3s job submission
  security/       # mTLS, auth, secrets
  plugins/        # Plugin architecture
    types.ts      # Plugin, PluginContext, ToolHandler interfaces
    loader.ts     # PluginLoader — init, start, stop lifecycle
    registry.ts   # Built-in plugin registry (9 plugins)
    memory/       # Memory plugin — wraps csm tools
    cluster-tools/ # Cluster tools plugin — cluster ops + leadership
    cluster-health/ # Cluster health plugin — monitoring + Telegram alerts
    task-engine/  # Task engine plugin — persistent tasks, DAG workflows
    kubernetes/   # Kubernetes plugin — K8s adapter + tools
    resource-monitor/ # Resource monitor plugin — CPU/GPU/disk + gaming detection
    updater/      # Updater plugin — ISSU rolling updates with tap-on-shoulder
    skills/       # Skills plugin — SKILL.md hot-reload
    messaging/    # Messaging plugin — Discord/Telegram bots + alert notifications
```

### Plugin Lifecycle

```
1. Core init   → Security, Tailscale, gRPC, Raft, SharedMemoryDB
2. Plugin init → pluginLoader.loadAll() — validate config, set up state
3. Cluster join → joinOrCreateCluster()
4. Plugin start → pluginLoader.startAll() — background work, event listeners
5. MCP start   → Merged tools/resources from all plugins
6. Shutdown    → pluginLoader.stopAll() (reverse order) → core stop
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
