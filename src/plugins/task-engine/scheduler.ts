import { Logger } from 'winston';
import type { RaftNode } from '../../cluster/raft.js';
import type { MembershipManager, NodeInfo } from '../../cluster/membership.js';
import { TaskRecord, TaskConstraints, SchedulerWeights, DEFAULT_SCHEDULER_WEIGHTS } from './types.js';

export interface SchedulerConfig {
  raft: Pick<RaftNode, 'isLeader' | 'appendEntry'>;
  membership: Pick<MembershipManager, 'getActiveNodes'>;
  weights?: SchedulerWeights;
  logger: Logger;
}

export class ResourceAwareScheduler {
  private config: SchedulerConfig;
  private weights: SchedulerWeights;
  private runningTaskCounts: Map<string, number> = new Map();

  constructor(config: SchedulerConfig) {
    this.config = config;
    this.weights = config.weights ?? DEFAULT_SCHEDULER_WEIGHTS;
  }

  setRunningTaskCount(nodeId: string, count: number): void {
    this.runningTaskCounts.set(nodeId, count);
  }

  pickNode(task: TaskRecord): NodeInfo | null {
    const constraints: TaskConstraints | null = task.constraints
      ? JSON.parse(task.constraints)
      : null;

    // Target node pin -- bypass scoring
    if (constraints?.targetNode) {
      const nodes = this.config.membership.getActiveNodes();
      return (
        nodes.find(
          (n) =>
            n.nodeId === constraints.targetNode ||
            n.hostname === constraints.targetNode,
        ) ?? null
      );
    }

    const candidates = this.filterNodes(constraints);
    if (candidates.length === 0) return null;

    const scored = candidates.map((node) => ({
      node,
      score: this.scoreNode(node, constraints),
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored[0].node;
  }

  private filterNodes(constraints: TaskConstraints | null): NodeInfo[] {
    let nodes = this.config.membership.getActiveNodes();
    if (!constraints) return nodes;

    if (constraints.requiresGpu) {
      nodes = nodes.filter((n) =>
        n.resources?.gpus.some((g) => !g.inUseForGaming),
      );
    }
    if (constraints.avoidGaming) {
      nodes = nodes.filter((n) => !n.resources?.gamingDetected);
    }
    if (constraints.minMemoryMb) {
      const minBytes = constraints.minMemoryMb * 1e6;
      nodes = nodes.filter(
        (n) => (n.resources?.memoryAvailableBytes ?? 0) >= minBytes,
      );
    }
    if (constraints.minDiskGb) {
      const minBytes = constraints.minDiskGb * 1e9;
      nodes = nodes.filter(
        (n) => (n.resources?.diskAvailableBytes ?? 0) >= minBytes,
      );
    }
    if (constraints.nodeLabels?.length) {
      nodes = nodes.filter((n) =>
        constraints.nodeLabels!.some((label) => n.tags.includes(label)),
      );
    }
    return nodes;
  }

  private scoreNode(
    node: NodeInfo,
    constraints: TaskConstraints | null,
  ): number {
    const r = node.resources;
    if (!r) return 0;

    let score = 0;

    // CPU headroom
    score += (100 - r.cpuUsagePercent) * this.weights.cpuHeadroom;

    // Memory headroom
    const memPct =
      r.memoryBytes > 0
        ? (r.memoryAvailableBytes / r.memoryBytes) * 100
        : 0;
    score += memPct * this.weights.memoryHeadroom;

    // Disk headroom
    const diskPct =
      r.diskBytes > 0
        ? (r.diskAvailableBytes / r.diskBytes) * 100
        : 0;
    score += diskPct * this.weights.diskIoHeadroom;

    // GPU headroom (if task needs GPU)
    if (constraints?.requiresGpu) {
      const gpu = r.gpus.find((g) => !g.inUseForGaming);
      if (gpu) {
        score += (100 - gpu.utilizationPercent) * this.weights.gpuHeadroom;
      }
    }

    // Gaming penalty
    if (r.gamingDetected) score -= 40;

    // Task count penalty
    const taskCount = this.runningTaskCounts.get(node.nodeId) ?? 0;
    score -= taskCount * this.weights.taskCountPenalty;

    return score;
  }
}
