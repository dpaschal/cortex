# Cortex - Project Instructions

## Superpowers Integration

This project uses the **superpowers** plugin for all development work. Before starting any implementation task:

1. Check `/skills` for relevant superpowers skills
2. Use `/superpowers:brainstorm` for new features or significant changes
3. Use `/superpowers:write-plan` before implementation
4. Use `/superpowers:execute-plan` for systematic task execution

### Required Workflows

- **New Features**: Always start with brainstorming phase
- **Implementation**: Follow TDD (test-driven development) - write failing tests first
- **Code Changes**: Use git worktrees for isolated development branches
- **Reviews**: Request code review between major tasks

## Project Context

Cortex is a distributed AI mesh for peer-to-peer compute:

- **Raft consensus** for leader election across nodes
- **gRPC + Protocol Buffers** for inter-node communication
- **Tailscale** for network discovery and secure mesh
- **MCP Server** integration for Claude Code tools
- **Kubernetes** hybrid support (GKE/K8s/K3s)

### Key Directories

- `src/cluster/` - Raft, scheduling, membership, state management
- `src/agent/` - Resource monitoring, task execution, benchmarking
- `src/grpc/` - gRPC server and client implementations
- `src/mcp/` - MCP server with tools and resources
- `src/kubernetes/` - K8s adapter for job submission
- `src/discovery/` - Tailscale discovery and node approval
- `src/security/` - mTLS, auth, secrets management
- `proto/` - Protocol Buffer definitions

### Cluster Nodes

All nodes run `cortex.service` and advertise `tag:cortex` on Tailscale.

| Node | Tailscale IP | Role | Status |
|------|--------------|------|--------|
| forge | 100.94.211.117 | Leader (seed) | cortex.service, auto-start |
| gauntlet | 100.85.61.124 | Follower | cortex.service, auto-start |
| hammer | 100.73.18.82 | Follower | cortex.service, auto-start |
| htnas02 | 100.103.240.34 | Follower (72c/756GB/Tesla P4) | cortex.service, auto-start |
| anvil | 100.69.42.106 | Follower (NixOS, hosts cerebrus DB) | NixOS cortex.service, auto-start |
| terminus | 100.120.202.76 | Leader eligible | cortex.service, auto-start |
| rog2 | 100.104.78.123 | Leader eligible | offline (gaming PC) |

## Pending Tasks

### Build multi-architecture auto-install USB

**Priority:** Medium

Create a USB installer that works on both x86_64 and aarch64 hardware (Intel/AMD PCs and ARM devices like Raspberry Pi, M1+ Macs).

**Current state:**
- x86_64 NixOS auto-installer USB exists at `/tmp/nixos-cluster/`
- meshbridge (Pi 4B+ at 192.168.4.38) available for aarch64 builds
- Nix needs to be installed on meshbridge first

**Steps:**
1. Install Nix on meshbridge: `curl -L https://nixos.org/nix/install | sh -s -- --daemon`
2. Update flake.nix to output both `packages.x86_64-linux.installer-iso` and `packages.aarch64-linux.installer-iso`
3. Build aarch64 ISO on meshbridge
4. Combine both ISOs onto single USB with dual EFI bootloaders:
   - `/EFI/BOOT/BOOTX64.EFI` for x86_64
   - `/EFI/BOOT/BOOTAA64.EFI` for aarch64
5. Install script should detect arch with `uname -m` and use appropriate squashfs

**Reference:** meshbridge.local (192.168.4.38), user: paschal

---

### Fix terminus persistent node ID

**Priority:** Low (cluster works, just cosmetic)

The terminus node doesn't have a persistent node ID file, so it generates a random ID on each restart instead of using the `hostname-shortid` format.

**To fix on terminus:**
```bash
mkdir -p ~/.cortex
echo "60919007" > ~/.cortex/node-id
# After restart, node ID will be: terminus-60919007
```

Or regenerate a fresh one:
```bash
mkdir -p ~/.cortex
echo "$(uuidgen | cut -c1-8)" > ~/.cortex/node-id
```

---

### Move all services from anvil to forge and decommission anvil

**Priority:** Medium

Migrate everything running on anvil (NixOS, 192.168.1.138) to forge (10GbE infra server). Then decommission anvil.

Services on anvil: cortex node, PostgreSQL (cerebrus DB), Syncthing, KeePass vault sync, SSH.

---

### Backup terminus and re-image with CachyOS

**Priority:** Low

Backup main stuff from terminus (dotfiles, claudecluster repo, cortex config, SSH keys), then re-image it with CachyOS.

---

## Development Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript + generate proto types
npm run dev          # Development mode with watch
npm run test         # Run tests
npm start            # Start cluster node
```

## CLI Commands

```bash
cctl status                 # Cluster health, leader, nodes, tasks
cctl deploy                 # Build → sync → rolling restart → verify
cctl deploy --no-build      # Sync and restart only (skip build)
cctl squelch 10             # Suppress health alerts for 10 minutes
cctl squelch 0              # Re-enable alerts
cctl switch-leader forge    # Step down leader, prefer forge in next election
```

When adding new CLI subcommands, also add the command name to `CLI_COMMANDS` array in `src/index.ts`.

## Tech Stack

- TypeScript / Node.js 20+
- gRPC + Protocol Buffers
- MCP SDK for Claude Code integration
- Kubernetes client-node
- systeminformation for resource monitoring
- Winston for logging
