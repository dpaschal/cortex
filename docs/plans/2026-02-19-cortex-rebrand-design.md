# Cortex Rebrand Design

**Date:** 2026-02-19
**Status:** Approved

## Context

claudecluster started as a P2P compute mesh for Claude sessions but has grown into a full personal AI infrastructure platform — messaging bots, multi-provider LLM routing, skill system, distributed state, device mesh, rolling updates. The name "claudecluster" is limiting and doesn't reflect the project's scope.

## Decision Record

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Name | Cortex | Sci-fi, implies intelligence and coordination, describes distributed mesh |
| Visual identity | Teal neon wireframe on black | Based on paschal-wallpaper.png aesthetic |
| paschal.ai | Portfolio + Cortex featured | Keep engineering portfolio, replace Cerebrus with Cortex |
| Scope | Full rebrand | Repo, npm, class names, systemd, config dirs, CLI, website |

## Section 1: Name & Identity

**Name:** Cortex
**Tagline:** Distributed AI Mesh

### Rename Map

| Current | Cortex |
|---------|--------|
| `claudecluster` (repo) | `cortex` |
| `claudecluster` (npm package) | `cortex-mesh` |
| `ClaudeCluster` (class) | `Cortex` |
| `ClusterConfig` (type) | `CortexConfig` |
| `claudecluster.service` (systemd) | `cortex.service` |
| `~/.claudecluster/` (data dir) | `~/.cortex/` |
| `claudecluster` (MCP server name) | `cortex` |
| GitHub repo | `dpaschal/cortex` |

## Section 2: paschal.ai + Visual Identity

### Logo

- **Style:** Teal neon wireframe on black background (based on `paschal-wallpaper.png`)
- **Shape:** Convergent mesh lines connecting to node points
- **Text:** "CORTEX" in clean wireframe/tech font, cyan glow
- **Subtext:** "Distributed AI Mesh"

### paschal.ai Site

- **Remove** Cerebrus "coming soon" banner
- **Keep** dark theme, match teal/cyan/black palette from logo
- **Hero:** paschal.ai branding + "Let us help..." tagline
- **Featured project:** Cortex section with feature highlights
- **Service keywords:** plug-in, resolve, optimize, modernize, automate (unchanged)
- **Footer:** "All systems operational" with live Cortex cluster status
- **GitHub link** to dpaschal/cortex

## Section 3: Feature & Module Map

### Core Platform

| Module | Directory | Description |
|--------|-----------|-------------|
| Mesh | `src/cluster/` | Raft consensus, leader election, membership, distributed state, task scheduling |
| Transport | `src/grpc/` | gRPC + Protocol Buffers for inter-node RPC |
| Discovery | `src/discovery/` | Tailscale mesh discovery, node approval workflows |
| Security | `src/security/` | mTLS, auth/authz, secrets management |
| Updates | `src/cluster/updater.ts` | ISSU rolling updates with backup/rollback |

### Agent (per-node)

| Module | Directory | Description |
|--------|-----------|-------------|
| Resources | `src/agent/` | CPU/GPU/memory monitoring, gaming detection, health reporting |
| Executor | `src/agent/` | Task execution on local node |
| K8s | `src/kubernetes/` | Job submission to K8s/K3s clusters |

### Messaging (absorbed from OpenClaw)

| Module | Directory | Description |
|--------|-----------|-------------|
| Gateway | `src/messaging/gateway.ts` | Raft-aware leader-only bot activation with automatic failover |
| Discord | `src/messaging/channels/discord.ts` | @DALEK bot adapter |
| Telegram | `src/messaging/channels/telegram.ts` | @Cipher1112222Bot adapter |
| Inbox | `src/messaging/inbox.ts` | Message storage, read/unread tracking, archival |

### Intelligence

| Module | Directory | Description |
|--------|-----------|-------------|
| Providers | `src/providers/` | Multi-LLM routing — Anthropic, OpenAI, Ollama with fallback chain |
| Skills | `src/skills/` | SKILL.md loader with YAML frontmatter, hot-reload |

### Integration

| Module | Directory | Description |
|--------|-----------|-------------|
| MCP Server | `src/mcp/` | Claude Code tools — cluster ops, messaging, skills, timeline, context, network |

### Nodes

| Node | Role | Hardware | Always on? |
|------|------|----------|-----------|
| forge | Seed/Leader | Fedora server, K3s, ZFS | Yes |
| gauntlet | Follower | CachyOS desktop, RTX GPU | Yes |
| terminus | Leader-eligible | Workstation | Yes |
| htnas02 | Worker | NAS, ZFS, Plex, Ollama | Yes |
| rog2 | Leader-eligible | Gaming PC | Offline |

### CLI Commands

| Current | Cortex |
|---------|--------|
| `claudecluster start` | `cortex start` |
| `claudecluster --mcp` | `cortex --mcp` |
| `claudecluster --seed <addr>` | `cortex --seed <addr>` |
| `systemctl status claudecluster` | `systemctl status cortex` |
| `journalctl -u claudecluster` | `journalctl -u cortex` |
