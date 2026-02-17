import { EventEmitter } from 'events';
import { Logger } from 'winston';
import { RaftNode, PeerInfo } from './raft.js';
import { MembershipManager, NodeInfo } from './membership.js';
import { GrpcClientPool, AgentClient } from '../grpc/client.js';
import { randomUUID } from 'crypto';

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

    // Freshness gate: all followers must have recent lastSeen
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

    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
  }
}
