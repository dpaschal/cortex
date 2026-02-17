# ISSU Rolling Update Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a leader-orchestrated rolling updater that rsyncs dist/ to followers, restarts them one at a time maintaining quorum, with Brocade-style rollback and NetApp-style stabilization.

**Architecture:** `RollingUpdater` class in `src/cluster/updater.ts` orchestrates 4 phases (preflight → add → activate+stabilize → commit/rollback). Uses existing `AgentClient.executeTask()` for remote shell commands and `AgentClient.healthCheck()` for post-restart verification. MCP tool `initiate_rolling_update` exposes it to Claude Code.

**Tech Stack:** TypeScript, existing gRPC client (`AgentClient`), existing Raft/Membership APIs, Node.js `child_process` for leader self-restart, `crypto` for build hashing.

---

## Task 1: Create `scripts/write-version.js`

**Files:**
- Create: `scripts/write-version.js`
- Modify: `package.json` (build script)

**Step 1: Write the version stamper script**

Create `scripts/write-version.js`:

```javascript
#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const distDir = path.join(__dirname, '..', 'dist');

// Hash all files in dist/ (excluding version.json itself)
function hashDistDir(dir) {
  const hash = crypto.createHash('sha256');
  const files = [];

  function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const fullPath = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name !== 'version.json') {
        files.push(fullPath);
      }
    }
  }

  walk(dir);
  files.sort(); // Deterministic ordering

  for (const file of files) {
    hash.update(fs.readFileSync(file));
  }

  return hash.digest('hex').slice(0, 12);
}

// Get git commit
let gitCommit = 'unknown';
try {
  gitCommit = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
} catch {
  // Not in a git repo or git not available
}

const version = {
  buildHash: hashDistDir(distDir),
  builtAt: new Date().toISOString(),
  gitCommit,
};

const outputPath = path.join(distDir, 'version.json');
fs.writeFileSync(outputPath, JSON.stringify(version, null, 2) + '\n');
console.log(`Wrote ${outputPath}:`, version);
```

**Step 2: Update package.json build script**

Change the `build` script in `package.json` from:
```
"build": "npm run proto:generate && tsc",
```
to:
```
"build": "npm run proto:generate && tsc && node scripts/write-version.js",
```

**Step 3: Verify**

Run: `npm run build`

Expected: Build succeeds, `dist/version.json` created with `buildHash`, `builtAt`, `gitCommit` fields.

Run: `cat dist/version.json`

Expected: JSON with all three fields populated.

**Step 4: Commit**

```bash
git add scripts/write-version.js package.json
git commit -m "feat: add build-time version stamping (dist/version.json)"
```

---

## Task 2: Create `RollingUpdater` — preflight method

**Files:**
- Create: `src/cluster/updater.ts`
- Create: `tests/updater.test.ts`

**Step 1: Write the failing test for preflight**

Create `tests/updater.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RollingUpdater, UpdateResult } from '../src/cluster/updater.js';
import { MembershipManager, NodeInfo } from '../src/cluster/membership.js';
import { RaftNode, PeerInfo } from '../src/cluster/raft.js';
import { GrpcClientPool } from '../src/grpc/client.js';
import { Logger } from 'winston';

// Mocks
const createMockLogger = (): Logger => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger);

function createMockNode(overrides: Partial<NodeInfo> = {}): NodeInfo {
  return {
    nodeId: overrides.nodeId ?? 'node-1',
    hostname: overrides.hostname ?? 'host-1',
    tailscaleIp: overrides.tailscaleIp ?? '100.0.0.1',
    grpcPort: overrides.grpcPort ?? 50051,
    role: overrides.role ?? 'follower',
    status: overrides.status ?? 'active',
    resources: overrides.resources ?? null,
    tags: overrides.tags ?? [],
    joinedAt: overrides.joinedAt ?? Date.now(),
    lastSeen: overrides.lastSeen ?? Date.now(),
  };
}

function createMockPeer(overrides: Partial<PeerInfo> = {}): PeerInfo {
  return {
    nodeId: overrides.nodeId ?? 'node-1',
    address: overrides.address ?? '100.0.0.1:50051',
    nextIndex: overrides.nextIndex ?? 1,
    matchIndex: overrides.matchIndex ?? 0,
    votingMember: overrides.votingMember ?? true,
  };
}

function createUpdater(overrides: {
  nodes?: NodeInfo[];
  peers?: PeerInfo[];
  isLeader?: boolean;
  selfNodeId?: string;
} = {}) {
  const selfNodeId = overrides.selfNodeId ?? 'leader-1';
  const mockLogger = createMockLogger();

  const mockMembership = {
    getAllNodes: vi.fn().mockReturnValue(overrides.nodes ?? [
      createMockNode({ nodeId: selfNodeId, role: 'leader' }),
      createMockNode({ nodeId: 'follower-1' }),
      createMockNode({ nodeId: 'follower-2' }),
      createMockNode({ nodeId: 'follower-3' }),
    ]),
    getNode: vi.fn((id: string) => {
      const nodes = overrides.nodes ?? [];
      return nodes.find(n => n.nodeId === id);
    }),
  } as unknown as MembershipManager;

  const mockRaft = {
    isLeader: vi.fn().mockReturnValue(overrides.isLeader ?? true),
    getPeers: vi.fn().mockReturnValue(overrides.peers ?? [
      createMockPeer({ nodeId: 'follower-1' }),
      createMockPeer({ nodeId: 'follower-2' }),
      createMockPeer({ nodeId: 'follower-3' }),
    ]),
  } as unknown as RaftNode;

  const mockClientPool = {
    closeConnection: vi.fn(),
  } as unknown as GrpcClientPool;

  const updater = new RollingUpdater({
    membership: mockMembership,
    raft: mockRaft,
    clientPool: mockClientPool,
    logger: mockLogger,
    selfNodeId,
    distDir: '/home/paschal/claudecluster/dist',
    heartbeatIntervalMs: 5000,
  });

  return { updater, mockMembership, mockRaft, mockClientPool, mockLogger };
}

describe('RollingUpdater', () => {
  describe('preflight', () => {
    it('should pass with 4 healthy nodes and leader', async () => {
      const { updater } = createUpdater();
      const result = await updater.preflight();
      expect(result.ok).toBe(true);
    });

    it('should fail if not leader', async () => {
      const { updater } = createUpdater({ isLeader: false });
      const result = await updater.preflight();
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('leader');
    });

    it('should fail if quorum cannot tolerate losing 1 node', async () => {
      // 2 voting nodes: quorum=2, can't lose any
      const { updater } = createUpdater({
        nodes: [
          createMockNode({ nodeId: 'leader-1', role: 'leader' }),
          createMockNode({ nodeId: 'follower-1' }),
        ],
        peers: [
          createMockPeer({ nodeId: 'follower-1' }),
        ],
      });
      const result = await updater.preflight();
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('quorum');
    });

    it('should fail if any node is offline', async () => {
      const { updater } = createUpdater({
        nodes: [
          createMockNode({ nodeId: 'leader-1', role: 'leader' }),
          createMockNode({ nodeId: 'follower-1' }),
          createMockNode({ nodeId: 'follower-2', status: 'offline' }),
          createMockNode({ nodeId: 'follower-3' }),
        ],
      });
      const result = await updater.preflight();
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('follower-2');
    });

    it('should fail if a node has stale lastSeen', async () => {
      const staleTime = Date.now() - 30000; // 30s ago, > 2x heartbeat (5s)
      const { updater } = createUpdater({
        nodes: [
          createMockNode({ nodeId: 'leader-1', role: 'leader' }),
          createMockNode({ nodeId: 'follower-1' }),
          createMockNode({ nodeId: 'follower-2', lastSeen: staleTime }),
          createMockNode({ nodeId: 'follower-3' }),
        ],
      });
      const result = await updater.preflight();
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('stale');
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/updater.test.ts`

Expected: FAIL — `RollingUpdater` not found.

**Step 3: Write the RollingUpdater class with preflight**

Create `src/cluster/updater.ts`:

```typescript
import { EventEmitter } from 'events';
import { Logger } from 'winston';
import { RaftNode, PeerInfo } from './raft.js';
import { MembershipManager, NodeInfo } from './membership.js';
import { AgentClient, GrpcClientPool } from '../grpc/client.js';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';

export interface UpdaterConfig {
  membership: MembershipManager;
  raft: RaftNode;
  clientPool: GrpcClientPool;
  logger: Logger;
  selfNodeId: string;
  distDir: string;
  heartbeatIntervalMs?: number;
}

export interface PreflightResult {
  ok: boolean;
  reason?: string;
  nodes: NodeInfo[];
  followers: NodeInfo[];
  quorumSize: number;
  votingCount: number;
}

export interface UpdateProgress {
  phase: 'preflight' | 'add' | 'activate' | 'stabilize' | 'commit' | 'rollback' | 'leader-restart' | 'complete' | 'aborted';
  nodeId?: string;
  message: string;
}

export type UpdateResult = {
  success: boolean;
  nodesUpdated: string[];
  nodesRolledBack: string[];
  error?: string;
};

export class RollingUpdater extends EventEmitter {
  private config: UpdaterConfig;
  private heartbeatMs: number;

  constructor(config: UpdaterConfig) {
    super();
    this.config = config;
    this.heartbeatMs = config.heartbeatIntervalMs ?? 5000;
  }

  /**
   * Phase 0: Pre-flight checks.
   * Verifies leader status, quorum safety, and node health.
   */
  async preflight(): Promise<PreflightResult> {
    const { raft, membership, selfNodeId } = this.config;

    // Must be leader
    if (!raft.isLeader()) {
      return {
        ok: false,
        reason: 'Rolling update must be initiated from the leader node',
        nodes: [], followers: [], quorumSize: 0, votingCount: 0,
      };
    }

    // Enumerate nodes
    const allNodes = membership.getAllNodes();
    const followers = allNodes.filter(n => n.nodeId !== selfNodeId);

    // Quorum math
    const votingPeers = raft.getPeers().filter((p: PeerInfo) => p.votingMember);
    const votingCount = votingPeers.length + 1; // +1 for self
    const quorumSize = Math.floor(votingCount / 2) + 1;
    const canLose = votingCount - quorumSize;

    if (canLose < 1) {
      return {
        ok: false,
        reason: `Quorum unsafe: ${votingCount} voting nodes, quorum=${quorumSize}, can lose ${canLose} (need at least 1)`,
        nodes: allNodes, followers, quorumSize, votingCount,
      };
    }

    // Health gate: all nodes must be active
    const unhealthy = allNodes.filter(n => n.status !== 'active');
    if (unhealthy.length > 0) {
      const names = unhealthy.map(n => `${n.nodeId} (${n.status})`).join(', ');
      return {
        ok: false,
        reason: `Unhealthy nodes: ${names}`,
        nodes: allNodes, followers, quorumSize, votingCount,
      };
    }

    // Freshness gate: all nodes must have recent lastSeen
    const staleThreshold = Date.now() - (this.heartbeatMs * 2);
    const staleNodes = followers.filter(n => n.lastSeen < staleThreshold);
    if (staleNodes.length > 0) {
      const names = staleNodes.map(n => `${n.nodeId} (stale ${Math.round((Date.now() - n.lastSeen) / 1000)}s)`).join(', ');
      return {
        ok: false,
        reason: `Nodes with stale heartbeats: ${names}`,
        nodes: allNodes, followers, quorumSize, votingCount,
      };
    }

    return {
      ok: true,
      nodes: allNodes,
      followers,
      quorumSize,
      votingCount,
    };
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/updater.test.ts`

Expected: All 5 preflight tests pass.

**Step 5: Commit**

```bash
git add src/cluster/updater.ts tests/updater.test.ts
git commit -m "feat(issu): add RollingUpdater with preflight checks"
```

---

## Task 3: Add `runShellOnNode` helper and Phase 1 (Add)

**Files:**
- Modify: `src/cluster/updater.ts`
- Modify: `tests/updater.test.ts`

**Step 1: Write the failing test for runShellOnNode and upgradeFollower Phase 1**

Add to `tests/updater.test.ts`:

```typescript
// Add these imports at top:
import { AgentClient } from '../src/grpc/client.js';

// Mock AgentClient
vi.mock('../src/grpc/client.js', async () => {
  const actual = await vi.importActual('../src/grpc/client.js');
  return {
    ...actual,
    AgentClient: vi.fn(),
  };
});

describe('runShellOnNode', () => {
  it('should execute a shell command on a remote node and return stdout', async () => {
    const { updater } = createUpdater();

    // Mock AgentClient.executeTask to return stdout
    const mockExecuteTask = vi.fn().mockImplementation(async function* () {
      yield { output: { type: 'stdout', data: Buffer.from('OK\n') } };
      yield { status: { exit_code: 0 } };
    });
    (AgentClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      executeTask: mockExecuteTask,
    }));

    const result = await updater.runShellOnNode(
      createMockNode({ tailscaleIp: '100.0.0.2', grpcPort: 50051 }),
      'echo OK'
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('OK');
  });

  it('should return non-zero exit code on failure', async () => {
    const { updater } = createUpdater();

    const mockExecuteTask = vi.fn().mockImplementation(async function* () {
      yield { output: { type: 'stderr', data: Buffer.from('not found\n') } };
      yield { status: { exit_code: 1 } };
    });
    (AgentClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      executeTask: mockExecuteTask,
    }));

    const result = await updater.runShellOnNode(
      createMockNode(),
      'false'
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not found');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/updater.test.ts`

Expected: FAIL — `runShellOnNode` not found.

**Step 3: Implement `runShellOnNode`**

Add to `src/cluster/updater.ts` inside the `RollingUpdater` class:

```typescript
  /**
   * Execute a shell command on a remote node via AgentClient.executeTask().
   * Returns stdout, stderr, and exit code.
   */
  async runShellOnNode(
    node: NodeInfo,
    command: string,
    timeoutMs: number = 120000
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const address = `${node.tailscaleIp}:${node.grpcPort}`;
    const agent = new AgentClient(this.config.clientPool, address);

    let stdout = '';
    let stderr = '';
    let exitCode = -1;

    const request = {
      spec: {
        task_id: randomUUID(),
        type: 'TASK_TYPE_SHELL',
        submitter_node: this.config.selfNodeId,
        shell: {
          command,
          working_directory: this.config.distDir.replace('/dist', ''),
        },
        timeout_ms: timeoutMs.toString(),
      },
    };

    try {
      for await (const response of agent.executeTask(request)) {
        if (response.output) {
          const data = response.output.data?.toString() ?? '';
          if (response.output.type === 'stdout' || response.output.type === 'TASK_OUTPUT_STDOUT') {
            stdout += data;
          } else {
            stderr += data;
          }
        }
        if (response.status) {
          exitCode = response.status.exit_code ?? -1;
        }
      }
    } catch (error) {
      // Connection drop during restart is expected — see Phase 2
      throw error;
    }

    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
  }
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/updater.test.ts`

Expected: All tests pass.

**Step 5: Commit**

```bash
git add src/cluster/updater.ts tests/updater.test.ts
git commit -m "feat(issu): add runShellOnNode helper for remote command execution"
```

---

## Task 4: Implement Phase 1 (Add) + Phase 2 (Activate) + Phase 3 (Commit/Rollback)

**Files:**
- Modify: `src/cluster/updater.ts`
- Modify: `tests/updater.test.ts`

**Step 1: Write the failing test for upgradeFollower**

Add to `tests/updater.test.ts`:

```typescript
describe('upgradeFollower', () => {
  it('should backup, rsync, verify, restart, stabilize, and commit', async () => {
    const { updater, mockClientPool } = createUpdater();
    const follower = createMockNode({ nodeId: 'follower-1', tailscaleIp: '100.0.0.2' });

    let callCount = 0;
    const mockExecuteTask = vi.fn().mockImplementation(async function* () {
      callCount++;
      // All shell commands succeed
      yield { output: { type: 'stdout', data: Buffer.from('ok\n') } };
      yield { status: { exit_code: 0 } };
    });
    const mockHealthCheck = vi.fn().mockResolvedValue({ healthy: true });

    (AgentClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      executeTask: mockExecuteTask,
      healthCheck: mockHealthCheck,
    }));

    // Mock membership returning the follower as active after restart
    const { mockMembership } = createUpdater();
    // We need the updater to see the follower as active in waitForStabilization
    // The real test is that the method completes without error

    const result = await updater.upgradeFollower(follower);
    expect(result.success).toBe(true);
    expect(result.rolledBack).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/updater.test.ts`

Expected: FAIL — `upgradeFollower` not found.

**Step 3: Implement upgradeFollower, rollbackNode, waitForStabilization**

Add to `src/cluster/updater.ts`:

```typescript
  /**
   * Phases 1-3 for a single follower: Add (backup+rsync+verify) → Activate (restart+healthcheck+stabilize) → Commit or Rollback.
   */
  async upgradeFollower(node: NodeInfo): Promise<{ success: boolean; rolledBack: boolean; error?: string }> {
    const nodeId = node.nodeId;
    const address = `${node.tailscaleIp}:${node.grpcPort}`;
    const distDir = this.config.distDir;
    const selfNode = this.config.membership.getAllNodes().find(n => n.nodeId === this.config.selfNodeId);
    const leaderIp = selfNode?.tailscaleIp ?? '127.0.0.1';

    try {
      // --- Phase 1: Add ---

      // Backup
      this.progress('add', nodeId, 'Backing up dist/ to dist.bak/');
      const backup = await this.runShellOnNode(node, `cd ${distDir}/.. && rm -rf dist.bak && cp -a dist dist.bak`);
      if (backup.exitCode !== 0) {
        return { success: false, rolledBack: false, error: `Backup failed: ${backup.stderr}` };
      }

      // Rsync
      this.progress('add', nodeId, 'Syncing new dist/ from leader');
      const rsync = await this.runShellOnNode(node, `rsync -az --delete ${leaderIp}:${distDir}/ ${distDir}/`);
      if (rsync.exitCode !== 0) {
        this.progress('rollback', nodeId, 'Rsync failed, restoring backup');
        await this.rollbackNode(node);
        return { success: false, rolledBack: true, error: `Rsync failed: ${rsync.stderr}` };
      }

      // Verify
      this.progress('add', nodeId, 'Verifying version.json');
      const verify = await this.runShellOnNode(node, `cat ${distDir}/version.json`);
      if (verify.exitCode !== 0) {
        this.progress('rollback', nodeId, 'Version verify failed, restoring backup');
        await this.rollbackNode(node);
        return { success: false, rolledBack: true, error: `Version verify failed: ${verify.stderr}` };
      }

      // --- Phase 2: Activate ---

      // Restart
      this.progress('activate', nodeId, 'Restarting claudecluster service');
      try {
        await this.runShellOnNode(node, 'systemctl restart claudecluster', 10000);
      } catch {
        // Expected: connection drops when the service restarts
        this.progress('activate', nodeId, 'Connection dropped (expected during restart)');
      }

      // Close stale gRPC connection
      this.config.clientPool.closeConnection(address);

      // Poll healthCheck
      this.progress('activate', nodeId, 'Polling health check...');
      const healthy = await this.pollHealthCheck(node, 60000);
      if (!healthy) {
        this.progress('rollback', nodeId, 'Health check timed out, rolling back');
        await this.rollbackNode(node);
        return { success: false, rolledBack: true, error: 'Health check timed out after 60s' };
      }

      // Stabilization
      this.progress('stabilize', nodeId, 'Waiting for stabilization (3 heartbeat cycles)...');
      const stable = await this.waitForStabilization(node, this.heartbeatMs * 4);
      if (!stable) {
        this.progress('rollback', nodeId, 'Stabilization failed, rolling back');
        await this.rollbackNode(node);
        return { success: false, rolledBack: true, error: 'Node did not stabilize after restart' };
      }

      // --- Phase 3: Commit ---
      this.progress('commit', nodeId, 'Removing dist.bak/ (commit)');
      await this.runShellOnNode(node, `rm -rf ${distDir}/../dist.bak`);

      this.progress('complete', nodeId, 'Upgrade committed successfully');
      return { success: true, rolledBack: false };

    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.progress('rollback', nodeId, `Unexpected error: ${msg}`);
      try {
        await this.rollbackNode(node);
      } catch {
        // Best effort rollback
      }
      return { success: false, rolledBack: true, error: msg };
    }
  }

  /**
   * Rollback a node: restore dist.bak and restart.
   */
  async rollbackNode(node: NodeInfo): Promise<void> {
    const distDir = this.config.distDir;
    const address = `${node.tailscaleIp}:${node.grpcPort}`;

    try {
      await this.runShellOnNode(node, `cd ${distDir}/.. && rm -rf dist && mv dist.bak dist`);
    } catch {
      // If we can't reach the node, try after closing the connection
      this.config.clientPool.closeConnection(address);
      try {
        await this.runShellOnNode(node, `cd ${distDir}/.. && rm -rf dist && mv dist.bak dist`);
      } catch {
        this.config.logger.error('Failed to rollback node — manual intervention required', { nodeId: node.nodeId });
        return;
      }
    }

    try {
      await this.runShellOnNode(node, 'systemctl restart claudecluster', 10000);
    } catch {
      // Expected connection drop
    }

    this.config.clientPool.closeConnection(address);
  }

  /**
   * Poll healthCheck until healthy or timeout.
   */
  private async pollHealthCheck(node: NodeInfo, timeoutMs: number): Promise<boolean> {
    const address = `${node.tailscaleIp}:${node.grpcPort}`;
    const deadline = Date.now() + timeoutMs;
    const pollIntervalMs = 2000;

    while (Date.now() < deadline) {
      try {
        const agent = new AgentClient(this.config.clientPool, address);
        const response = await agent.healthCheck();
        if (response.healthy) {
          return true;
        }
      } catch {
        // Not ready yet
      }
      await this.sleep(pollIntervalMs);
    }

    return false;
  }

  /**
   * Wait for a node to be active in membership with fresh heartbeats.
   */
  private async waitForStabilization(node: NodeInfo, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const current = this.config.membership.getAllNodes().find(n => n.nodeId === node.nodeId);
      if (current && current.status === 'active') {
        const age = Date.now() - current.lastSeen;
        if (age < this.heartbeatMs * 2) {
          return true;
        }
      }
      await this.sleep(1000);
    }

    return false;
  }

  private progress(phase: UpdateProgress['phase'], nodeId: string, message: string): void {
    const event: UpdateProgress = { phase, nodeId, message };
    this.config.logger.info(`[ISSU] ${phase} ${nodeId}: ${message}`);
    this.emit('progress', event);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/updater.test.ts`

Expected: All tests pass.

**Step 5: Commit**

```bash
git add src/cluster/updater.ts tests/updater.test.ts
git commit -m "feat(issu): add upgradeFollower with backup/rsync/restart/stabilize/commit/rollback"
```

---

## Task 5: Implement `execute()` orchestrator (Phases 0-4)

**Files:**
- Modify: `src/cluster/updater.ts`
- Modify: `tests/updater.test.ts`

**Step 1: Write the failing test**

Add to `tests/updater.test.ts`:

```typescript
describe('execute', () => {
  it('should return preflight failure on dry run with unhealthy cluster', async () => {
    const { updater } = createUpdater({
      nodes: [
        createMockNode({ nodeId: 'leader-1', role: 'leader' }),
        createMockNode({ nodeId: 'follower-1', status: 'offline' }),
        createMockNode({ nodeId: 'follower-2' }),
        createMockNode({ nodeId: 'follower-3' }),
      ],
    });

    const result = await updater.execute({ dryRun: true });
    expect(result.success).toBe(false);
    expect(result.error).toContain('follower-1');
  });

  it('should report success on dry run with healthy cluster', async () => {
    const { updater } = createUpdater();
    const result = await updater.execute({ dryRun: true });
    expect(result.success).toBe(true);
    expect(result.nodesUpdated).toHaveLength(0); // dry run, no actual updates
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/updater.test.ts`

Expected: FAIL — `execute` not found.

**Step 3: Implement `execute()`**

Add to `src/cluster/updater.ts`:

```typescript
  /**
   * Execute the full rolling update (Phases 0-4).
   * dryRun: true runs only preflight and reports results.
   */
  async execute(options: { dryRun?: boolean } = {}): Promise<UpdateResult> {
    const nodesUpdated: string[] = [];
    const nodesRolledBack: string[] = [];

    // Phase 0: Preflight
    this.progress('preflight', this.config.selfNodeId, 'Running pre-flight checks');
    const preflight = await this.preflight();

    if (!preflight.ok) {
      this.progress('aborted', this.config.selfNodeId, `Pre-flight failed: ${preflight.reason}`);
      return { success: false, nodesUpdated, nodesRolledBack, error: preflight.reason };
    }

    this.progress('preflight', this.config.selfNodeId,
      `Pre-flight passed: ${preflight.votingCount} voting nodes, quorum=${preflight.quorumSize}, ${preflight.followers.length} followers to update`);

    if (options.dryRun) {
      return { success: true, nodesUpdated, nodesRolledBack };
    }

    // Phases 1-3: Upgrade each follower sequentially
    for (const follower of preflight.followers) {
      this.progress('add', follower.nodeId, `Starting upgrade (${nodesUpdated.length + 1}/${preflight.followers.length})`);

      const result = await this.upgradeFollower(follower);

      if (result.rolledBack) {
        nodesRolledBack.push(follower.nodeId);
      }

      if (!result.success) {
        this.progress('aborted', this.config.selfNodeId,
          `Aborting rolling update: ${follower.nodeId} failed — ${result.error}`);
        return {
          success: false,
          nodesUpdated,
          nodesRolledBack,
          error: `Failed on ${follower.nodeId}: ${result.error}`,
        };
      }

      nodesUpdated.push(follower.nodeId);
    }

    // Phase 4: Leader self-update
    this.progress('leader-restart', this.config.selfNodeId, 'All followers updated. Restarting leader...');
    await this.upgradeLeader();

    // If we get here, the restart hasn't happened yet (exec is async)
    return { success: true, nodesUpdated, nodesRolledBack };
  }

  /**
   * Phase 4: Leader self-update.
   * Backs up dist/, then restarts own service. The process will die and be restarted by systemd.
   */
  private async upgradeLeader(): Promise<void> {
    const distDir = this.config.distDir;
    const baseDir = path.dirname(distDir);

    // Backup current dist
    const bakDir = path.join(baseDir, 'dist.bak');
    try {
      if (fs.existsSync(bakDir)) {
        fs.rmSync(bakDir, { recursive: true });
      }
      // New dist/ is already in place (we just built it locally).
      // We copy current dist to dist.bak for safety.
      fs.cpSync(distDir, bakDir, { recursive: true });
    } catch (error) {
      this.config.logger.warn('Failed to create leader backup', { error });
      // Continue anyway — the build is already in place
    }

    // Restart self via systemctl. This will kill our process.
    this.progress('leader-restart', this.config.selfNodeId, 'Executing systemctl restart claudecluster');
    exec('systemctl restart claudecluster');
  }
```

**Step 4: Run tests**

Run: `npx vitest run tests/updater.test.ts`

Expected: All tests pass.

**Step 5: Commit**

```bash
git add src/cluster/updater.ts tests/updater.test.ts
git commit -m "feat(issu): add execute() orchestrator with Phase 4 leader self-update"
```

---

## Task 6: Add `initiate_rolling_update` MCP tool

**Files:**
- Modify: `src/mcp/tools.ts`
- Modify: `tests/mcp-tools.test.ts` (optional — add a basic tool registration test)

**Step 1: Add the tool**

In `src/mcp/tools.ts`, add to the `ToolsConfig` interface:

```typescript
  clientPool: GrpcClientPool;
  raft: RaftNode;
```

Then add the tool inside `createTools()`, before the `return tools;` line:

```typescript
  // initiate_rolling_update - ISSU rolling update
  tools.set('initiate_rolling_update', {
    description: 'Initiate an ISSU rolling update across all cluster nodes. Leader pushes new dist/ to followers one at a time, restarts each maintaining Raft quorum, with automatic rollback on failure. Leader restarts itself last.',
    inputSchema: {
      type: 'object',
      properties: {
        dryRun: {
          type: 'boolean',
          description: 'If true, only run pre-flight checks without making changes (default: false)',
        },
      },
    },
    handler: async (args) => {
      const { RollingUpdater } = await import('../cluster/updater.js');

      const updater = new RollingUpdater({
        membership: config.membership,
        raft: config.raft,
        clientPool: config.clientPool,
        logger: config.logger,
        selfNodeId: config.nodeId,
        distDir: path.join(process.cwd(), 'dist'),
      });

      const progress: UpdateProgress[] = [];
      updater.on('progress', (event: UpdateProgress) => {
        progress.push(event);
      });

      const result = await updater.execute({ dryRun: args.dryRun as boolean });

      return {
        ...result,
        progress,
      };
    },
  });
```

Add the import at the top of `src/mcp/tools.ts`:

```typescript
import { GrpcClientPool } from '../grpc/client.js';
import { RaftNode } from '../cluster/raft.js';
import { UpdateProgress } from '../cluster/updater.js';
import path from 'path';
```

**Step 2: Update the MCP server to pass clientPool and raft**

Check `src/mcp/server.ts` and ensure `clientPool` and `raft` are passed through to `createTools()`. If not already in the config, add them.

**Step 3: Build and verify**

Run: `npm run build`

Expected: No type errors.

Run: `npm test`

Expected: All tests pass.

**Step 4: Commit**

```bash
git add src/mcp/tools.ts src/mcp/server.ts
git commit -m "feat(issu): add initiate_rolling_update MCP tool"
```

---

## Task 7: Integration test — dry run on live cluster

**Step 1: Build**

Run: `npm run build`

Verify: `cat dist/version.json` shows the new version stamp.

**Step 2: Deploy to forge (leader)**

Run: `scripts/deploy.sh` or manual rsync + restart on forge.

**Step 3: Test dry run via MCP**

From Claude Code, invoke:
```
initiate_rolling_update with dryRun: true
```

Expected: Returns preflight result with quorum math, node list, and success=true (if cluster is healthy).

**Step 4: Commit any fixes**

If integration test reveals issues, fix and commit.

---

## Summary

| Task | What | Files | Tests |
|------|------|-------|-------|
| 1 | Version stamping script | `scripts/write-version.js`, `package.json` | Manual verify |
| 2 | RollingUpdater + preflight | `src/cluster/updater.ts`, `tests/updater.test.ts` | 5 tests |
| 3 | runShellOnNode helper | `src/cluster/updater.ts`, `tests/updater.test.ts` | 2 tests |
| 4 | upgradeFollower (Phases 1-3) | `src/cluster/updater.ts`, `tests/updater.test.ts` | 1 test |
| 5 | execute() orchestrator (Phase 4) | `src/cluster/updater.ts`, `tests/updater.test.ts` | 2 tests |
| 6 | MCP tool | `src/mcp/tools.ts`, `src/mcp/server.ts` | Build verify |
| 7 | Integration dry run | — | Live cluster test |
