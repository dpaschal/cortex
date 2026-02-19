import { describe, it, expect, beforeEach, vi } from 'vitest';
import winston from 'winston';
import { ResourceAwareScheduler } from '../../../src/plugins/task-engine/scheduler.js';
import type { NodeInfo, NodeResources, GpuInfo } from '../../../src/cluster/membership.js';
import type { TaskRecord, TaskConstraints } from '../../../src/plugins/task-engine/types.js';

const logger = winston.createLogger({
  transports: [new winston.transports.Console({ level: 'warn' })],
});

// --- helpers ---

function makeNode(id: string, overrides: Record<string, any> = {}): NodeInfo {
  return {
    nodeId: id,
    hostname: id,
    tailscaleIp: `100.0.0.${id.charCodeAt(id.length - 1)}`,
    grpcPort: 50051,
    role: 'follower' as const,
    status: 'active' as const,
    tags: overrides.tags ?? [],
    joinedAt: Date.now(),
    lastSeen: Date.now(),
    resources: overrides.resources === null
      ? null
      : {
          cpuCores: 8,
          memoryBytes: 16e9,
          memoryAvailableBytes: overrides.memAvail ?? 8e9,
          gpus: overrides.gpus ?? [],
          diskBytes: 500e9,
          diskAvailableBytes: overrides.diskAvail ?? 250e9,
          cpuUsagePercent: overrides.cpuPct ?? 30,
          gamingDetected: overrides.gaming ?? false,
        },
  };
}

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: overrides.id ?? 'task-001',
    workflow_id: overrides.workflow_id ?? null,
    task_key: overrides.task_key ?? null,
    type: overrides.type ?? 'shell',
    state: overrides.state ?? 'queued',
    priority: overrides.priority ?? 5,
    spec: overrides.spec ?? '{"command":"echo hello"}',
    constraints: overrides.constraints ?? null,
    retry_policy: overrides.retry_policy ?? null,
    assigned_node: overrides.assigned_node ?? null,
    attempt: overrides.attempt ?? 0,
    result: overrides.result ?? null,
    error: overrides.error ?? null,
    scheduled_after: overrides.scheduled_after ?? null,
    created_at: overrides.created_at ?? new Date().toISOString(),
    assigned_at: overrides.assigned_at ?? null,
    started_at: overrides.started_at ?? null,
    completed_at: overrides.completed_at ?? null,
    dead_lettered_at: overrides.dead_lettered_at ?? null,
  };
}

function makeConstraints(c: TaskConstraints): string {
  return JSON.stringify(c);
}

const mockRaft = {
  isLeader: vi.fn().mockReturnValue(true),
  appendEntry: vi.fn().mockResolvedValue({ success: true, index: 1 }),
};

const mockMembership = {
  getActiveNodes: vi.fn().mockReturnValue([] as NodeInfo[]),
};

describe('ResourceAwareScheduler', () => {
  let scheduler: ResourceAwareScheduler;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMembership.getActiveNodes.mockReturnValue([]);

    scheduler = new ResourceAwareScheduler({
      raft: mockRaft,
      membership: mockMembership,
      logger,
    });
  });

  it('picks the node with the most available resources', () => {
    const idle = makeNode('idle', { cpuPct: 10, memAvail: 14e9 });
    const busy = makeNode('busy', { cpuPct: 90, memAvail: 2e9 });
    mockMembership.getActiveNodes.mockReturnValue([idle, busy]);

    const task = makeTask();
    const picked = scheduler.pickNode(task);

    expect(picked).not.toBeNull();
    expect(picked!.nodeId).toBe('idle');
  });

  it('excludes nodes without GPU when requiresGpu is set', () => {
    const gpuNode = makeNode('gpu-node', {
      gpus: [
        {
          name: 'RTX 4090',
          memoryBytes: 24e9,
          memoryAvailableBytes: 20e9,
          utilizationPercent: 10,
          inUseForGaming: false,
        } as GpuInfo,
      ],
    });
    const noGpu = makeNode('no-gpu', { gpus: [] });
    mockMembership.getActiveNodes.mockReturnValue([gpuNode, noGpu]);

    const task = makeTask({
      constraints: makeConstraints({ requiresGpu: true }),
    });
    const picked = scheduler.pickNode(task);

    expect(picked).not.toBeNull();
    expect(picked!.nodeId).toBe('gpu-node');
  });

  it('avoids gaming nodes when avoidGaming is set', () => {
    const gaming = makeNode('gaming', { gaming: true, cpuPct: 5 });
    const normal = makeNode('normal', { gaming: false, cpuPct: 50 });
    mockMembership.getActiveNodes.mockReturnValue([gaming, normal]);

    const task = makeTask({
      constraints: makeConstraints({ avoidGaming: true }),
    });
    const picked = scheduler.pickNode(task);

    expect(picked).not.toBeNull();
    expect(picked!.nodeId).toBe('normal');
  });

  it('returns null when no nodes meet constraints', () => {
    const smallNode = makeNode('small', { memAvail: 1e9 });
    mockMembership.getActiveNodes.mockReturnValue([smallNode]);

    const task = makeTask({
      constraints: makeConstraints({ minMemoryMb: 8000 }),
    });
    const picked = scheduler.pickNode(task);

    expect(picked).toBeNull();
  });

  it('penalizes nodes with more running tasks', () => {
    // Both nodes have identical resources, but nodeA has 5 running tasks
    const nodeA = makeNode('nodeA', { cpuPct: 30, memAvail: 8e9 });
    const nodeB = makeNode('nodeB', { cpuPct: 30, memAvail: 8e9 });
    mockMembership.getActiveNodes.mockReturnValue([nodeA, nodeB]);

    scheduler.setRunningTaskCount('nodeA', 5);
    scheduler.setRunningTaskCount('nodeB', 0);

    const task = makeTask();
    const picked = scheduler.pickNode(task);

    expect(picked).not.toBeNull();
    expect(picked!.nodeId).toBe('nodeB');
  });

  it('pins to targetNode when specified, ignoring scoring', () => {
    const slow = makeNode('target-node', { cpuPct: 95, memAvail: 1e9 });
    const fast = makeNode('fast-node', { cpuPct: 5, memAvail: 15e9 });
    mockMembership.getActiveNodes.mockReturnValue([slow, fast]);

    const task = makeTask({
      constraints: makeConstraints({ targetNode: 'target-node' }),
    });
    const picked = scheduler.pickNode(task);

    expect(picked).not.toBeNull();
    expect(picked!.nodeId).toBe('target-node');
  });

  it('pins to targetNode by hostname', () => {
    const node = makeNode('node-abc');
    mockMembership.getActiveNodes.mockReturnValue([node]);

    // hostname defaults to the node ID in makeNode
    const task = makeTask({
      constraints: makeConstraints({ targetNode: 'node-abc' }),
    });
    const picked = scheduler.pickNode(task);

    expect(picked).not.toBeNull();
    expect(picked!.nodeId).toBe('node-abc');
  });

  it('returns null when targetNode is not found', () => {
    const node = makeNode('node-a');
    mockMembership.getActiveNodes.mockReturnValue([node]);

    const task = makeTask({
      constraints: makeConstraints({ targetNode: 'nonexistent' }),
    });
    const picked = scheduler.pickNode(task);

    expect(picked).toBeNull();
  });

  it('filters by nodeLabels', () => {
    const gpuWorker = makeNode('gpu-worker', { tags: ['gpu', 'worker'] });
    const cpuOnly = makeNode('cpu-only', { tags: ['worker'] });
    mockMembership.getActiveNodes.mockReturnValue([gpuWorker, cpuOnly]);

    const task = makeTask({
      constraints: makeConstraints({ nodeLabels: ['gpu'] }),
    });
    const picked = scheduler.pickNode(task);

    expect(picked).not.toBeNull();
    expect(picked!.nodeId).toBe('gpu-worker');
  });

  it('handles nodes with null resources (score 0)', () => {
    const nullRes = makeNode('null-res', { resources: null });
    const withRes = makeNode('with-res', { cpuPct: 50 });
    mockMembership.getActiveNodes.mockReturnValue([nullRes, withRes]);

    const task = makeTask();
    const picked = scheduler.pickNode(task);

    expect(picked).not.toBeNull();
    expect(picked!.nodeId).toBe('with-res');
  });

  it('returns null when no nodes are available', () => {
    mockMembership.getActiveNodes.mockReturnValue([]);

    const task = makeTask();
    const picked = scheduler.pickNode(task);

    expect(picked).toBeNull();
  });

  it('applies gaming penalty to scoring even without avoidGaming constraint', () => {
    // Gaming node has better raw CPU/memory but should get penalized
    const gaming = makeNode('gaming', { gaming: true, cpuPct: 10, memAvail: 14e9 });
    const normal = makeNode('normal', { gaming: false, cpuPct: 20, memAvail: 12e9 });
    mockMembership.getActiveNodes.mockReturnValue([gaming, normal]);

    // No avoidGaming constraint -- gaming node is not filtered but gets -40 penalty
    const task = makeTask();
    const picked = scheduler.pickNode(task);

    expect(picked).not.toBeNull();
    expect(picked!.nodeId).toBe('normal');
  });

  it('filters by minDiskGb', () => {
    const bigDisk = makeNode('big-disk', { diskAvail: 400e9 });
    const smallDisk = makeNode('small-disk', { diskAvail: 10e9 });
    mockMembership.getActiveNodes.mockReturnValue([bigDisk, smallDisk]);

    const task = makeTask({
      constraints: makeConstraints({ minDiskGb: 100 }),
    });
    const picked = scheduler.pickNode(task);

    expect(picked).not.toBeNull();
    expect(picked!.nodeId).toBe('big-disk');
  });

  it('prefers GPU node with lower utilization for requiresGpu tasks', () => {
    const busyGpu = makeNode('busy-gpu', {
      cpuPct: 30,
      gpus: [
        {
          name: 'RTX 3090',
          memoryBytes: 24e9,
          memoryAvailableBytes: 10e9,
          utilizationPercent: 90,
          inUseForGaming: false,
        } as GpuInfo,
      ],
    });
    const idleGpu = makeNode('idle-gpu', {
      cpuPct: 30,
      gpus: [
        {
          name: 'RTX 4090',
          memoryBytes: 24e9,
          memoryAvailableBytes: 20e9,
          utilizationPercent: 5,
          inUseForGaming: false,
        } as GpuInfo,
      ],
    });
    mockMembership.getActiveNodes.mockReturnValue([busyGpu, idleGpu]);

    const task = makeTask({
      constraints: makeConstraints({ requiresGpu: true }),
    });
    const picked = scheduler.pickNode(task);

    expect(picked).not.toBeNull();
    expect(picked!.nodeId).toBe('idle-gpu');
  });

  it('excludes GPUs that are in use for gaming from requiresGpu filter', () => {
    const gamingGpu = makeNode('gaming-gpu', {
      gpus: [
        {
          name: 'RTX 4090',
          memoryBytes: 24e9,
          memoryAvailableBytes: 2e9,
          utilizationPercent: 95,
          inUseForGaming: true,
        } as GpuInfo,
      ],
    });
    mockMembership.getActiveNodes.mockReturnValue([gamingGpu]);

    const task = makeTask({
      constraints: makeConstraints({ requiresGpu: true }),
    });
    const picked = scheduler.pickNode(task);

    expect(picked).toBeNull();
  });

  it('uses custom weights when provided', () => {
    // Two nodes: nodeA has better CPU, nodeB has better memory
    const nodeA = makeNode('nodeA', { cpuPct: 10, memAvail: 4e9 });
    const nodeB = makeNode('nodeB', { cpuPct: 50, memAvail: 14e9 });
    mockMembership.getActiveNodes.mockReturnValue([nodeA, nodeB]);

    // With heavily memory-weighted scheduler, nodeB should win
    const memoryScheduler = new ResourceAwareScheduler({
      raft: mockRaft,
      membership: mockMembership,
      weights: {
        cpuHeadroom: 0.01,
        memoryHeadroom: 1.0,
        diskIoHeadroom: 0.01,
        networkHeadroom: 0.01,
        gpuHeadroom: 0.01,
        taskCountPenalty: 5,
      },
      logger,
    });

    const task = makeTask();
    const picked = memoryScheduler.pickNode(task);

    expect(picked).not.toBeNull();
    expect(picked!.nodeId).toBe('nodeB');
  });
});
