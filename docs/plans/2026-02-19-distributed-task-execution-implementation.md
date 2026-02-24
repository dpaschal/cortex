# Distributed Task Execution — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the in-memory TaskScheduler with a persistent, Raft-replicated task engine supporting resource-aware scheduling, DAG workflows with JS conditionals, task HA with re-queue/dead-letter, and 11 MCP tools.

**Architecture:** Tasks are first-class Raft log entries. A new `task-engine` plugin contains the state machine, scheduler, workflow engine, and MCP tools. On each committed Raft entry, the state machine writes to shared-memory SQLite tables. The scheduler runs only on the leader, scoring nodes by CPU/memory/GPU/disk/network headroom. DAG conditions are evaluated in a sandboxed `vm.runInNewContext()`.

**Tech Stack:** TypeScript, Node.js `vm` module (condition sandbox), SQLite via `better-sqlite3` (shared-memory-db), gRPC/Protobuf, Vitest (testing)

**Design doc:** `docs/plans/2026-02-19-distributed-task-execution-design.md`

---

## Phase 1: Persistence + Enhanced Scheduler (Tasks 1–8)

### Task 1: Add New Raft Log Entry Types

**Files:**
- Modify: `src/cluster/raft.ts:16-24` (LogEntryType union)
- Modify: `proto/cluster.proto:360-370` (LogEntryType enum)
- Test: `tests/raft.test.ts` (verify new types are recognized)

**Step 1: Add new entry types to TypeScript union**

In `src/cluster/raft.ts`, extend the `LogEntryType` type:

```typescript
export type LogEntryType =
  | 'noop'
  | 'config_change'
  | 'task_submit'
  | 'task_complete'
  | 'node_join'
  | 'node_leave'
  | 'context_update'
  | 'memory_write'
  | 'task_assign'
  | 'task_started'
  | 'task_failed'
  | 'task_cancel'
  | 'task_retry'
  | 'task_dead_letter'
  | 'workflow_submit'
  | 'workflow_advance';
```

**Step 2: Add new entry types to proto enum**

In `proto/cluster.proto`, extend `LogEntryType`:

```proto
enum LogEntryType {
  LOG_ENTRY_TYPE_UNKNOWN = 0;
  LOG_ENTRY_TYPE_NOOP = 1;
  LOG_ENTRY_TYPE_CONFIG_CHANGE = 2;
  LOG_ENTRY_TYPE_TASK_SUBMIT = 3;
  LOG_ENTRY_TYPE_TASK_COMPLETE = 4;
  LOG_ENTRY_TYPE_NODE_JOIN = 5;
  LOG_ENTRY_TYPE_NODE_LEAVE = 6;
  LOG_ENTRY_TYPE_CONTEXT_UPDATE = 7;
  LOG_ENTRY_TYPE_MEMORY_WRITE = 8;
  LOG_ENTRY_TYPE_TASK_ASSIGN = 10;
  LOG_ENTRY_TYPE_TASK_STARTED = 11;
  LOG_ENTRY_TYPE_TASK_FAILED = 12;
  LOG_ENTRY_TYPE_TASK_CANCEL = 13;
  LOG_ENTRY_TYPE_TASK_RETRY = 14;
  LOG_ENTRY_TYPE_TASK_DEAD_LETTER = 15;
  LOG_ENTRY_TYPE_WORKFLOW_SUBMIT = 16;
  LOG_ENTRY_TYPE_WORKFLOW_ADVANCE = 17;
}
```

**Step 3: Add proto messages for workflow support**

Append to `proto/cluster.proto` after the existing Task Messages section:

```proto
// Workflow Messages
message RetryPolicy {
  int32 max_retries = 1;
  int64 backoff_ms = 2;
  double backoff_multiplier = 3;
  bool retryable = 4;
}

message SubmitWorkflowRequest {
  string name = 1;
  map<string, WorkflowTaskDef> tasks = 2;
}

message WorkflowTaskDef {
  TaskSpec spec = 1;
  repeated string depends_on = 2;
  string condition = 3;
}

message WorkflowStatus {
  string workflow_id = 1;
  string name = 2;
  string state = 3;
  map<string, TaskStatus> task_statuses = 4;
  string context_json = 5;
}
```

**Step 4: Build to verify proto compiles**

Run: `cd /home/paschal/cortex && npm run build`
Expected: Clean build, no errors

**Step 5: Commit**

```bash
git add src/cluster/raft.ts proto/cluster.proto
git commit -m "feat(task-engine): add Raft log entry types and proto messages for distributed tasks"
```

---

### Task 2: Task Engine Types

**Files:**
- Create: `src/plugins/task-engine/types.ts`
- Test: `tests/plugins/task-engine/types.test.ts`

**Step 1: Write the types file**

Create `src/plugins/task-engine/types.ts`:

```typescript
export type TaskEngineState = 'queued' | 'pending' | 'assigned' | 'running' | 'completed' | 'failed' | 'cancelled' | 'skipped' | 'dead_letter';
export type TaskType = 'shell' | 'container' | 'subagent' | 'k8s_job' | 'claude_relay';
export type WorkflowState = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type TaskEventType = 'submitted' | 'assigned' | 'started' | 'completed' | 'failed' | 'retried' | 'cancelled' | 'dead_lettered' | 'skipped';

export interface TaskConstraints {
  requiresGpu?: boolean;
  avoidGaming?: boolean;
  minMemoryMb?: number;
  minDiskGb?: number;
  nodeLabels?: string[];
  targetNode?: string;
}

export interface RetryPolicy {
  maxRetries: number;
  backoffMs: number;
  backoffMultiplier: number;
  retryable: boolean;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  backoffMs: 1000,
  backoffMultiplier: 2,
  retryable: true,
};

export interface TaskRecord {
  id: string;
  workflow_id: string | null;
  task_key: string | null;
  type: TaskType;
  state: TaskEngineState;
  priority: number;
  spec: string; // JSON
  constraints: string | null; // JSON
  retry_policy: string | null; // JSON
  assigned_node: string | null;
  attempt: number;
  result: string | null; // JSON
  error: string | null;
  scheduled_after: string | null;
  created_at: string;
  assigned_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  dead_lettered_at: string | null;
}

export interface WorkflowRecord {
  id: string;
  name: string;
  state: WorkflowState;
  definition: string; // JSON
  context: string; // JSON
  created_at: string;
  completed_at: string | null;
}

export interface TaskDependencyRecord {
  workflow_id: string;
  task_key: string;
  depends_on_key: string;
  condition: string | null;
}

export interface TaskEventRecord {
  id?: number;
  task_id: string;
  event_type: TaskEventType;
  node_id: string;
  detail: string | null; // JSON
  created_at: string;
}

export interface WorkflowDefinition {
  name: string;
  tasks: Record<string, WorkflowTaskDef>;
}

export interface WorkflowTaskDef {
  type: TaskType;
  spec: Record<string, unknown>;
  constraints?: TaskConstraints;
  retryPolicy?: RetryPolicy;
  priority?: number;
  dependsOn?: string[];
  condition?: string; // JS expression
}

export interface TaskSubmitPayload {
  taskId: string;
  type: TaskType;
  spec: Record<string, unknown>;
  priority?: number;
  constraints?: TaskConstraints;
  retryPolicy?: RetryPolicy;
  workflowId?: string;
  taskKey?: string;
  submitterNode: string;
}

export interface TaskAssignPayload {
  taskId: string;
  nodeId: string;
}

export interface TaskStartedPayload {
  taskId: string;
  nodeId: string;
}

export interface TaskCompletePayload {
  taskId: string;
  result: { exitCode: number; stdout: string; stderr: string; contextUpdate?: Record<string, unknown> };
}

export interface TaskFailedPayload {
  taskId: string;
  error: string;
  nodeId: string;
}

export interface TaskCancelPayload {
  taskId: string;
}

export interface TaskRetryPayload {
  taskId: string;
  attempt: number;
  scheduledAfter: string; // ISO timestamp
}

export interface TaskDeadLetterPayload {
  taskId: string;
  reason: string;
}

export interface WorkflowSubmitPayload {
  workflowId: string;
  definition: WorkflowDefinition;
}

export interface WorkflowAdvancePayload {
  workflowId: string;
  completedTaskKey: string;
}

// Scoring weights for resource-aware scheduling
export interface SchedulerWeights {
  cpuHeadroom: number;
  memoryHeadroom: number;
  diskIoHeadroom: number;
  networkHeadroom: number;
  gpuHeadroom: number;
  taskCountPenalty: number;
}

export const DEFAULT_SCHEDULER_WEIGHTS: SchedulerWeights = {
  cpuHeadroom: 0.3,
  memoryHeadroom: 0.3,
  diskIoHeadroom: 0.15,
  networkHeadroom: 0.1,
  gpuHeadroom: 0.15,
  taskCountPenalty: 5,
};
```

**Step 2: Write type validation test**

Create `tests/plugins/task-engine/types.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { DEFAULT_RETRY_POLICY, DEFAULT_SCHEDULER_WEIGHTS } from '../../../src/plugins/task-engine/types.js';

describe('Task Engine Types', () => {
  it('has sensible default retry policy', () => {
    expect(DEFAULT_RETRY_POLICY.maxRetries).toBe(3);
    expect(DEFAULT_RETRY_POLICY.backoffMs).toBe(1000);
    expect(DEFAULT_RETRY_POLICY.backoffMultiplier).toBe(2);
    expect(DEFAULT_RETRY_POLICY.retryable).toBe(true);
  });

  it('has scheduler weights summing to ~1.0', () => {
    const w = DEFAULT_SCHEDULER_WEIGHTS;
    const sum = w.cpuHeadroom + w.memoryHeadroom + w.diskIoHeadroom + w.networkHeadroom + w.gpuHeadroom;
    expect(sum).toBe(1.0);
  });
});
```

**Step 3: Run test**

Run: `cd /home/paschal/cortex && npx vitest run tests/plugins/task-engine/types.test.ts`
Expected: 2 tests PASS

**Step 4: Commit**

```bash
git add src/plugins/task-engine/types.ts tests/plugins/task-engine/types.test.ts
git commit -m "feat(task-engine): add TypeScript types for task engine"
```

---

### Task 3: SQLite Migrations

**Files:**
- Create: `src/plugins/task-engine/migrations.ts`
- Test: `tests/plugins/task-engine/migrations.test.ts`

**Step 1: Write the failing test**

Create `tests/plugins/task-engine/migrations.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../src/plugins/task-engine/migrations.js';

describe('Task Engine Migrations', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('creates all required tables', () => {
    runMigrations(db);

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all().map((r: any) => r.name);

    expect(tables).toContain('te_tasks');
    expect(tables).toContain('te_workflows');
    expect(tables).toContain('te_task_dependencies');
    expect(tables).toContain('te_task_events');
  });

  it('creates tasks table with all columns', () => {
    runMigrations(db);

    const cols = db.prepare("PRAGMA table_info(te_tasks)").all().map((c: any) => c.name);
    expect(cols).toEqual(expect.arrayContaining([
      'id', 'workflow_id', 'task_key', 'type', 'state', 'priority',
      'spec', 'constraints', 'retry_policy', 'assigned_node', 'attempt',
      'result', 'error', 'scheduled_after', 'created_at', 'assigned_at',
      'started_at', 'completed_at', 'dead_lettered_at',
    ]));
  });

  it('creates indexes for common queries', () => {
    runMigrations(db);

    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_te_%'"
    ).all().map((r: any) => r.name);

    expect(indexes.length).toBeGreaterThanOrEqual(3);
  });

  it('is idempotent', () => {
    runMigrations(db);
    runMigrations(db); // Should not throw
    const count = db.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name LIKE 'te_%'").get() as any;
    expect(count.c).toBe(4);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /home/paschal/cortex && npx vitest run tests/plugins/task-engine/migrations.test.ts`
Expected: FAIL — module not found

**Step 3: Write the migration module**

Create `src/plugins/task-engine/migrations.ts`:

```typescript
import Database from 'better-sqlite3';

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS te_tasks (
      id TEXT PRIMARY KEY,
      workflow_id TEXT,
      task_key TEXT,
      type TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued',
      priority INTEGER NOT NULL DEFAULT 0,
      spec TEXT NOT NULL,
      constraints TEXT,
      retry_policy TEXT,
      assigned_node TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      result TEXT,
      error TEXT,
      scheduled_after TEXT,
      created_at TEXT NOT NULL,
      assigned_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      dead_lettered_at TEXT
    );

    CREATE TABLE IF NOT EXISTS te_workflows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      definition TEXT NOT NULL,
      context TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS te_task_dependencies (
      workflow_id TEXT NOT NULL,
      task_key TEXT NOT NULL,
      depends_on_key TEXT NOT NULL,
      condition TEXT,
      PRIMARY KEY (workflow_id, task_key, depends_on_key)
    );

    CREATE TABLE IF NOT EXISTS te_task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      node_id TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_te_tasks_state ON te_tasks(state);
    CREATE INDEX IF NOT EXISTS idx_te_tasks_workflow ON te_tasks(workflow_id);
    CREATE INDEX IF NOT EXISTS idx_te_tasks_assigned ON te_tasks(assigned_node, state);
    CREATE INDEX IF NOT EXISTS idx_te_events_task ON te_task_events(task_id);
    CREATE INDEX IF NOT EXISTS idx_te_deps_workflow ON te_task_dependencies(workflow_id);
  `);
}
```

**Step 4: Run test to verify it passes**

Run: `cd /home/paschal/cortex && npx vitest run tests/plugins/task-engine/migrations.test.ts`
Expected: 4 tests PASS

**Step 5: Commit**

```bash
git add src/plugins/task-engine/migrations.ts tests/plugins/task-engine/migrations.test.ts
git commit -m "feat(task-engine): SQLite migrations for tasks, workflows, dependencies, events"
```

---

### Task 4: Task State Machine

**Files:**
- Create: `src/plugins/task-engine/state-machine.ts`
- Test: `tests/plugins/task-engine/state-machine.test.ts`

**Step 1: Write the failing test**

Create `tests/plugins/task-engine/state-machine.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { TaskStateMachine } from '../../../src/plugins/task-engine/state-machine.js';
import { runMigrations } from '../../../src/plugins/task-engine/migrations.js';
import { TaskSubmitPayload, TaskAssignPayload, TaskCompletePayload, TaskFailedPayload, TaskRetryPayload, TaskDeadLetterPayload } from '../../../src/plugins/task-engine/types.js';
import winston from 'winston';

const logger = winston.createLogger({ transports: [new winston.transports.Console({ level: 'warn' })] });

describe('TaskStateMachine', () => {
  let db: Database.Database;
  let sm: TaskStateMachine;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    sm = new TaskStateMachine(db, 'test-node', logger);
  });

  afterEach(() => {
    db.close();
  });

  describe('task_submit', () => {
    it('inserts a queued task', () => {
      const payload: TaskSubmitPayload = {
        taskId: 'task-1',
        type: 'shell',
        spec: { command: 'echo hello' },
        priority: 5,
        submitterNode: 'node-1',
      };

      sm.applyEntry('task_submit', payload);

      const task = db.prepare('SELECT * FROM te_tasks WHERE id = ?').get('task-1') as any;
      expect(task).toBeTruthy();
      expect(task.state).toBe('queued');
      expect(task.type).toBe('shell');
      expect(task.priority).toBe(5);
      expect(JSON.parse(task.spec)).toEqual({ command: 'echo hello' });
    });

    it('records a submitted event', () => {
      sm.applyEntry('task_submit', {
        taskId: 'task-1', type: 'shell', spec: { command: 'ls' }, submitterNode: 'node-1',
      });

      const events = db.prepare('SELECT * FROM te_task_events WHERE task_id = ?').all('task-1') as any[];
      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe('submitted');
    });
  });

  describe('task_assign', () => {
    it('updates task to assigned state', () => {
      sm.applyEntry('task_submit', { taskId: 't1', type: 'shell', spec: {}, submitterNode: 'n1' });
      sm.applyEntry('task_assign', { taskId: 't1', nodeId: 'node-2' } as TaskAssignPayload);

      const task = db.prepare('SELECT * FROM te_tasks WHERE id = ?').get('t1') as any;
      expect(task.state).toBe('assigned');
      expect(task.assigned_node).toBe('node-2');
      expect(task.assigned_at).toBeTruthy();
    });
  });

  describe('task_complete', () => {
    it('updates task to completed with result', () => {
      sm.applyEntry('task_submit', { taskId: 't1', type: 'shell', spec: {}, submitterNode: 'n1' });
      sm.applyEntry('task_assign', { taskId: 't1', nodeId: 'n2' });
      sm.applyEntry('task_started', { taskId: 't1', nodeId: 'n2' });

      const result = { exitCode: 0, stdout: 'ok', stderr: '' };
      sm.applyEntry('task_complete', { taskId: 't1', result } as TaskCompletePayload);

      const task = db.prepare('SELECT * FROM te_tasks WHERE id = ?').get('t1') as any;
      expect(task.state).toBe('completed');
      expect(JSON.parse(task.result)).toEqual(result);
      expect(task.completed_at).toBeTruthy();
    });
  });

  describe('task_failed with retry', () => {
    it('returns retry action when retryable and under max retries', () => {
      const retryPolicy = { maxRetries: 3, backoffMs: 1000, backoffMultiplier: 2, retryable: true };
      sm.applyEntry('task_submit', {
        taskId: 't1', type: 'shell', spec: {}, submitterNode: 'n1', retryPolicy,
      });
      sm.applyEntry('task_assign', { taskId: 't1', nodeId: 'n2' });
      sm.applyEntry('task_started', { taskId: 't1', nodeId: 'n2' });

      const action = sm.applyEntry('task_failed', { taskId: 't1', error: 'boom', nodeId: 'n2' });
      expect(action).toEqual(expect.objectContaining({ type: 'retry', taskId: 't1' }));
    });

    it('returns dead_letter action when max retries exceeded', () => {
      const retryPolicy = { maxRetries: 1, backoffMs: 100, backoffMultiplier: 1, retryable: true };
      sm.applyEntry('task_submit', { taskId: 't1', type: 'shell', spec: {}, submitterNode: 'n1', retryPolicy });
      sm.applyEntry('task_assign', { taskId: 't1', nodeId: 'n2' });
      sm.applyEntry('task_started', { taskId: 't1', nodeId: 'n2' });

      // First failure -> retry
      sm.applyEntry('task_failed', { taskId: 't1', error: 'fail1', nodeId: 'n2' });
      sm.applyEntry('task_retry', { taskId: 't1', attempt: 1, scheduledAfter: new Date().toISOString() });
      sm.applyEntry('task_assign', { taskId: 't1', nodeId: 'n2' });
      sm.applyEntry('task_started', { taskId: 't1', nodeId: 'n2' });

      // Second failure -> dead letter (maxRetries=1, attempt is now 1)
      const action = sm.applyEntry('task_failed', { taskId: 't1', error: 'fail2', nodeId: 'n2' });
      expect(action).toEqual(expect.objectContaining({ type: 'dead_letter', taskId: 't1' }));
    });
  });

  describe('task_retry', () => {
    it('resets task to queued with incremented attempt', () => {
      sm.applyEntry('task_submit', { taskId: 't1', type: 'shell', spec: {}, submitterNode: 'n1' });
      sm.applyEntry('task_retry', { taskId: 't1', attempt: 1, scheduledAfter: '2026-02-20T00:00:00Z' });

      const task = db.prepare('SELECT * FROM te_tasks WHERE id = ?').get('t1') as any;
      expect(task.state).toBe('queued');
      expect(task.attempt).toBe(1);
      expect(task.assigned_node).toBeNull();
      expect(task.scheduled_after).toBe('2026-02-20T00:00:00Z');
    });
  });

  describe('task_dead_letter', () => {
    it('moves task to dead_letter state', () => {
      sm.applyEntry('task_submit', { taskId: 't1', type: 'shell', spec: {}, submitterNode: 'n1' });
      sm.applyEntry('task_dead_letter', { taskId: 't1', reason: 'max retries exceeded' });

      const task = db.prepare('SELECT * FROM te_tasks WHERE id = ?').get('t1') as any;
      expect(task.state).toBe('dead_letter');
      expect(task.dead_lettered_at).toBeTruthy();
    });
  });

  describe('task_cancel', () => {
    it('cancels a queued task', () => {
      sm.applyEntry('task_submit', { taskId: 't1', type: 'shell', spec: {}, submitterNode: 'n1' });
      const action = sm.applyEntry('task_cancel', { taskId: 't1' });

      const task = db.prepare('SELECT * FROM te_tasks WHERE id = ?').get('t1') as any;
      expect(task.state).toBe('cancelled');
    });

    it('returns cancel_running action for running task', () => {
      sm.applyEntry('task_submit', { taskId: 't1', type: 'shell', spec: {}, submitterNode: 'n1' });
      sm.applyEntry('task_assign', { taskId: 't1', nodeId: 'n2' });
      sm.applyEntry('task_started', { taskId: 't1', nodeId: 'n2' });

      const action = sm.applyEntry('task_cancel', { taskId: 't1' });
      expect(action).toEqual(expect.objectContaining({ type: 'cancel_running', nodeId: 'n2' }));
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /home/paschal/cortex && npx vitest run tests/plugins/task-engine/state-machine.test.ts`
Expected: FAIL — module not found

**Step 3: Implement the state machine**

Create `src/plugins/task-engine/state-machine.ts`:

```typescript
import Database from 'better-sqlite3';
import { Logger } from 'winston';
import type { LogEntryType } from '../../cluster/raft.js';
import {
  TaskSubmitPayload, TaskAssignPayload, TaskStartedPayload,
  TaskCompletePayload, TaskFailedPayload, TaskCancelPayload,
  TaskRetryPayload, TaskDeadLetterPayload,
  WorkflowSubmitPayload, WorkflowAdvancePayload,
  TaskRecord, DEFAULT_RETRY_POLICY,
} from './types.js';

export interface StateMachineAction {
  type: 'retry' | 'dead_letter' | 'cancel_running' | 'schedule' | 'workflow_advance';
  taskId?: string;
  workflowId?: string;
  nodeId?: string;
  attempt?: number;
  scheduledAfter?: string;
  reason?: string;
}

export class TaskStateMachine {
  constructor(
    private db: Database.Database,
    private nodeId: string,
    private logger: Logger,
  ) {}

  applyEntry(type: LogEntryType | string, payload: unknown): StateMachineAction | null {
    switch (type) {
      case 'task_submit': return this.applyTaskSubmit(payload as TaskSubmitPayload);
      case 'task_assign': return this.applyTaskAssign(payload as TaskAssignPayload);
      case 'task_started': return this.applyTaskStarted(payload as TaskStartedPayload);
      case 'task_complete': return this.applyTaskComplete(payload as TaskCompletePayload);
      case 'task_failed': return this.applyTaskFailed(payload as TaskFailedPayload);
      case 'task_cancel': return this.applyTaskCancel(payload as TaskCancelPayload);
      case 'task_retry': return this.applyTaskRetry(payload as TaskRetryPayload);
      case 'task_dead_letter': return this.applyTaskDeadLetter(payload as TaskDeadLetterPayload);
      case 'workflow_submit': return this.applyWorkflowSubmit(payload as WorkflowSubmitPayload);
      case 'workflow_advance': return this.applyWorkflowAdvance(payload as WorkflowAdvancePayload);
      default: return null;
    }
  }

  private applyTaskSubmit(p: TaskSubmitPayload): StateMachineAction | null {
    const now = new Date().toISOString();
    const state = p.workflowId && p.taskKey ? 'pending' : 'queued';

    this.db.prepare(`
      INSERT INTO te_tasks (id, workflow_id, task_key, type, state, priority, spec, constraints, retry_policy, attempt, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(
      p.taskId, p.workflowId ?? null, p.taskKey ?? null, p.type, state,
      p.priority ?? 0, JSON.stringify(p.spec),
      p.constraints ? JSON.stringify(p.constraints) : null,
      p.retryPolicy ? JSON.stringify(p.retryPolicy) : null,
      now,
    );

    this.insertEvent(p.taskId, 'submitted', { submitterNode: p.submitterNode });

    if (state === 'queued') {
      return { type: 'schedule' };
    }
    return null;
  }

  private applyTaskAssign(p: TaskAssignPayload): null {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE te_tasks SET state = 'assigned', assigned_node = ?, assigned_at = ? WHERE id = ?
    `).run(p.nodeId, now, p.taskId);

    this.insertEvent(p.taskId, 'assigned', { nodeId: p.nodeId });
    return null;
  }

  private applyTaskStarted(p: TaskStartedPayload): null {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE te_tasks SET state = 'running', started_at = ? WHERE id = ?
    `).run(now, p.taskId);

    this.insertEvent(p.taskId, 'started', { nodeId: p.nodeId });
    return null;
  }

  private applyTaskComplete(p: TaskCompletePayload): StateMachineAction | null {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE te_tasks SET state = 'completed', result = ?, completed_at = ? WHERE id = ?
    `).run(JSON.stringify(p.result), now, p.taskId);

    this.insertEvent(p.taskId, 'completed', p.result);

    // Check if part of a workflow
    const task = this.db.prepare('SELECT workflow_id, task_key FROM te_tasks WHERE id = ?').get(p.taskId) as any;
    if (task?.workflow_id) {
      return { type: 'workflow_advance', workflowId: task.workflow_id, taskId: p.taskId };
    }
    return null;
  }

  private applyTaskFailed(p: TaskFailedPayload): StateMachineAction {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE te_tasks SET error = ?, completed_at = ? WHERE id = ?
    `).run(p.error, now, p.taskId);

    this.insertEvent(p.taskId, 'failed', { error: p.error, nodeId: p.nodeId });

    // Check retry policy
    const task = this.db.prepare('SELECT attempt, retry_policy, workflow_id FROM te_tasks WHERE id = ?').get(p.taskId) as any;
    const policy = task?.retry_policy ? JSON.parse(task.retry_policy) : DEFAULT_RETRY_POLICY;

    if (policy.retryable && task.attempt < policy.maxRetries) {
      const backoffMs = policy.backoffMs * Math.pow(policy.backoffMultiplier, task.attempt);
      const scheduledAfter = new Date(Date.now() + backoffMs).toISOString();
      return { type: 'retry', taskId: p.taskId, attempt: task.attempt + 1, scheduledAfter };
    }

    return { type: 'dead_letter', taskId: p.taskId, reason: `Failed after ${task.attempt + 1} attempts: ${p.error}` };
  }

  private applyTaskCancel(p: TaskCancelPayload): StateMachineAction | null {
    const task = this.db.prepare('SELECT state, assigned_node FROM te_tasks WHERE id = ?').get(p.taskId) as any;
    if (!task) return null;

    this.db.prepare(`
      UPDATE te_tasks SET state = 'cancelled', completed_at = ? WHERE id = ?
    `).run(new Date().toISOString(), p.taskId);

    this.insertEvent(p.taskId, 'cancelled', {});

    if (task.state === 'running' && task.assigned_node) {
      return { type: 'cancel_running', taskId: p.taskId, nodeId: task.assigned_node };
    }
    return null;
  }

  private applyTaskRetry(p: TaskRetryPayload): StateMachineAction {
    this.db.prepare(`
      UPDATE te_tasks SET state = 'queued', attempt = ?, assigned_node = NULL,
        assigned_at = NULL, started_at = NULL, completed_at = NULL,
        error = NULL, result = NULL, scheduled_after = ?
      WHERE id = ?
    `).run(p.attempt, p.scheduledAfter, p.taskId);

    this.insertEvent(p.taskId, 'retried', { attempt: p.attempt, scheduledAfter: p.scheduledAfter });
    return { type: 'schedule' };
  }

  private applyTaskDeadLetter(p: TaskDeadLetterPayload): null {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE te_tasks SET state = 'dead_letter', dead_lettered_at = ?, error = ? WHERE id = ?
    `).run(now, p.reason, p.taskId);

    this.insertEvent(p.taskId, 'dead_lettered', { reason: p.reason });
    return null;
  }

  private applyWorkflowSubmit(p: WorkflowSubmitPayload): StateMachineAction {
    // Implemented in Task 9 (Phase 2)
    return { type: 'schedule' };
  }

  private applyWorkflowAdvance(p: WorkflowAdvancePayload): StateMachineAction | null {
    // Implemented in Task 9 (Phase 2)
    return null;
  }

  // Query helpers (used by MCP tools)

  getTask(taskId: string): TaskRecord | undefined {
    return this.db.prepare('SELECT * FROM te_tasks WHERE id = ?').get(taskId) as TaskRecord | undefined;
  }

  listTasks(opts: { state?: string; workflowId?: string; nodeId?: string; limit?: number; offset?: number }): TaskRecord[] {
    let sql = 'SELECT * FROM te_tasks WHERE 1=1';
    const params: unknown[] = [];

    if (opts.state) { sql += ' AND state = ?'; params.push(opts.state); }
    if (opts.workflowId) { sql += ' AND workflow_id = ?'; params.push(opts.workflowId); }
    if (opts.nodeId) { sql += ' AND assigned_node = ?'; params.push(opts.nodeId); }

    sql += ' ORDER BY priority DESC, created_at ASC';
    sql += ` LIMIT ? OFFSET ?`;
    params.push(opts.limit ?? 50, opts.offset ?? 0);

    return this.db.prepare(sql).all(...params) as TaskRecord[];
  }

  getQueuedTasks(): TaskRecord[] {
    const now = new Date().toISOString();
    return this.db.prepare(`
      SELECT * FROM te_tasks
      WHERE state = 'queued' AND (scheduled_after IS NULL OR scheduled_after <= ?)
      ORDER BY priority DESC, created_at ASC
    `).all(now) as TaskRecord[];
  }

  getTasksOnNode(nodeId: string): TaskRecord[] {
    return this.db.prepare(`
      SELECT * FROM te_tasks WHERE assigned_node = ? AND state IN ('assigned', 'running')
    `).all(nodeId) as TaskRecord[];
  }

  getDeadLetterTasks(limit = 50): TaskRecord[] {
    return this.db.prepare(`
      SELECT * FROM te_tasks WHERE state = 'dead_letter' ORDER BY dead_lettered_at DESC LIMIT ?
    `).all(limit) as TaskRecord[];
  }

  getTaskEvents(taskId: string): any[] {
    return this.db.prepare('SELECT * FROM te_task_events WHERE task_id = ? ORDER BY created_at ASC').all(taskId);
  }

  private insertEvent(taskId: string, eventType: string, detail: unknown): void {
    this.db.prepare(`
      INSERT INTO te_task_events (task_id, event_type, node_id, detail, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(taskId, eventType, this.nodeId, detail ? JSON.stringify(detail) : null, new Date().toISOString());
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd /home/paschal/cortex && npx vitest run tests/plugins/task-engine/state-machine.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/plugins/task-engine/state-machine.ts tests/plugins/task-engine/state-machine.test.ts
git commit -m "feat(task-engine): Raft-driven task state machine with persistence"
```

---

### Task 5: Resource-Aware Scheduler

**Files:**
- Create: `src/plugins/task-engine/scheduler.ts`
- Test: `tests/plugins/task-engine/scheduler.test.ts`

**Step 1: Write the failing test**

Create `tests/plugins/task-engine/scheduler.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ResourceAwareScheduler } from '../../../src/plugins/task-engine/scheduler.js';
import { DEFAULT_SCHEDULER_WEIGHTS, TaskRecord } from '../../../src/plugins/task-engine/types.js';
import winston from 'winston';

const logger = winston.createLogger({ transports: [new winston.transports.Console({ level: 'warn' })] });

function makeNode(id: string, overrides: Record<string, any> = {}) {
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
    resources: {
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

describe('ResourceAwareScheduler', () => {
  let scheduler: ResourceAwareScheduler;
  let mockRaft: any;
  let mockMembership: any;

  beforeEach(() => {
    mockRaft = {
      isLeader: vi.fn().mockReturnValue(true),
      appendEntry: vi.fn().mockResolvedValue({ success: true, index: 1 }),
    };
    mockMembership = {
      getActiveNodes: vi.fn().mockReturnValue([]),
    };
    scheduler = new ResourceAwareScheduler({
      raft: mockRaft,
      membership: mockMembership,
      weights: DEFAULT_SCHEDULER_WEIGHTS,
      logger,
    });
  });

  it('picks the node with most available resources', () => {
    const nodes = [
      makeNode('busy', { cpuPct: 90, memAvail: 2e9 }),
      makeNode('idle', { cpuPct: 10, memAvail: 14e9 }),
    ];
    mockMembership.getActiveNodes.mockReturnValue(nodes);

    const task = { id: 't1', type: 'shell', state: 'queued', priority: 0, constraints: null } as any;
    const pick = scheduler.pickNode(task);
    expect(pick?.nodeId).toBe('idle');
  });

  it('excludes nodes without GPU when required', () => {
    const nodes = [
      makeNode('no-gpu', { cpuPct: 10, memAvail: 14e9 }),
      makeNode('has-gpu', { cpuPct: 50, memAvail: 8e9, gpus: [{ name: 'P4', memoryBytes: 8e9, memoryAvailableBytes: 6e9, utilizationPercent: 10, inUseForGaming: false }] }),
    ];
    mockMembership.getActiveNodes.mockReturnValue(nodes);

    const task = { id: 't1', type: 'shell', state: 'queued', constraints: '{"requiresGpu":true}' } as any;
    const pick = scheduler.pickNode(task);
    expect(pick?.nodeId).toBe('has-gpu');
  });

  it('avoids gaming nodes when requested', () => {
    const nodes = [
      makeNode('gaming', { gaming: true, cpuPct: 10, memAvail: 14e9 }),
      makeNode('server', { cpuPct: 60, memAvail: 6e9 }),
    ];
    mockMembership.getActiveNodes.mockReturnValue(nodes);

    const task = { id: 't1', type: 'shell', state: 'queued', constraints: '{"avoidGaming":true}' } as any;
    const pick = scheduler.pickNode(task);
    expect(pick?.nodeId).toBe('server');
  });

  it('returns null when no nodes meet constraints', () => {
    const nodes = [makeNode('low-mem', { memAvail: 1e9 })];
    mockMembership.getActiveNodes.mockReturnValue(nodes);

    const task = { id: 't1', type: 'shell', state: 'queued', constraints: '{"minMemoryMb":8000}' } as any;
    const pick = scheduler.pickNode(task);
    expect(pick).toBeNull();
  });

  it('penalizes nodes with running tasks', () => {
    const nodes = [
      makeNode('loaded', { cpuPct: 30, memAvail: 8e9 }),
      makeNode('empty', { cpuPct: 30, memAvail: 8e9 }),
    ];
    mockMembership.getActiveNodes.mockReturnValue(nodes);

    // Simulate 3 running tasks on 'loaded'
    scheduler.setRunningTaskCount('loaded', 3);

    const task = { id: 't1', type: 'shell', state: 'queued', constraints: null } as any;
    const pick = scheduler.pickNode(task);
    expect(pick?.nodeId).toBe('empty');
  });

  it('pins to targetNode when specified', () => {
    const nodes = [
      makeNode('fast', { cpuPct: 10, memAvail: 14e9 }),
      makeNode('target', { cpuPct: 80, memAvail: 2e9 }),
    ];
    mockMembership.getActiveNodes.mockReturnValue(nodes);

    const task = { id: 't1', type: 'shell', state: 'queued', constraints: '{"targetNode":"target"}' } as any;
    const pick = scheduler.pickNode(task);
    expect(pick?.nodeId).toBe('target');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /home/paschal/cortex && npx vitest run tests/plugins/task-engine/scheduler.test.ts`
Expected: FAIL — module not found

**Step 3: Implement the scheduler**

Create `src/plugins/task-engine/scheduler.ts`:

```typescript
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
    const constraints: TaskConstraints | null = task.constraints ? JSON.parse(task.constraints) : null;

    // Target node pin — bypass scoring
    if (constraints?.targetNode) {
      const nodes = this.config.membership.getActiveNodes();
      return nodes.find(n => n.nodeId === constraints.targetNode || n.hostname === constraints.targetNode) ?? null;
    }

    const candidates = this.filterNodes(constraints);
    if (candidates.length === 0) return null;

    const scored = candidates.map(node => ({
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
      nodes = nodes.filter(n => n.resources?.gpus.some(g => !g.inUseForGaming));
    }

    if (constraints.avoidGaming) {
      nodes = nodes.filter(n => !n.resources?.gamingDetected);
    }

    if (constraints.minMemoryMb) {
      const minBytes = constraints.minMemoryMb * 1e6;
      nodes = nodes.filter(n => (n.resources?.memoryAvailableBytes ?? 0) >= minBytes);
    }

    if (constraints.minDiskGb) {
      const minBytes = constraints.minDiskGb * 1e9;
      nodes = nodes.filter(n => (n.resources?.diskAvailableBytes ?? 0) >= minBytes);
    }

    if (constraints.nodeLabels?.length) {
      nodes = nodes.filter(n =>
        constraints.nodeLabels!.some(label => n.tags.includes(label))
      );
    }

    return nodes;
  }

  private scoreNode(node: NodeInfo, constraints: TaskConstraints | null): number {
    const r = node.resources;
    if (!r) return 0;

    let score = 0;

    // CPU headroom
    score += (100 - r.cpuUsagePercent) * this.weights.cpuHeadroom;

    // Memory headroom
    const memPct = r.memoryBytes > 0 ? (r.memoryAvailableBytes / r.memoryBytes * 100) : 0;
    score += memPct * this.weights.memoryHeadroom;

    // Disk I/O headroom — not in current NodeResources, use disk capacity as proxy
    const diskPct = r.diskBytes > 0 ? (r.diskAvailableBytes / r.diskBytes * 100) : 0;
    score += diskPct * this.weights.diskIoHeadroom;

    // Network headroom — not in current NodeResources, skip for now (weight redistributes)
    // score += networkHeadroom * this.weights.networkHeadroom;

    // GPU headroom (if task needs GPU)
    if (constraints?.requiresGpu) {
      const gpu = r.gpus.find(g => !g.inUseForGaming);
      if (gpu) {
        score += (100 - gpu.utilizationPercent) * this.weights.gpuHeadroom;
      }
    }

    // Gaming penalty
    if (r.gamingDetected) {
      score -= 40;
    }

    // Task count penalty
    const taskCount = this.runningTaskCounts.get(node.nodeId) ?? 0;
    score -= taskCount * this.weights.taskCountPenalty;

    return score;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd /home/paschal/cortex && npx vitest run tests/plugins/task-engine/scheduler.test.ts`
Expected: 6 tests PASS

**Step 5: Commit**

```bash
git add src/plugins/task-engine/scheduler.ts tests/plugins/task-engine/scheduler.test.ts
git commit -m "feat(task-engine): resource-aware scheduler with constraint filtering and scoring"
```

---

### Task 6: Condition Evaluator (Sandboxed JS)

**Files:**
- Create: `src/plugins/task-engine/condition-eval.ts`
- Test: `tests/plugins/task-engine/condition-eval.test.ts`

**Step 1: Write the failing test**

Create `tests/plugins/task-engine/condition-eval.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { evaluateCondition } from '../../../src/plugins/task-engine/condition-eval.js';

describe('Condition Evaluator', () => {
  const parentContext = {
    build: { exitCode: 0, stdout: 'Build OK\n0 failures', stderr: '', state: 'completed' },
    test: { exitCode: 1, stdout: '3 failures', stderr: 'Error', state: 'failed' },
  };

  it('evaluates simple exit code check', () => {
    expect(evaluateCondition('parent.build.exitCode === 0', parentContext)).toBe(true);
    expect(evaluateCondition('parent.test.exitCode === 0', parentContext)).toBe(false);
  });

  it('evaluates string includes', () => {
    expect(evaluateCondition("parent.build.stdout.includes('0 failures')", parentContext)).toBe(true);
    expect(evaluateCondition("parent.test.stdout.includes('0 failures')", parentContext)).toBe(false);
  });

  it('evaluates compound conditions', () => {
    expect(evaluateCondition(
      "parent.build.exitCode === 0 && parent.build.stdout.includes('OK')",
      parentContext,
    )).toBe(true);
  });

  it('evaluates regex', () => {
    expect(evaluateCondition("/\\d+ failures/.test(parent.test.stdout)", parentContext)).toBe(true);
  });

  it('returns true for null/empty condition', () => {
    expect(evaluateCondition(null, parentContext)).toBe(true);
    expect(evaluateCondition('', parentContext)).toBe(true);
  });

  it('returns false on evaluation error', () => {
    expect(evaluateCondition('nonexistent.foo.bar', parentContext)).toBe(false);
  });

  it('cannot access process or require', () => {
    expect(evaluateCondition("typeof process !== 'undefined'", parentContext)).toBe(false);
    expect(evaluateCondition("typeof require !== 'undefined'", parentContext)).toBe(false);
  });

  it('times out on infinite loops', () => {
    expect(evaluateCondition('(() => { while(true){} })()', parentContext)).toBe(false);
  });

  it('supports workflow context', () => {
    const ctx = { ...parentContext };
    const workflowCtx = { version: '1.2.3' };
    expect(evaluateCondition(
      "workflow.context.version === '1.2.3'",
      ctx,
      workflowCtx,
    )).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /home/paschal/cortex && npx vitest run tests/plugins/task-engine/condition-eval.test.ts`
Expected: FAIL — module not found

**Step 3: Implement the evaluator**

Create `src/plugins/task-engine/condition-eval.ts`:

```typescript
import vm from 'node:vm';

const TIMEOUT_MS = 100;

export function evaluateCondition(
  condition: string | null | undefined,
  parentResults: Record<string, { exitCode: number; stdout: string; stderr: string; state: string }>,
  workflowContext?: Record<string, unknown>,
): boolean {
  if (!condition || condition.trim() === '') return true;

  try {
    const sandbox = Object.freeze({
      parent: Object.freeze(
        Object.fromEntries(
          Object.entries(parentResults).map(([k, v]) => [k, Object.freeze({ ...v })])
        )
      ),
      workflow: Object.freeze({
        context: Object.freeze(workflowContext ?? {}),
      }),
    });

    const context = vm.createContext(sandbox, {
      codeGeneration: { strings: false, wasm: false },
    });

    const result = vm.runInContext(`(${condition})`, context, { timeout: TIMEOUT_MS });
    return Boolean(result);
  } catch {
    return false;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd /home/paschal/cortex && npx vitest run tests/plugins/task-engine/condition-eval.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/plugins/task-engine/condition-eval.ts tests/plugins/task-engine/condition-eval.test.ts
git commit -m "feat(task-engine): sandboxed JS condition evaluator for workflow DAG branching"
```

---

### Task 7: Task Engine Plugin (MCP Tools)

**Files:**
- Create: `src/plugins/task-engine/index.ts`
- Test: `tests/plugins/task-engine/index.test.ts`

**Step 1: Write the failing test**

Create `tests/plugins/task-engine/index.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskEnginePlugin } from '../../../src/plugins/task-engine/index.js';
import winston from 'winston';
import Database from 'better-sqlite3';
import { EventEmitter } from 'events';

const logger = winston.createLogger({ transports: [new winston.transports.Console({ level: 'warn' })] });

describe('TaskEnginePlugin', () => {
  let plugin: TaskEnginePlugin;
  let mockCtx: any;

  beforeEach(() => {
    const db = new Database(':memory:');
    mockCtx = {
      raft: {
        isLeader: vi.fn().mockReturnValue(true),
        appendEntry: vi.fn().mockResolvedValue({ success: true, index: 1 }),
        on: vi.fn(),
        removeListener: vi.fn(),
      },
      membership: {
        getActiveNodes: vi.fn().mockReturnValue([]),
        on: vi.fn(),
        removeListener: vi.fn(),
      },
      scheduler: { stop: vi.fn() },
      stateManager: {},
      clientPool: {},
      sharedMemoryDb: { db },
      memoryReplicator: {},
      logger,
      nodeId: 'test-node',
      sessionId: 'test-session',
      config: { enabled: true },
      events: new EventEmitter(),
    };
  });

  it('has correct name and version', () => {
    plugin = new TaskEnginePlugin();
    expect(plugin.name).toBe('task-engine');
    expect(plugin.version).toBe('1.0.0');
  });

  it('registers MCP tools after init', async () => {
    plugin = new TaskEnginePlugin();
    await plugin.init(mockCtx);

    const tools = plugin.getTools();
    expect(tools).toBeDefined();

    const toolNames = Array.from(tools!.keys());
    expect(toolNames).toContain('submit_task');
    expect(toolNames).toContain('get_task_result');
    expect(toolNames).toContain('cancel_task');
    expect(toolNames).toContain('list_tasks');
    expect(toolNames).toContain('list_dead_letter_tasks');
    expect(toolNames).toContain('retry_dead_letter_task');
    expect(toolNames).toContain('drain_node_tasks');
  });

  it('submit_task creates a task and returns taskId', async () => {
    plugin = new TaskEnginePlugin();
    await plugin.init(mockCtx);

    const tools = plugin.getTools()!;
    const submitTool = tools.get('submit_task')!;

    const result = await submitTool.handler({
      type: 'shell',
      command: 'echo hello',
      priority: 5,
    });

    expect(result).toEqual(expect.objectContaining({
      accepted: true,
      taskId: expect.any(String),
    }));
  });

  it('get_task_result returns task state from SQLite', async () => {
    plugin = new TaskEnginePlugin();
    await plugin.init(mockCtx);

    const tools = plugin.getTools()!;
    const submitResult = await tools.get('submit_task')!.handler({ type: 'shell', command: 'ls' }) as any;
    const getResult = await tools.get('get_task_result')!.handler({ taskId: submitResult.taskId }) as any;

    expect(getResult.state).toBe('queued');
    expect(getResult.type).toBe('shell');
  });

  it('list_tasks returns paginated results', async () => {
    plugin = new TaskEnginePlugin();
    await plugin.init(mockCtx);

    const tools = plugin.getTools()!;
    for (let i = 0; i < 3; i++) {
      await tools.get('submit_task')!.handler({ type: 'shell', command: `echo ${i}` });
    }

    const result = await tools.get('list_tasks')!.handler({ limit: 2 }) as any;
    expect(result.tasks).toHaveLength(2);
    expect(result.total).toBe(3);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /home/paschal/cortex && npx vitest run tests/plugins/task-engine/index.test.ts`
Expected: FAIL — module not found

**Step 3: Implement the plugin**

Create `src/plugins/task-engine/index.ts`:

```typescript
import { randomUUID } from 'node:crypto';
import { Plugin, PluginContext, ToolHandler } from '../types.js';
import { TaskStateMachine } from './state-machine.js';
import { ResourceAwareScheduler } from './scheduler.js';
import { runMigrations } from './migrations.js';
import type { LogEntry } from '../../cluster/raft.js';
import type { NodeInfo } from '../../cluster/membership.js';
import { TaskSubmitPayload, TaskRecord } from './types.js';

export class TaskEnginePlugin implements Plugin {
  name = 'task-engine';
  version = '1.0.0';

  private ctx!: PluginContext;
  private stateMachine!: TaskStateMachine;
  private scheduler!: ResourceAwareScheduler;
  private tools = new Map<string, ToolHandler>();
  private schedulerInterval: NodeJS.Timeout | null = null;
  private entryHandler: ((entry: LogEntry) => void) | null = null;
  private offlineHandler: ((node: NodeInfo) => void) | null = null;

  async init(ctx: PluginContext): Promise<void> {
    this.ctx = ctx;

    // Run migrations on the shared-memory SQLite DB
    const rawDb = (ctx.sharedMemoryDb as any).db;
    runMigrations(rawDb);

    this.stateMachine = new TaskStateMachine(rawDb, ctx.nodeId, ctx.logger);
    this.scheduler = new ResourceAwareScheduler({
      raft: ctx.raft,
      membership: ctx.membership,
      logger: ctx.logger,
    });

    this.registerTools();

    // Listen for committed Raft entries
    this.entryHandler = (entry: LogEntry) => this.handleCommittedEntry(entry);
    ctx.raft.on('entryCommitted', this.entryHandler);

    // Listen for node failures (HA re-queue)
    this.offlineHandler = (node: NodeInfo) => this.handleNodeOffline(node);
    ctx.membership.on('nodeOffline', this.offlineHandler);
  }

  async start(): Promise<void> {
    // Start scheduling loop (leader only runs actual scheduling)
    this.schedulerInterval = setInterval(() => this.runSchedulingCycle(), 1000);
  }

  async stop(): Promise<void> {
    if (this.schedulerInterval) {
      clearInterval(this.schedulerInterval);
      this.schedulerInterval = null;
    }
    if (this.entryHandler) {
      this.ctx.raft.removeListener('entryCommitted', this.entryHandler);
    }
    if (this.offlineHandler) {
      this.ctx.membership.removeListener('nodeOffline', this.offlineHandler);
    }
  }

  getTools(): Map<string, ToolHandler> {
    return this.tools;
  }

  private handleCommittedEntry(entry: LogEntry): void {
    const taskTypes = [
      'task_submit', 'task_assign', 'task_started', 'task_complete',
      'task_failed', 'task_cancel', 'task_retry', 'task_dead_letter',
      'workflow_submit', 'workflow_advance',
    ];

    if (!taskTypes.includes(entry.type)) return;

    try {
      const payload = JSON.parse(entry.data.toString());
      const action = this.stateMachine.applyEntry(entry.type, payload);

      // Leader handles side effects from state machine actions
      if (action && this.ctx.raft.isLeader()) {
        this.handleAction(action);
      }
    } catch (err) {
      this.ctx.logger.error('Failed to apply task entry', { type: entry.type, error: err });
    }
  }

  private async handleAction(action: any): Promise<void> {
    switch (action.type) {
      case 'schedule':
        // Next scheduling cycle will pick it up
        break;
      case 'retry': {
        const data = Buffer.from(JSON.stringify({
          taskId: action.taskId,
          attempt: action.attempt,
          scheduledAfter: action.scheduledAfter,
        }));
        await this.ctx.raft.appendEntry('task_retry', data);
        break;
      }
      case 'dead_letter': {
        const data = Buffer.from(JSON.stringify({
          taskId: action.taskId,
          reason: action.reason,
        }));
        await this.ctx.raft.appendEntry('task_dead_letter', data);
        break;
      }
      case 'cancel_running': {
        // Send cancel to executing node via gRPC
        try {
          const { AgentClient } = await import('../../grpc/client.js');
          const client = new AgentClient(this.ctx.clientPool, action.nodeId);
          await client.cancelExecution(action.taskId);
        } catch (err) {
          this.ctx.logger.error('Failed to cancel running task', { taskId: action.taskId, error: err });
        }
        break;
      }
      case 'workflow_advance': {
        const data = Buffer.from(JSON.stringify({
          workflowId: action.workflowId,
          completedTaskKey: action.taskId,
        }));
        await this.ctx.raft.appendEntry('workflow_advance', data);
        break;
      }
    }
  }

  private async handleNodeOffline(node: NodeInfo): Promise<void> {
    if (!this.ctx.raft.isLeader()) return;

    const affectedTasks = this.stateMachine.getTasksOnNode(node.nodeId);
    for (const task of affectedTasks) {
      this.ctx.logger.warn('Re-queuing task from offline node', { taskId: task.id, nodeId: node.nodeId });
      const data = Buffer.from(JSON.stringify({
        taskId: task.id,
        error: `Node ${node.nodeId} went offline`,
        nodeId: node.nodeId,
      }));
      await this.ctx.raft.appendEntry('task_failed', data);
    }
  }

  private async runSchedulingCycle(): Promise<void> {
    if (!this.ctx.raft.isLeader()) return;

    const queued = this.stateMachine.getQueuedTasks();
    // Update running task counts for scoring
    const nodes = this.ctx.membership.getActiveNodes();
    for (const node of nodes) {
      const running = this.stateMachine.getTasksOnNode(node.nodeId);
      this.scheduler.setRunningTaskCount(node.nodeId, running.length);
    }

    for (const task of queued) {
      const node = this.scheduler.pickNode(task);
      if (!node) continue;

      const data = Buffer.from(JSON.stringify({ taskId: task.id, nodeId: node.nodeId }));
      const { success } = await this.ctx.raft.appendEntry('task_assign', data);
      if (success) {
        // Dispatch to the assigned node for execution
        this.dispatchToNode(task, node);
      }
    }
  }

  private async dispatchToNode(task: TaskRecord, node: NodeInfo): Promise<void> {
    try {
      const { AgentClient } = await import('../../grpc/client.js');
      const address = `${node.tailscaleIp}:${node.grpcPort}`;
      const client = new AgentClient(this.ctx.clientPool, address);

      // Report started
      const startedData = Buffer.from(JSON.stringify({ taskId: task.id, nodeId: node.nodeId }));
      await this.ctx.raft.appendEntry('task_started', startedData);

      const spec = JSON.parse(task.spec);
      const protoSpec: any = {
        task_id: task.id,
        type: `TASK_TYPE_${task.type.toUpperCase()}`,
        submitter_node: this.ctx.nodeId,
      };

      // Map spec fields based on type
      if (task.type === 'shell') protoSpec.shell = { command: spec.command, working_directory: spec.workingDirectory };
      if (task.type === 'container') protoSpec.container = spec;
      if (task.type === 'subagent') protoSpec.subagent = spec;

      const stream = client.executeTask({ spec: protoSpec });

      let stdout: Buffer[] = [];
      let stderr: Buffer[] = [];

      for await (const response of stream as AsyncIterable<any>) {
        if (response.output) {
          if (response.output.type === 'OUTPUT_TYPE_STDOUT') stdout.push(response.output.data);
          if (response.output.type === 'OUTPUT_TYPE_STDERR') stderr.push(response.output.data);
        }
        if (response.status) {
          const result = {
            exitCode: response.status.exit_code ?? response.status.exitCode ?? -1,
            stdout: Buffer.concat(stdout).toString(),
            stderr: Buffer.concat(stderr).toString(),
          };

          const entryType = result.exitCode === 0 ? 'task_complete' : 'task_failed';
          const payload = entryType === 'task_complete'
            ? { taskId: task.id, result }
            : { taskId: task.id, error: result.stderr || `Exit code ${result.exitCode}`, nodeId: node.nodeId };

          await this.ctx.raft.appendEntry(entryType, Buffer.from(JSON.stringify(payload)));
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.ctx.logger.error('Task dispatch failed', { taskId: task.id, error: errorMsg });
      await this.ctx.raft.appendEntry('task_failed', Buffer.from(JSON.stringify({
        taskId: task.id, error: errorMsg, nodeId: node.nodeId,
      })));
    }
  }

  private registerTools(): void {
    this.tools.set('submit_task', {
      description: 'Submit a task for distributed execution. Tasks are persisted and scheduled across cluster nodes.',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['shell', 'container', 'subagent', 'k8s_job', 'claude_relay'], description: 'Task type' },
          command: { type: 'string', description: 'For shell tasks: the command to run' },
          image: { type: 'string', description: 'For container tasks: Docker image' },
          prompt: { type: 'string', description: 'For subagent tasks: the prompt' },
          priority: { type: 'number', description: 'Priority 0-10 (higher = more urgent)' },
          requiresGpu: { type: 'boolean', description: 'Requires GPU' },
          avoidGamingNodes: { type: 'boolean', description: 'Avoid nodes with active gaming' },
          targetNode: { type: 'string', description: 'Pin to specific node' },
          workingDirectory: { type: 'string', description: 'Working directory for shell tasks' },
          retryable: { type: 'boolean', description: 'Whether to retry on failure (default: true)' },
          maxRetries: { type: 'number', description: 'Max retry attempts (default: 3)' },
        },
        required: ['type'],
      },
      handler: async (args) => {
        const taskId = randomUUID();
        const type = args.type as string;

        const spec: Record<string, unknown> = {};
        if (type === 'shell') spec.command = args.command;
        if (type === 'container') spec.image = args.image;
        if (type === 'subagent') spec.prompt = args.prompt;
        if (args.workingDirectory) spec.workingDirectory = args.workingDirectory;

        const constraints: Record<string, unknown> = {};
        if (args.requiresGpu) constraints.requiresGpu = true;
        if (args.avoidGamingNodes) constraints.avoidGaming = true;
        if (args.targetNode) constraints.targetNode = args.targetNode;

        const retryPolicy = {
          maxRetries: (args.maxRetries as number) ?? 3,
          backoffMs: 1000,
          backoffMultiplier: 2,
          retryable: args.retryable !== false,
        };

        const payload: TaskSubmitPayload = {
          taskId,
          type: type as any,
          spec,
          priority: (args.priority as number) ?? 0,
          constraints: Object.keys(constraints).length > 0 ? constraints as any : undefined,
          retryPolicy,
          submitterNode: this.ctx.nodeId,
        };

        if (this.ctx.raft.isLeader()) {
          const data = Buffer.from(JSON.stringify(payload));
          const { success } = await this.ctx.raft.appendEntry('task_submit', data);
          if (!success) return { accepted: false, taskId, reason: 'Failed to replicate' };
          return { accepted: true, taskId };
        } else {
          // For non-leader, apply locally for immediate feedback
          // In production, this would forward to the leader via gRPC
          this.stateMachine.applyEntry('task_submit', payload);
          return { accepted: true, taskId };
        }
      },
    });

    this.tools.set('get_task_result', {
      description: 'Get the status and result of a task. Results are persistent (survive restarts).',
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'The task ID' },
        },
        required: ['taskId'],
      },
      handler: async (args) => {
        const task = this.stateMachine.getTask(args.taskId as string);
        if (!task) return { error: 'Task not found' };

        return {
          taskId: task.id,
          type: task.type,
          state: task.state,
          priority: task.priority,
          assignedNode: task.assigned_node,
          attempt: task.attempt,
          result: task.result ? JSON.parse(task.result) : null,
          error: task.error,
          createdAt: task.created_at,
          startedAt: task.started_at,
          completedAt: task.completed_at,
          events: this.stateMachine.getTaskEvents(task.id),
        };
      },
    });

    this.tools.set('list_tasks', {
      description: 'List tasks with optional filters. Returns paginated results.',
      inputSchema: {
        type: 'object',
        properties: {
          state: { type: 'string', description: 'Filter by state' },
          workflowId: { type: 'string', description: 'Filter by workflow' },
          nodeId: { type: 'string', description: 'Filter by assigned node' },
          limit: { type: 'number', description: 'Max results (default 50)' },
          offset: { type: 'number', description: 'Offset for pagination' },
        },
      },
      handler: async (args) => {
        const rawDb = (this.ctx.sharedMemoryDb as any).db;
        const countSql = 'SELECT count(*) as total FROM te_tasks';
        const total = (rawDb.prepare(countSql).get() as any).total;

        const tasks = this.stateMachine.listTasks({
          state: args.state as string | undefined,
          workflowId: args.workflowId as string | undefined,
          nodeId: args.nodeId as string | undefined,
          limit: args.limit as number | undefined,
          offset: args.offset as number | undefined,
        });

        return { tasks, total };
      },
    });

    this.tools.set('cancel_task', {
      description: 'Cancel a running or queued task.',
      inputSchema: {
        type: 'object',
        properties: { taskId: { type: 'string', description: 'Task to cancel' } },
        required: ['taskId'],
      },
      handler: async (args) => {
        const data = Buffer.from(JSON.stringify({ taskId: args.taskId }));
        const { success } = await this.ctx.raft.appendEntry('task_cancel', data);
        return { cancelled: success };
      },
    });

    this.tools.set('list_dead_letter_tasks', {
      description: 'List tasks that failed after exhausting all retries.',
      inputSchema: {
        type: 'object',
        properties: { limit: { type: 'number', description: 'Max results (default 50)' } },
      },
      handler: async (args) => {
        return { tasks: this.stateMachine.getDeadLetterTasks((args.limit as number) ?? 50) };
      },
    });

    this.tools.set('retry_dead_letter_task', {
      description: 'Manually retry a dead-lettered task (resets attempt counter).',
      inputSchema: {
        type: 'object',
        properties: { taskId: { type: 'string', description: 'Dead-lettered task to retry' } },
        required: ['taskId'],
      },
      handler: async (args) => {
        const task = this.stateMachine.getTask(args.taskId as string);
        if (!task || task.state !== 'dead_letter') return { error: 'Task not found or not dead-lettered' };

        const data = Buffer.from(JSON.stringify({
          taskId: task.id,
          attempt: 0,
          scheduledAfter: null,
        }));
        const { success } = await this.ctx.raft.appendEntry('task_retry', data);
        return { retried: success };
      },
    });

    this.tools.set('drain_node_tasks', {
      description: 'Gracefully migrate all tasks off a node (for maintenance).',
      inputSchema: {
        type: 'object',
        properties: { nodeId: { type: 'string', description: 'Node to drain' } },
        required: ['nodeId'],
      },
      handler: async (args) => {
        const tasks = this.stateMachine.getTasksOnNode(args.nodeId as string);
        let migrated = 0;
        for (const task of tasks) {
          // Re-queue without incrementing attempt (graceful migration)
          const data = Buffer.from(JSON.stringify({
            taskId: task.id,
            attempt: task.attempt, // Keep same attempt count
            scheduledAfter: null,
          }));
          const { success } = await this.ctx.raft.appendEntry('task_retry', data);
          if (success) migrated++;
        }
        return { migrated, total: tasks.length };
      },
    });

    // Keep run_distributed and dispatch_subagents as convenience wrappers
    this.tools.set('run_distributed', {
      description: 'Run a shell command on multiple nodes in parallel.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command to run' },
          nodes: { type: 'array', items: { type: 'string' }, description: 'Node IDs (empty for all)' },
        },
        required: ['command'],
      },
      handler: async (args) => {
        const targetNodes = (args.nodes as string[]) ?? this.ctx.membership.getActiveNodes().map((n: any) => n.nodeId);
        const taskIds: string[] = [];

        for (const nodeId of targetNodes) {
          const taskId = randomUUID();
          const payload: TaskSubmitPayload = {
            taskId,
            type: 'shell',
            spec: { command: args.command },
            constraints: { targetNode: nodeId },
            submitterNode: this.ctx.nodeId,
          };
          const data = Buffer.from(JSON.stringify(payload));
          await this.ctx.raft.appendEntry('task_submit', data);
          taskIds.push(taskId);
        }

        return { taskIds, count: taskIds.length };
      },
    });

    this.tools.set('dispatch_subagents', {
      description: 'Launch Claude subagents on multiple nodes in parallel.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Prompt for each subagent' },
          count: { type: 'number', description: 'Number of subagents' },
          contextSummary: { type: 'string', description: 'Shared context' },
        },
        required: ['prompt', 'count'],
      },
      handler: async (args) => {
        const count = args.count as number;
        const taskIds: string[] = [];

        for (let i = 0; i < count; i++) {
          const taskId = randomUUID();
          const payload: TaskSubmitPayload = {
            taskId,
            type: 'subagent',
            spec: {
              prompt: `Agent ${i + 1}/${count}: ${args.prompt}`,
              contextSummary: args.contextSummary,
            },
            submitterNode: this.ctx.nodeId,
          };
          const data = Buffer.from(JSON.stringify(payload));
          await this.ctx.raft.appendEntry('task_submit', data);
          taskIds.push(taskId);
        }

        return { launched: count, taskIds };
      },
    });
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd /home/paschal/cortex && npx vitest run tests/plugins/task-engine/index.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/plugins/task-engine/index.ts tests/plugins/task-engine/index.test.ts
git commit -m "feat(task-engine): plugin with 9 MCP tools, Raft integration, and HA re-queue"
```

---

### Task 8: Register Plugin + Config + Cutover

**Files:**
- Modify: `src/plugins/registry.ts:5-13` (add task-engine entry)
- Modify: `config/default.yaml:187-206` (add task-engine config)
- Modify: `src/plugins/cluster-tools/index.ts` (remove old task tools)
- Test: `tests/plugins/registry.test.ts` (verify registration)

**Step 1: Register the plugin**

In `src/plugins/registry.ts`, add:

```typescript
'task-engine':      () => import('./task-engine/index.js').then(m => new m.TaskEnginePlugin()),
```

**Step 2: Add config**

In `config/default.yaml`, add under `plugins:`:

```yaml
  task-engine:
    enabled: true
```

**Step 3: Remove overlapping tools from cluster-tools**

In `src/plugins/cluster-tools/index.ts`, filter out the task tools that are now in task-engine: `submit_task`, `get_task_result`, `run_distributed`, `dispatch_subagents`. The cluster-tools plugin keeps only cluster management tools (list_nodes, cluster_status, list_sessions, relay_to_session, etc.).

**Step 4: Build and test**

Run: `cd /home/paschal/cortex && npm run build && npx vitest run`
Expected: Clean build, all tests pass (existing + new)

**Step 5: Commit**

```bash
git add src/plugins/registry.ts src/plugins/cluster-tools/index.ts config/default.yaml
git commit -m "feat(task-engine): register plugin, add config, remove old task tools from cluster-tools"
```

---

## Phase 2: Workflow Engine (Tasks 9–11)

### Task 9: Workflow State Machine

**Files:**
- Create: `src/plugins/task-engine/workflow-engine.ts`
- Modify: `src/plugins/task-engine/state-machine.ts` (implement workflow_submit / workflow_advance)
- Test: `tests/plugins/task-engine/workflow-engine.test.ts`

Implement `applyWorkflowSubmit` and `applyWorkflowAdvance` in the state machine. WorkflowEngine uses `evaluateCondition()` for DAG branching. Tests cover: linear chain (A→B→C), fan-out (A→[B,C]), fan-in ([B,C]→D), conditional branching, and workflow completion detection.

**Step 1: Write failing tests for workflow submission and DAG evaluation**

**Step 2: Implement WorkflowEngine class**

**Step 3: Wire into state machine's applyWorkflowSubmit and applyWorkflowAdvance**

**Step 4: Run all tests**

**Step 5: Commit**

---

### Task 10: Workflow MCP Tools

**Files:**
- Modify: `src/plugins/task-engine/index.ts` (add workflow tools)
- Test: `tests/plugins/task-engine/workflow-tools.test.ts`

Add `submit_workflow`, `list_workflows`, `get_workflow_status` tools. Tests cover: submit a workflow, verify per-task status, verify completed workflow state.

**Step 1: Write failing tests**

**Step 2: Implement tools in registerTools()**

**Step 3: Run tests**

**Step 4: Commit**

---

### Task 11: Workflow Integration Test

**Files:**
- Test: `tests/plugins/task-engine/workflow-integration.test.ts`

End-to-end test: submit a 4-task DAG (lint + test → build → deploy with condition). Simulate Raft entry commits. Verify tasks execute in correct order, conditions evaluated, workflow completes.

**Step 1: Write integration test**

**Step 2: Run test**

**Step 3: Commit**

---

## Phase 3: HA & Re-queuing (Tasks 12–14)

### Task 12: Failure Detection Integration

**Files:**
- Modify: `src/plugins/task-engine/index.ts` (handleNodeOffline already exists — add tests)
- Test: `tests/plugins/task-engine/ha.test.ts`

Tests: simulate node going offline with 2 running tasks. Verify both tasks get TASK_FAILED entries appended. Verify retry policy triggers TASK_RETRY for retryable tasks and TASK_DEAD_LETTER for non-retryable.

---

### Task 13: Graceful Drain Enhancement

**Files:**
- Modify: `src/plugins/task-engine/index.ts` (drain_node_tasks tool already exists — add integration test)
- Test: `tests/plugins/task-engine/drain.test.ts`

Tests: submit 3 tasks targeted at node-A. Drain node-A. Verify all tasks re-queued with same attempt count. Verify they get rescheduled to different nodes.

---

### Task 14: Dead Letter Queue Tests

**Files:**
- Test: `tests/plugins/task-engine/dead-letter.test.ts`

Tests: submit a task with maxRetries=2. Fail it 3 times. Verify dead-lettered. Use retry_dead_letter_task. Verify task back in queue with attempt=0.

---

## Phase 4: Cutover & Polish (Tasks 15–17)

### Task 15: Remove Old TaskScheduler

**Files:**
- Modify: `src/cluster/scheduler.ts` (deprecate, add comment pointing to task-engine plugin)
- Modify: `src/index.ts` (stop initializing TaskScheduler if task-engine plugin is enabled)
- Modify: `src/plugins/types.ts` (make scheduler optional in PluginContext)

Keep old scheduler code for backward compat but skip its initialization when the new plugin is enabled. Don't delete — mark deprecated.

---

### Task 16: Deploy to Cluster

Deploy the new build to all 6 nodes using the existing ISSU rolling update:

```bash
cd /home/paschal/cortex
npm run build
# Use the initiate_rolling_update MCP tool or:
npm run deploy
```

Verify on each node:
- `list_tasks` tool returns results from SQLite
- `submit_task` creates persistent tasks
- Tasks survive a leader restart

---

### Task 17: Update Documentation

**Files:**
- Modify: `README.md` (update tool listing, add task-engine section)
- Modify: `ROADMAP.md` (mark Distributed Task Execution as complete)
- Modify: `CONTRIBUTING.md` (add task-engine plugin to directory listing)

---

## Summary

| Phase | Tasks | Key Tests |
|-------|-------|-----------|
| 1: Persistence + Scheduler | 1–8 | State machine transitions, scheduler scoring, MCP tools CRUD |
| 2: Workflow Engine | 9–11 | DAG evaluation, condition sandbox, end-to-end workflow |
| 3: HA & Re-queuing | 12–14 | Node failure re-queue, graceful drain, dead letter lifecycle |
| 4: Cutover & Polish | 15–17 | Old scheduler disabled, cluster deploy, docs updated |

Total: 17 tasks across 4 phases.
