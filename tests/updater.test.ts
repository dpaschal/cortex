import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RollingUpdater } from '../src/cluster/updater.js';
import { MembershipManager, NodeInfo } from '../src/cluster/membership.js';
import { RaftNode, PeerInfo } from '../src/cluster/raft.js';
import { GrpcClientPool, AgentClient } from '../src/grpc/client.js';
import { Logger } from 'winston';

vi.mock('../src/grpc/client.js', async () => {
  const actual = await vi.importActual('../src/grpc/client.js');
  return {
    ...actual,
    AgentClient: vi.fn(),
  };
});

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
      expect(result.votingCount).toBe(4);
      expect(result.quorumSize).toBe(3);
      expect(result.followers).toHaveLength(3);
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

  describe('runShellOnNode', () => {
    it('should execute a shell command on a remote node and return stdout', async () => {
      const { updater } = createUpdater();

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

  describe('upgradeFollower', () => {
    it('should backup, rsync, verify, restart, stabilize, and commit', async () => {
      const nodes = [
        createMockNode({ nodeId: 'leader-1', role: 'leader', tailscaleIp: '100.0.0.1' }),
        createMockNode({ nodeId: 'follower-1', tailscaleIp: '100.0.0.2' }),
        createMockNode({ nodeId: 'follower-2', tailscaleIp: '100.0.0.3' }),
        createMockNode({ nodeId: 'follower-3', tailscaleIp: '100.0.0.4' }),
      ];
      const { updater, mockClientPool } = createUpdater({ nodes });
      const follower = nodes[1];

      // Mock all shell commands to succeed
      const mockExecuteTask = vi.fn().mockImplementation(async function* () {
        yield { output: { type: 'stdout', data: Buffer.from('ok\n') } };
        yield { status: { exit_code: 0 } };
      });
      const mockHealthCheck = vi.fn().mockResolvedValue({ healthy: true });

      (AgentClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
        executeTask: mockExecuteTask,
        healthCheck: mockHealthCheck,
      }));

      const result = await updater.upgradeFollower(follower);
      expect(result.success).toBe(true);
      expect(result.rolledBack).toBe(false);
      // Verify closeConnection was called (after restart)
      expect(mockClientPool.closeConnection).toHaveBeenCalled();
    });

    it('should rollback if rsync fails', async () => {
      const nodes = [
        createMockNode({ nodeId: 'leader-1', role: 'leader', tailscaleIp: '100.0.0.1' }),
        createMockNode({ nodeId: 'follower-1', tailscaleIp: '100.0.0.2' }),
        createMockNode({ nodeId: 'follower-2', tailscaleIp: '100.0.0.3' }),
        createMockNode({ nodeId: 'follower-3', tailscaleIp: '100.0.0.4' }),
      ];
      const { updater } = createUpdater({ nodes });
      const follower = nodes[1];

      let callNum = 0;
      const mockExecuteTask = vi.fn().mockImplementation(async function* () {
        callNum++;
        if (callNum === 2) {
          // Second call is rsync — fail it
          yield { output: { type: 'stderr', data: Buffer.from('rsync error\n') } };
          yield { status: { exit_code: 1 } };
        } else {
          yield { output: { type: 'stdout', data: Buffer.from('ok\n') } };
          yield { status: { exit_code: 0 } };
        }
      });

      (AgentClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
        executeTask: mockExecuteTask,
      }));

      const result = await updater.upgradeFollower(follower);
      expect(result.success).toBe(false);
      expect(result.rolledBack).toBe(true);
      expect(result.error).toContain('Rsync failed');
    });

    it('should rollback if health check times out', async () => {
      const nodes = [
        createMockNode({ nodeId: 'leader-1', role: 'leader', tailscaleIp: '100.0.0.1' }),
        createMockNode({ nodeId: 'follower-1', tailscaleIp: '100.0.0.2' }),
        createMockNode({ nodeId: 'follower-2', tailscaleIp: '100.0.0.3' }),
        createMockNode({ nodeId: 'follower-3', tailscaleIp: '100.0.0.4' }),
      ];
      const { updater } = createUpdater({ nodes });
      const follower = nodes[1];

      // Mock shell commands to succeed
      const mockExecuteTask = vi.fn().mockImplementation(async function* () {
        yield { output: { type: 'stdout', data: Buffer.from('ok\n') } };
        yield { status: { exit_code: 0 } };
      });
      // Mock healthCheck to always return unhealthy
      const mockHealthCheck = vi.fn().mockResolvedValue({ healthy: false });

      (AgentClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
        executeTask: mockExecuteTask,
        healthCheck: mockHealthCheck,
      }));

      // Override sleep to avoid real timeouts in tests
      // Use vi.spyOn to mock the private sleep method
      const sleepSpy = vi.spyOn(updater as any, 'sleep').mockResolvedValue(undefined);

      // Override pollHealthCheck to return false quickly (simulating timeout)
      const pollSpy = vi.spyOn(updater as any, 'pollHealthCheck').mockResolvedValue(false);

      const result = await updater.upgradeFollower(follower);
      expect(result.success).toBe(false);
      expect(result.rolledBack).toBe(true);
      expect(result.error).toContain('Health check timed out');

      sleepSpy.mockRestore();
      pollSpy.mockRestore();
    });
  });

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
});
