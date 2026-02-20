import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import winston from 'winston';
import { EventEmitter } from 'events';
import { TaskStateMachine, StateMachineAction } from '../../../src/plugins/task-engine/state-machine.js';
import { TaskEnginePlugin } from '../../../src/plugins/task-engine/index.js';
import { runMigrations } from '../../../src/plugins/task-engine/migrations.js';
import type { PluginContext } from '../../../src/plugins/types.js';
import type {
  TaskSubmitPayload,
  TaskAssignPayload,
  TaskStartedPayload,
  TaskFailedPayload,
  TaskRetryPayload,
  TaskDeadLetterPayload,
  TaskRecord,
} from '../../../src/plugins/task-engine/types.js';

const logger = winston.createLogger({
  transports: [new winston.transports.Console({ level: 'error' })],
});

// ── State Machine Helpers ────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function makeSubmitPayload(overrides: Partial<TaskSubmitPayload> = {}): TaskSubmitPayload {
  return {
    taskId: overrides.taskId ?? 'task-001',
    type: overrides.type ?? 'shell',
    spec: overrides.spec ?? { command: 'echo hello' },
    priority: overrides.priority ?? 5,
    constraints: overrides.constraints,
    retryPolicy: overrides.retryPolicy,
    submitterNode: overrides.submitterNode ?? 'node-a',
    workflowId: overrides.workflowId,
    taskKey: overrides.taskKey,
  };
}

/**
 * Run a task through assign -> start -> fail cycle.
 * Returns the action from the failure.
 */
function runFailCycle(
  sm: TaskStateMachine,
  taskId: string,
  nodeId: string,
  error: string,
): StateMachineAction | null {
  sm.applyEntry('task_assign', { taskId, nodeId });
  sm.applyEntry('task_started', { taskId, nodeId });
  return sm.applyEntry('task_failed', { taskId, error, nodeId });
}

// ── Plugin Mock Helpers ──────────────────────────────────────────

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

function simulateRaftCommits(
  raftEmitter: EventEmitter,
  entryLog: Array<{ type: string; data: Buffer }>,
  startIndex = 0,
): void {
  for (let i = startIndex; i < entryLog.length; i++) {
    raftEmitter.emit('entryCommitted', entryLog[i]);
  }
}

// ══════════════════════════════════════════════════════════════════
// State Machine Level Tests
// ══════════════════════════════════════════════════════════════════

describe('Dead Letter Queue - State Machine', () => {
  let db: Database.Database;
  let sm: TaskStateMachine;

  beforeEach(() => {
    db = createTestDb();
    sm = new TaskStateMachine(db, 'test-node', logger);
  });

  // ── Test 1: Full retry-to-dead-letter lifecycle ────────────────

  describe('full retry-to-dead-letter lifecycle', () => {
    it('retries twice then dead-letters on third failure (maxRetries=2)', () => {
      const retryPolicy = {
        maxRetries: 2,
        backoffMs: 500,
        backoffMultiplier: 2,
        retryable: true,
      };

      sm.applyEntry('task_submit', makeSubmitPayload({
        taskId: 'dl-task',
        retryPolicy,
      }));

      // -- Attempt 0: assign, start, fail -> should return retry with attempt=1
      let action = runFailCycle(sm, 'dl-task', 'w1', 'fail-attempt-0');
      expect(action).toBeDefined();
      expect(action!.type).toBe('retry');
      expect(action!.attempt).toBe(1);
      expect(action!.scheduledAfter).toBeDefined();

      // Apply retry -> queued at attempt 1
      sm.applyEntry('task_retry', {
        taskId: 'dl-task',
        attempt: 1,
        scheduledAfter: new Date(0).toISOString(),
      });

      let task = sm.getTask('dl-task')!;
      expect(task.state).toBe('queued');
      expect(task.attempt).toBe(1);

      // -- Attempt 1: assign, start, fail -> should return retry with attempt=2
      action = runFailCycle(sm, 'dl-task', 'w1', 'fail-attempt-1');
      expect(action).toBeDefined();
      expect(action!.type).toBe('retry');
      expect(action!.attempt).toBe(2);

      // Apply retry -> queued at attempt 2
      sm.applyEntry('task_retry', {
        taskId: 'dl-task',
        attempt: 2,
        scheduledAfter: new Date(0).toISOString(),
      });

      task = sm.getTask('dl-task')!;
      expect(task.state).toBe('queued');
      expect(task.attempt).toBe(2);

      // -- Attempt 2: assign, start, fail -> should return dead_letter (2 >= maxRetries=2)
      action = runFailCycle(sm, 'dl-task', 'w1', 'fail-attempt-2');
      expect(action).toBeDefined();
      expect(action!.type).toBe('dead_letter');
      expect(action!.taskId).toBe('dl-task');
      expect(action!.reason).toContain('Max retries exhausted');

      // Apply dead_letter entry
      sm.applyEntry('task_dead_letter', {
        taskId: 'dl-task',
        reason: action!.reason!,
      });

      task = sm.getTask('dl-task')!;
      expect(task.state).toBe('dead_letter');
      expect(task.dead_lettered_at).toBeDefined();
    });
  });

  // ── Test 2: Dead letter records event ──────────────────────────

  describe('dead letter records event', () => {
    it('inserts a dead_lettered event with reason in te_task_events', () => {
      sm.applyEntry('task_submit', makeSubmitPayload({
        taskId: 'ev-task',
        retryPolicy: { maxRetries: 0, backoffMs: 100, backoffMultiplier: 1, retryable: true },
      }));

      // With maxRetries=0, first fail returns dead_letter immediately
      const action = runFailCycle(sm, 'ev-task', 'w1', 'immediate-fail');
      expect(action!.type).toBe('dead_letter');

      // Apply dead_letter
      const reason = 'Max retries exhausted (0) or not retryable';
      sm.applyEntry('task_dead_letter', { taskId: 'ev-task', reason });

      const events = sm.getTaskEvents('ev-task');
      const dlEvent = events.find(e => e.event_type === 'dead_lettered');

      expect(dlEvent).toBeDefined();
      expect(dlEvent!.detail).toBe(reason);
      expect(dlEvent!.node_id).toBe('test-node');
    });
  });

  // ── Test 3: Dead letter preserves error message ────────────────

  describe('dead letter preserves error message', () => {
    it('retains the last failure error after dead lettering', () => {
      sm.applyEntry('task_submit', makeSubmitPayload({
        taskId: 'err-task',
        retryPolicy: { maxRetries: 1, backoffMs: 100, backoffMultiplier: 1, retryable: true },
      }));

      // Attempt 0 fails
      runFailCycle(sm, 'err-task', 'w1', 'first-error');
      sm.applyEntry('task_retry', {
        taskId: 'err-task',
        attempt: 1,
        scheduledAfter: new Date(0).toISOString(),
      });

      // Attempt 1 fails with different error -> dead_letter
      const action = runFailCycle(sm, 'err-task', 'w1', 'final-fatal-error');
      expect(action!.type).toBe('dead_letter');

      // Apply dead letter
      sm.applyEntry('task_dead_letter', { taskId: 'err-task', reason: action!.reason! });

      // The error field should contain the last failure message
      const task = sm.getTask('err-task')!;
      expect(task.state).toBe('dead_letter');
      expect(task.error).toBe('final-fatal-error');
    });
  });
});

// ══════════════════════════════════════════════════════════════════
// Plugin Level Tests
// ══════════════════════════════════════════════════════════════════

describe('Dead Letter Queue - Plugin', () => {
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
   * Helper: submit a task via the plugin tool, commit it, return the taskId.
   */
  async function submitAndCommit(overrides: Record<string, unknown> = {}): Promise<string> {
    const tools = plugin.getTools();
    const result = (await tools.get('submit_task')!.handler({
      type: 'shell',
      command: 'echo test',
      ...overrides,
    })) as any;

    expect(result.accepted).toBe(true);
    simulateRaftCommits(raftEmitter, entryLog, entryLog.length - 1);
    return result.taskId;
  }

  /**
   * Helper: force a task into dead_letter state by running through
   * the full submit -> fail -> retry -> ... -> dead_letter cycle
   * via direct state machine entries (not plugin tools) after initial submit.
   */
  function deadLetterTask(taskId: string, maxRetries = 2): void {
    // Set retry policy on the task
    db.prepare('UPDATE te_tasks SET retry_policy = ? WHERE id = ?').run(
      JSON.stringify({ maxRetries, backoffMs: 100, backoffMultiplier: 1, retryable: true }),
      taskId,
    );

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Assign, start, fail
      const assignEntry = {
        type: 'task_assign',
        data: Buffer.from(JSON.stringify({
          type: 'task_assign',
          payload: { taskId, nodeId: 'node-a' },
        })),
      };
      raftEmitter.emit('entryCommitted', assignEntry);

      const startEntry = {
        type: 'task_started',
        data: Buffer.from(JSON.stringify({
          type: 'task_started',
          payload: { taskId, nodeId: 'node-a' },
        })),
      };
      raftEmitter.emit('entryCommitted', startEntry);

      const failEntry = {
        type: 'task_failed',
        data: Buffer.from(JSON.stringify({
          type: 'task_failed',
          payload: { taskId, error: `fail-attempt-${attempt}`, nodeId: 'node-a' },
        })),
      };
      raftEmitter.emit('entryCommitted', failEntry);

      // After failure, the leader's handleStateMachineAction will have appended
      // either a task_retry or task_dead_letter entry to entryLog.
      // Find the latest relevant entry and simulate its commit.
      const lastEntry = entryLog[entryLog.length - 1];
      if (lastEntry) {
        const parsed = JSON.parse(lastEntry.data.toString());
        if (lastEntry.type === 'task_retry') {
          raftEmitter.emit('entryCommitted', lastEntry);
        } else if (lastEntry.type === 'task_dead_letter') {
          raftEmitter.emit('entryCommitted', lastEntry);
        }
      }
    }
  }

  // ── Test 4: list_dead_letter_tasks returns dead letters ────────

  describe('list_dead_letter_tasks returns dead letters', () => {
    it('lists only dead-lettered tasks with correct fields', async () => {
      const tools = plugin.getTools();

      // Submit 3 tasks
      const id1 = await submitAndCommit({ command: 'task-1' });
      const id2 = await submitAndCommit({ command: 'task-2' });
      const id3 = await submitAndCommit({ command: 'task-3' });

      // Dead-letter 2 of them
      deadLetterTask(id1, 0);
      deadLetterTask(id3, 0);

      const result = (await tools.get('list_dead_letter_tasks')!.handler({})) as any;

      expect(result.tasks).toHaveLength(2);

      const taskIds = result.tasks.map((t: any) => t.taskId);
      expect(taskIds).toContain(id1);
      expect(taskIds).toContain(id3);
      expect(taskIds).not.toContain(id2);

      // Verify each dead-letter record has expected fields
      for (const task of result.tasks) {
        expect(task).toHaveProperty('taskId');
        expect(task).toHaveProperty('type');
        expect(task).toHaveProperty('error');
        expect(task).toHaveProperty('attempt');
        expect(task).toHaveProperty('deadLetteredAt');
        expect(task.deadLetteredAt).toBeDefined();
      }
    });
  });

  // ── Test 5: retry_dead_letter_task re-queues with attempt=0 ───

  describe('retry_dead_letter_task re-queues with attempt=0', () => {
    it('re-queues a dead-lettered task and resets attempt to 0', async () => {
      const tools = plugin.getTools();

      // Submit and dead-letter a task
      const taskId = await submitAndCommit({ command: 'retry-me', maxRetries: 0 });
      deadLetterTask(taskId, 0);

      // Confirm it is dead-lettered
      let task = db.prepare('SELECT * FROM te_tasks WHERE id = ?').get(taskId) as any;
      expect(task.state).toBe('dead_letter');

      // Call retry_dead_letter_task
      const prevLen = entryLog.length;
      const result = (await tools.get('retry_dead_letter_task')!.handler({
        taskId,
      })) as any;

      expect(result.retried).toBe(true);
      expect(result.taskId).toBe(taskId);

      // A task_retry entry should have been appended
      expect(entryLog.length).toBeGreaterThan(prevLen);
      const retryEntry = entryLog[entryLog.length - 1];
      expect(retryEntry.type).toBe('task_retry');

      // Verify the payload has attempt=0
      const parsed = JSON.parse(retryEntry.data.toString());
      expect(parsed.payload.attempt).toBe(0);

      // Simulate the Raft commit of the retry entry
      raftEmitter.emit('entryCommitted', retryEntry);

      // Verify task is now queued with attempt=0
      task = db.prepare('SELECT * FROM te_tasks WHERE id = ?').get(taskId) as any;
      expect(task.state).toBe('queued');
      expect(task.attempt).toBe(0);
    });
  });

  // ── Test 6: retry_dead_letter_task rejects non-dead-letter tasks ──

  describe('retry_dead_letter_task rejects non-dead-letter tasks', () => {
    it('returns retried=false for a queued task', async () => {
      const tools = plugin.getTools();

      // Submit a task (stays queued)
      const taskId = await submitAndCommit({ command: 'still-queued' });

      const result = (await tools.get('retry_dead_letter_task')!.handler({
        taskId,
      })) as any;

      expect(result.retried).toBe(false);
      expect(result.error).toContain('not in dead_letter state');
    });
  });

  // ── Test 7: retry_dead_letter_task rejects unknown tasks ───────

  describe('retry_dead_letter_task rejects unknown tasks', () => {
    it('returns retried=false with not found error', async () => {
      const tools = plugin.getTools();

      const result = (await tools.get('retry_dead_letter_task')!.handler({
        taskId: 'nonexistent-task-xyz',
      })) as any;

      expect(result.retried).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  // ── Test 8: Re-queued dead letter can be retried again ────────

  describe('re-queued dead letter can be retried again', () => {
    it('completes a full second lifecycle after dead-letter retry', async () => {
      const tools = plugin.getTools();

      // Submit and dead-letter a task (maxRetries=1: fail at 0, retry to 1, fail at 1 -> dead letter)
      const taskId = await submitAndCommit({ command: 'resilient-task', maxRetries: 1 });
      deadLetterTask(taskId, 1);

      // Confirm dead-lettered
      let task = db.prepare('SELECT * FROM te_tasks WHERE id = ?').get(taskId) as any;
      expect(task.state).toBe('dead_letter');

      // Retry the dead letter
      const prevLen = entryLog.length;
      const retryResult = (await tools.get('retry_dead_letter_task')!.handler({
        taskId,
      })) as any;
      expect(retryResult.retried).toBe(true);

      // Simulate the retry Raft commit
      const retryEntry = entryLog[entryLog.length - 1];
      raftEmitter.emit('entryCommitted', retryEntry);

      // Should be queued at attempt 0
      task = db.prepare('SELECT * FROM te_tasks WHERE id = ?').get(taskId) as any;
      expect(task.state).toBe('queued');
      expect(task.attempt).toBe(0);

      // Now run through another failure cycle:
      // Attempt 0: fail -> should get retry action (since maxRetries=1 still in policy, 0 < 1)
      const assignEntry0 = {
        type: 'task_assign',
        data: Buffer.from(JSON.stringify({
          type: 'task_assign',
          payload: { taskId, nodeId: 'node-a' },
        })),
      };
      raftEmitter.emit('entryCommitted', assignEntry0);

      const startEntry0 = {
        type: 'task_started',
        data: Buffer.from(JSON.stringify({
          type: 'task_started',
          payload: { taskId, nodeId: 'node-a' },
        })),
      };
      raftEmitter.emit('entryCommitted', startEntry0);

      const failEntry0 = {
        type: 'task_failed',
        data: Buffer.from(JSON.stringify({
          type: 'task_failed',
          payload: { taskId, error: 'round2-fail-0', nodeId: 'node-a' },
        })),
      };

      // Before emitting, record entryLog length to find the retry entry
      const preFailLen = entryLog.length;
      raftEmitter.emit('entryCommitted', failEntry0);

      // The leader should have appended a task_retry (since attempt 0 < maxRetries=1)
      const retryEntry2 = entryLog[entryLog.length - 1];
      expect(retryEntry2.type).toBe('task_retry');

      // Parse and verify attempt = 1
      const retryPayload = JSON.parse(retryEntry2.data.toString());
      expect(retryPayload.payload.attempt).toBe(1);

      // Commit the retry
      raftEmitter.emit('entryCommitted', retryEntry2);

      task = db.prepare('SELECT * FROM te_tasks WHERE id = ?').get(taskId) as any;
      expect(task.state).toBe('queued');
      expect(task.attempt).toBe(1);

      // Attempt 1: fail -> should dead-letter again (1 >= maxRetries=1)
      const assignEntry1 = {
        type: 'task_assign',
        data: Buffer.from(JSON.stringify({
          type: 'task_assign',
          payload: { taskId, nodeId: 'node-a' },
        })),
      };
      raftEmitter.emit('entryCommitted', assignEntry1);

      const startEntry1 = {
        type: 'task_started',
        data: Buffer.from(JSON.stringify({
          type: 'task_started',
          payload: { taskId, nodeId: 'node-a' },
        })),
      };
      raftEmitter.emit('entryCommitted', startEntry1);

      const failEntry1 = {
        type: 'task_failed',
        data: Buffer.from(JSON.stringify({
          type: 'task_failed',
          payload: { taskId, error: 'round2-fail-1', nodeId: 'node-a' },
        })),
      };
      raftEmitter.emit('entryCommitted', failEntry1);

      // The leader should have appended a task_dead_letter
      const dlEntry = entryLog[entryLog.length - 1];
      expect(dlEntry.type).toBe('task_dead_letter');

      // Commit the dead letter
      raftEmitter.emit('entryCommitted', dlEntry);

      // Verify task is dead-lettered again
      task = db.prepare('SELECT * FROM te_tasks WHERE id = ?').get(taskId) as any;
      expect(task.state).toBe('dead_letter');
      expect(task.error).toBe('round2-fail-1');
      expect(task.dead_lettered_at).toBeDefined();
    });
  });
});
