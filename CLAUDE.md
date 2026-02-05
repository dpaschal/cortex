# Claude Cluster - Project Instructions

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

Claude Cluster is a peer-to-peer compute mesh for distributed Claude sessions:

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

### Initial Cluster Nodes

| Node | Tailscale IP | Role | Node ID |
|------|--------------|------|---------|
| rog2 | 100.104.78.123 | Leader eligible | `rog2-8e800054` |
| terminus-1 | 100.120.202.76 | Leader eligible | needs fix (see below) |
| forge | 100.94.211.117 | Leader eligible | - |
| htnas02 | 100.103.240.34 | Worker | - |

## Pending Tasks

### Fix terminus persistent node ID

**Priority:** Low (cluster works, just cosmetic)

The terminus node doesn't have a persistent node ID file, so it generates a random ID on each restart instead of using the `hostname-shortid` format.

**To fix on terminus:**
```bash
mkdir -p ~/.claudecluster
echo "60919007" > ~/.claudecluster/node-id
# After restart, node ID will be: terminus-60919007
```

Or regenerate a fresh one:
```bash
mkdir -p ~/.claudecluster
echo "$(uuidgen | cut -c1-8)" > ~/.claudecluster/node-id
```

## Development Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript + generate proto types
npm run dev          # Development mode with watch
npm run test         # Run tests
npm start            # Start cluster node
```

## Tech Stack

- TypeScript / Node.js 20+
- gRPC + Protocol Buffers
- MCP SDK for Claude Code integration
- Kubernetes client-node
- systeminformation for resource monitoring
- Winston for logging
