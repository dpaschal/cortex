import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import winston from 'winston';
import { EventEmitter } from 'events';
import { TaskEnginePlugin } from '../../../src/plugins/task-engine/index.js';
import { runMigrations } from '../../../src/plugins/task-engine/migrations.js';
import type { PluginContext } from '../../../src/plugins/types.js';

const logger = winston.createLogger({
  transports: [new winston.transports.Console({ level: 'error' })],
});

function createMockContext(): {
  ctx: PluginContext;
  db: Database.Database;
  raftEmitter: EventEmitter;
  membershipEmitter: EventEmitter;
  entryLog: Array<{ type: string; data: Buffer }>;
} {
  const db = new Database(':memory:');
  runMigrations(db);

  const raftEmitter = new EventEmitter();
  const membershipEmitter = new EventEmitter();
  const entryLog: Array<{ type: string; data: Buffer }> = [];

  const mockRaft = Object.assign(raftEmitter, {
    isLeader: vi.fn(() => true),
    getLeaderId: vi.fn(() => 'test-node'),
    appendEntry: vi.fn(async (type: string, data: Buffer) => {
      entryLog.push({ type, data });
      return { success: true, index: entryLog.length };
    }),
  });

  const mockMembership = Object.assign(membershipEmitter, {
    getActiveNodes: vi.fn(() => [
      {
        nodeId: 'node-a',
        hostname: 'node-a',
        tailscaleIp: '100.0.0.1',
        grpcPort: 50051,
        role: 'leader',
        status: 'active',
        resources: {
          cpuCores: 8,
          memoryBytes: 16e9,
          memoryAvailableBytes: 8e9,
          gpus: [],
          diskBytes: 500e9,
          diskAvailableBytes: 250e9,
          cpuUsagePercent: 30,
          gamingDetected: false,
        },
        tags: [],
        joinedAt: Date.now(),
        lastSeen: Date.now(),
      },
      {
        nodeId: 'node-b',
        hostname: 'node-b',
        tailscaleIp: '100.0.0.2',
        grpcPort: 50051,
        role: 'follower',
        status: 'active',
        resources: {
          cpuCores: 4,
          memoryBytes: 8e9,
          memoryAvailableBytes: 4e9,
          gpus: [],
          diskBytes: 200e9,
          diskAvailableBytes: 100e9,
          cpuUsagePercent: 50,
          gamingDetected: false,
        },
        tags: [],
        joinedAt: Date.now(),
        lastSeen: Date.now(),
      },
      {
        nodeId: 'node-c',
        hostname: 'node-c',
        tailscaleIp: '100.0.0.3',
        grpcPort: 50051,
        role: 'follower',
        status: 'active',
        resources: {
          cpuCores: 16,
          memoryBytes: 32e9,
          memoryAvailableBytes: 16e9,
          gpus: [],
          diskBytes: 1e12,
          diskAvailableBytes: 500e9,
          cpuUsagePercent: 10,
          gamingDetected: false,
        },
        tags: [],
        joinedAt: Date.now(),
        lastSeen: Date.now(),
      },
    ]),
    getAllNodes: vi.fn(() => []),
    getNode: vi.fn(() => undefined),
  });

  const ctx: PluginContext = {
    raft: mockRaft as any,
    membership: mockMembership as any,
    scheduler: {} as any,
    stateManager: {} as any,
    clientPool: {} as any,
    sharedMemoryDb: { db } as any,
    memoryReplicator: {} as any,
    logger,
    nodeId: 'test-node',
    sessionId: 'test-session',
    config: {},
    events: new EventEmitter(),
  };

  return { ctx, db, raftEmitter, membershipEmitter, entryLog };
}

/**
 * Helper: after calling a tool that appends a Raft entry, simulate
 * the Raft commit by emitting entryCommitted for each entry in the log.
 */
function simulateRaftCommits(
  raftEmitter: EventEmitter,
  entryLog: Array<{ type: string; data: Buffer }>,
  startIndex = 0,
): void {
  for (let i = startIndex; i < entryLog.length; i++) {
    raftEmitter.emit('entryCommitted', entryLog[i]);
  }
}

describe('TaskEnginePlugin — drain_node_tasks', () => {
  let plugin: TaskEnginePlugin;
  let ctx: PluginContext;
  let db: Database.Database;
  let raftEmitter: EventEmitter;
  let entryLog: Array<{ type: string; data: Buffer }>;

  beforeEach(async () => {
    const mocks = createMockContext();
    ctx = mocks.ctx;
    db = mocks.db;
    raftEmitter = mocks.raftEmitter;
    entryLog = mocks.entryLog;

    plugin = new TaskEnginePlugin();
    await plugin.init(ctx);
  });

  /**
   * Helper: submit a shell task, simulate Raft commit, return the taskId.
   */
  async function submitAndCommitTask(command = 'echo test'): Promise<string> {
    const tools = plugin.getTools();
    const prevLen = entryLog.length;
    const result = (await tools.get('submit_task')!.handler({
      type: 'shell',
      command,
    })) as any;
    simulateRaftCommits(raftEmitter, entryLog, prevLen);
    return result.taskId;
  }

  /**
   * Helper: set a task to running on a specific node in SQLite.
   */
  function setTaskRunningOnNode(taskId: string, nodeId: string): void {
    db.prepare(
      "UPDATE te_tasks SET state = 'running', assigned_node = ?, started_at = datetime('now') WHERE id = ?",
    ).run(nodeId, taskId);
  }

  // ── 1. Drain re-queues all tasks on the target node ──────────

  it('drain re-queues all tasks on the target node', async () => {
    // Submit 3 tasks, commit them
    const taskId1 = await submitAndCommitTask('job-1');
    const taskId2 = await submitAndCommitTask('job-2');
    const taskId3 = await submitAndCommitTask('job-3');

    // Set all 3 running on node-a
    setTaskRunningOnNode(taskId1, 'node-a');
    setTaskRunningOnNode(taskId2, 'node-a');
    setTaskRunningOnNode(taskId3, 'node-a');

    const prevLen = entryLog.length;

    // Drain node-a
    const tools = plugin.getTools();
    const result = (await tools.get('drain_node_tasks')!.handler({
      nodeId: 'node-a',
    })) as any;

    expect(result).toEqual({
      drained: true,
      nodeId: 'node-a',
      tasksRequeued: 3,
      totalTasks: 3,
    });

    // Verify 3 task_retry entries were appended
    const retryEntries = entryLog.slice(prevLen);
    expect(retryEntries).toHaveLength(3);
    for (const entry of retryEntries) {
      expect(entry.type).toBe('task_retry');
    }

    // Verify the retry payloads reference the correct task IDs
    const retryTaskIds = retryEntries.map((e) => {
      const parsed = JSON.parse(e.data.toString());
      return parsed.payload.taskId;
    });
    expect(retryTaskIds).toContain(taskId1);
    expect(retryTaskIds).toContain(taskId2);
    expect(retryTaskIds).toContain(taskId3);
  });

  // ── 2. Drain preserves attempt count ─────────────────────────

  it('drain preserves attempt count (does not increment)', async () => {
    const taskId = await submitAndCommitTask('attempt-check');

    // Set task to running on node-a with attempt=2
    db.prepare(
      "UPDATE te_tasks SET state = 'running', assigned_node = 'node-a', attempt = 2, started_at = datetime('now') WHERE id = ?",
    ).run(taskId);

    const prevLen = entryLog.length;

    const tools = plugin.getTools();
    await tools.get('drain_node_tasks')!.handler({ nodeId: 'node-a' });

    // Verify the task_retry payload has attempt: 2 (not 3)
    const retryEntries = entryLog.slice(prevLen);
    expect(retryEntries).toHaveLength(1);

    const parsed = JSON.parse(retryEntries[0].data.toString());
    expect(parsed.payload.attempt).toBe(2);
    expect(parsed.payload.taskId).toBe(taskId);
  });

  // ── 3. Drain only affects target node's tasks ────────────────

  it('drain only affects the target node, not other nodes', async () => {
    // Submit 4 tasks
    const taskA1 = await submitAndCommitTask('node-a-job-1');
    const taskA2 = await submitAndCommitTask('node-a-job-2');
    const taskB1 = await submitAndCommitTask('node-b-job-1');
    const taskB2 = await submitAndCommitTask('node-b-job-2');

    // 2 running on node-a, 2 running on node-b
    setTaskRunningOnNode(taskA1, 'node-a');
    setTaskRunningOnNode(taskA2, 'node-a');
    setTaskRunningOnNode(taskB1, 'node-b');
    setTaskRunningOnNode(taskB2, 'node-b');

    const prevLen = entryLog.length;

    // Drain only node-a
    const tools = plugin.getTools();
    const result = (await tools.get('drain_node_tasks')!.handler({
      nodeId: 'node-a',
    })) as any;

    expect(result.tasksRequeued).toBe(2);
    expect(result.totalTasks).toBe(2);

    // Verify only 2 task_retry entries (for node-a tasks)
    const retryEntries = entryLog.slice(prevLen);
    expect(retryEntries).toHaveLength(2);

    const retryTaskIds = retryEntries.map((e) => {
      const parsed = JSON.parse(e.data.toString());
      return parsed.payload.taskId;
    });
    expect(retryTaskIds).toContain(taskA1);
    expect(retryTaskIds).toContain(taskA2);
    expect(retryTaskIds).not.toContain(taskB1);
    expect(retryTaskIds).not.toContain(taskB2);

    // Verify node-b's tasks are untouched in SQLite
    const bTask1 = db.prepare('SELECT * FROM te_tasks WHERE id = ?').get(taskB1) as any;
    const bTask2 = db.prepare('SELECT * FROM te_tasks WHERE id = ?').get(taskB2) as any;
    expect(bTask1.state).toBe('running');
    expect(bTask1.assigned_node).toBe('node-b');
    expect(bTask2.state).toBe('running');
    expect(bTask2.assigned_node).toBe('node-b');
  });

  // ── 4. After drain + Raft commit, tasks are queued with no assigned node ──

  it('after drain + Raft commit, tasks become queued with no assigned node', async () => {
    const taskId1 = await submitAndCommitTask('drain-requeue-1');
    const taskId2 = await submitAndCommitTask('drain-requeue-2');

    setTaskRunningOnNode(taskId1, 'node-a');
    setTaskRunningOnNode(taskId2, 'node-a');

    const prevLen = entryLog.length;

    // Drain node-a
    const tools = plugin.getTools();
    await tools.get('drain_node_tasks')!.handler({ nodeId: 'node-a' });

    // Simulate Raft commits for the retry entries
    simulateRaftCommits(raftEmitter, entryLog, prevLen);

    // Verify tasks in SQLite: state='queued', assigned_node=NULL, started_at=NULL
    const task1 = db.prepare('SELECT * FROM te_tasks WHERE id = ?').get(taskId1) as any;
    const task2 = db.prepare('SELECT * FROM te_tasks WHERE id = ?').get(taskId2) as any;

    expect(task1.state).toBe('queued');
    expect(task1.assigned_node).toBeNull();
    expect(task1.started_at).toBeNull();

    expect(task2.state).toBe('queued');
    expect(task2.assigned_node).toBeNull();
    expect(task2.started_at).toBeNull();
  });

  // ── 5. Drain empty node returns zero requeued ────────────────

  it('drain on a node with no tasks returns zero requeued', async () => {
    const tools = plugin.getTools();
    const result = (await tools.get('drain_node_tasks')!.handler({
      nodeId: 'node-a',
    })) as any;

    expect(result).toEqual({
      drained: true,
      nodeId: 'node-a',
      tasksRequeued: 0,
      totalTasks: 0,
    });

    // No retry entries should have been appended
    expect(entryLog).toHaveLength(0);
  });

  // ── 6. Drain skips completed and cancelled tasks ─────────────

  it('drain does not touch completed or cancelled tasks on the node', async () => {
    const taskRunning = await submitAndCommitTask('still-running');
    const taskCompleted = await submitAndCommitTask('already-done');
    const taskCancelled = await submitAndCommitTask('was-cancelled');

    // Set all three as having been on node-a
    setTaskRunningOnNode(taskRunning, 'node-a');

    // Completed task: was assigned to node-a but already completed
    db.prepare(
      "UPDATE te_tasks SET state = 'completed', assigned_node = 'node-a', completed_at = datetime('now') WHERE id = ?",
    ).run(taskCompleted);

    // Cancelled task: was assigned to node-a but already cancelled
    db.prepare(
      "UPDATE te_tasks SET state = 'cancelled', assigned_node = 'node-a', completed_at = datetime('now') WHERE id = ?",
    ).run(taskCancelled);

    const prevLen = entryLog.length;

    // Drain node-a
    const tools = plugin.getTools();
    const result = (await tools.get('drain_node_tasks')!.handler({
      nodeId: 'node-a',
    })) as any;

    // Only the running task should be drained (getTasksOnNode filters by state IN ('assigned', 'running'))
    expect(result.tasksRequeued).toBe(1);
    expect(result.totalTasks).toBe(1);

    // Verify only 1 task_retry entry
    const retryEntries = entryLog.slice(prevLen);
    expect(retryEntries).toHaveLength(1);

    const parsed = JSON.parse(retryEntries[0].data.toString());
    expect(parsed.payload.taskId).toBe(taskRunning);

    // Verify completed and cancelled tasks remain untouched
    const completed = db.prepare('SELECT * FROM te_tasks WHERE id = ?').get(taskCompleted) as any;
    const cancelled = db.prepare('SELECT * FROM te_tasks WHERE id = ?').get(taskCancelled) as any;

    expect(completed.state).toBe('completed');
    expect(cancelled.state).toBe('cancelled');
  });
});
