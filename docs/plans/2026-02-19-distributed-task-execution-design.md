# Distributed Task Execution — Design Document

**Date:** 2026-02-19
**Thread:** #22 (Cortex)
**Status:** Approved
**Depends on:** Plugin Architecture (COMPLETE)

## Overview

Full distributed task execution system for Cortex. Tasks are first-class Raft log entries, persisted in shared-memory SQLite, scheduled with resource-aware placement, re-queued on node failure, and orchestrated as DAG workflows with JS-evaluated conditionals.

## Architecture Decision

**Approach: Raft State Machine.** Every task lifecycle event (submit, assign, complete, fail, retry, cancel) is a Raft log entry. All nodes apply the same log deterministically, so every node has identical task state in local SQLite. The scheduler runs only on the leader. Task output flows through gRPC streams, not Raft.

Alternatives considered:
- Leader-centric with replicated snapshots — rejected (breaks Raft pattern, snapshot lag)
- Shared-memory tables only — rejected (no structured state machine, poll-heavy)

## Section 1: Data Model

### `tasks` table

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | UUID, generated at submit |
| `workflow_id` | TEXT | FK to `workflows.id`, NULL for standalone |
| `type` | TEXT | `shell`, `container`, `subagent`, `k8s_job`, `claude_relay` |
| `state` | TEXT | `queued`, `assigned`, `running`, `completed`, `failed`, `cancelled`, `dead_letter` |
| `priority` | INT | 0-10, higher = more urgent |
| `spec` | TEXT (JSON) | Full task specification |
| `constraints` | TEXT (JSON) | Placement constraints |
| `retry_policy` | TEXT (JSON) | Retry behavior |
| `assigned_node` | TEXT | Node currently running this task |
| `attempt` | INT | Current attempt number (0-indexed) |
| `result` | TEXT (JSON) | `{exitCode, stdout, stderr}` on completion |
| `error` | TEXT | Error message on failure |
| `scheduled_after` | TEXT | Backoff: don't schedule before this time |
| `created_at` | TEXT | ISO timestamp |
| `assigned_at` | TEXT | When assigned |
| `started_at` | TEXT | When execution began |
| `completed_at` | TEXT | When completed/failed |
| `dead_lettered_at` | TEXT | When moved to dead letter |

### `workflows` table

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | UUID |
| `name` | TEXT | Human-readable name |
| `state` | TEXT | `pending`, `running`, `completed`, `failed`, `cancelled` |
| `definition` | TEXT (JSON) | Full DAG definition |
| `context` | TEXT (JSON) | Shared workflow context |
| `created_at` | TEXT | |
| `completed_at` | TEXT | |

### `task_dependencies` table

| Column | Type | Description |
|--------|------|-------------|
| `workflow_id` | TEXT | FK |
| `task_key` | TEXT | Logical name within workflow |
| `depends_on_key` | TEXT | Dependency task key |
| `condition` | TEXT | JS expression or NULL (= on success) |

### `task_events` table (audit log)

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-increment |
| `task_id` | TEXT | FK |
| `event_type` | TEXT | `submitted`, `assigned`, `started`, `completed`, `failed`, `retried`, `cancelled`, `dead_lettered` |
| `node_id` | TEXT | Which node generated the event |
| `detail` | TEXT (JSON) | Event-specific data |
| `created_at` | TEXT | |

## Section 2: Raft State Machine

### New Log Entry Types

```
LOG_ENTRY_TYPE_TASK_SUBMIT      = 3   (existing)
LOG_ENTRY_TYPE_TASK_COMPLETE     = 4   (existing)
LOG_ENTRY_TYPE_TASK_ASSIGN       = 10  (new)
LOG_ENTRY_TYPE_TASK_STARTED      = 11  (new)
LOG_ENTRY_TYPE_TASK_FAILED       = 12  (new)
LOG_ENTRY_TYPE_TASK_CANCEL       = 13  (new)
LOG_ENTRY_TYPE_TASK_RETRY        = 14  (new)
LOG_ENTRY_TYPE_TASK_DEAD_LETTER  = 15  (new)
LOG_ENTRY_TYPE_WORKFLOW_SUBMIT   = 16  (new)
LOG_ENTRY_TYPE_WORKFLOW_ADVANCE  = 17  (new)
```

### Apply Logic

**TASK_SUBMIT:** INSERT into tasks (state=queued), INSERT event. If standalone: trigger scheduling.

**TASK_ASSIGN:** UPDATE tasks (state=assigned, assigned_node, assigned_at), INSERT event.

**TASK_STARTED:** UPDATE tasks (state=running, started_at), INSERT event.

**TASK_COMPLETE:** UPDATE tasks (state=completed, result, completed_at), INSERT event. If part of workflow: append WORKFLOW_ADVANCE.

**TASK_FAILED:** Check retry_policy (attempts < maxRetries). YES: append TASK_RETRY. NO: state=dead_letter. INSERT event.

**TASK_RETRY:** UPDATE tasks (state=queued, attempt++, assigned_node=NULL). Compute backoff: `scheduled_after = now + backoffMs * (backoffMultiplier ^ attempt)`. INSERT event. Trigger scheduling.

**TASK_CANCEL:** UPDATE tasks (state=cancelled). If running: send CancelExecution gRPC to assigned node. INSERT event.

**WORKFLOW_SUBMIT:** INSERT workflow. INSERT all tasks (roots=queued, dependents=pending). INSERT dependencies. Trigger scheduling for roots.

**WORKFLOW_ADVANCE:** Evaluate dependent tasks. For each with all deps met: evaluate JS condition. Truthy/NULL → queued. Falsy → skipped. If all tasks terminal: update workflow state.

### Principle

Only the leader appends log entries. Followers apply identically. Scheduler runs only on leader.

## Section 3: Scheduler — Resource-Aware Placement

### Resource Model

```typescript
interface NodeResources {
  cpu: { cores: number; usagePercent: number; loadAvg1m: number };
  memory: { totalMb: number; availableMb: number; usagePercent: number };
  gpu: { available: boolean; name: string; memoryMb: number; usagePercent: number } | null;
  disk: { totalGb: number; availableGb: number; usagePercent: number; ioUtilPercent: number };
  network: { bandwidthMbps: number; currentThroughputMbps: number };
  labels: string[];
}
```

### Scheduling Algorithm

Runs on leader at configurable interval (default 1s).

For each queued task (sorted by priority DESC, created_at ASC):

1. **Filter** — eliminate nodes that don't meet constraints:
   - `requiresGpu` → gpu.available required
   - `avoidGaming` → skip nodes with 'gaming' label
   - `minMemoryMb` → memory.availableMb >= threshold
   - `minDiskGb` → disk.availableGb >= threshold
   - `nodeLabels` → intersection match
   - `targetNode` → pin to specific node (bypass scoring)

2. **Score** — rank candidates:
   - CPU headroom: `(100 - cpu.usagePercent) * 0.3`
   - Memory headroom: `(memory.availableMb / memory.totalMb * 100) * 0.3`
   - Disk I/O headroom: `(100 - disk.ioUtilPercent) * 0.15`
   - Network headroom: `((bandwidthMbps - currentThroughputMbps) / bandwidthMbps * 100) * 0.1`
   - GPU headroom (if needed): `(100 - gpu.usagePercent) * 0.15`
   - Task count penalty: `-5 per running task on node`

3. **Assign** — highest-scoring node. Append TASK_ASSIGN to Raft log.

4. **Backoff-aware** — skip tasks with `scheduled_after > now`.

### Node Health Gate

Nodes must be `status: 'active'` in membership. Offline/draining excluded.

## Section 4: Task HA — Failure Detection & Re-queuing

### Detection

`MembershipManager.detectFailures()` on leader marks nodes offline (15s timeout). On node offline:

1. Query tasks with `state IN ('assigned', 'running') AND assigned_node = deadNodeId`
2. For each: if `retry_policy.retryable` → TASK_RETRY. Else → TASK_FAILED.

### Re-queue Backoff

```
backoffMs = retry_policy.backoffMs * (retry_policy.backoffMultiplier ^ task.attempt)
scheduled_after = now + backoffMs
```

Default: 1s → 2s → 4s (3 retries, multiplier 2).

### Dead Letter Queue

After maxRetries: state=dead_letter, timestamp set, event logged. Exposed via `list_dead_letter_tasks` and `retry_dead_letter_task` MCP tools.

### Graceful Draining

On intentional node drain: re-queue tasks WITHOUT incrementing attempt. Wait for running tasks to complete (with timeout), then shut down.

### Output Recovery

Partial output lost on node death. Re-queued task starts fresh. Future enhancement: task checkpointing via shared-memory.

## Section 5: DAG Workflow Engine

### Workflow Definition Format

```json
{
  "name": "build-and-deploy",
  "tasks": {
    "lint": {
      "type": "shell",
      "spec": { "command": "npm run lint" },
      "constraints": { "nodeLabels": ["server"] }
    },
    "test": {
      "type": "shell",
      "spec": { "command": "npm test" },
      "constraints": { "minMemoryMb": 2048 }
    },
    "build": {
      "type": "shell",
      "spec": { "command": "npm run build" },
      "dependsOn": ["lint", "test"]
    },
    "deploy": {
      "type": "shell",
      "spec": { "command": "npm run deploy" },
      "dependsOn": ["build"],
      "condition": "parent.build.exitCode === 0 && parent.test.result.stdout.includes('0 failures')"
    },
    "notify-failure": {
      "type": "subagent",
      "spec": { "prompt": "Send a failure notification" },
      "dependsOn": ["build"],
      "condition": "parent.build.exitCode !== 0"
    }
  }
}
```

### DAG Evaluation

On WORKFLOW_ADVANCE, for each pending task:
1. All dependencies completed/skipped?
2. Evaluate condition in sandboxed `vm.runInNewContext()`:
   - Context: `{ parent: { taskKey: { exitCode, stdout, stderr, state } }, workflow: { context } }`
   - Timeout: 100ms
   - No globals, no require, no process
3. Truthy/NULL → queued. Falsy → skipped.
4. All tasks terminal → workflow complete/failed.

### Fan-out / Fan-in

- Fan-out: multiple tasks with same parent → parallel
- Fan-in: one task with multiple dependencies → waits for all

### Workflow Context

`workflows.context` JSON accumulates across steps. Tasks read via condition expressions (`workflow.context`). Tasks write via `context_update` in result.

## Section 6: MCP Tools

| Tool | Status | Description |
|------|--------|-------------|
| `submit_task` | Enhanced | Add constraints, retry_policy, priority |
| `submit_workflow` | New | Submit DAG workflow |
| `get_task_result` | Enhanced | Persistent (SQLite), includes attempt history |
| `cancel_task` | New | Cancel running/queued task |
| `list_tasks` | New | Query by state, type, workflow, node. Pagination. |
| `list_workflows` | New | Query workflows by state |
| `get_workflow_status` | New | Full DAG with per-task states |
| `list_dead_letter_tasks` | New | Inspect exhausted-retry tasks |
| `retry_dead_letter_task` | New | Manual re-queue from dead letter |
| `drain_node_tasks` | New | Graceful task migration off node |
| `stream_task_output` | New | SSE stream of live output |

### gRPC Extensions

```proto
message TaskConstraints {
  bool requires_gpu = 1;
  bool avoid_gaming = 2;
  int64 min_memory_mb = 3;
  int64 min_disk_gb = 4;
  repeated string node_labels = 5;
  string target_node = 6;
}

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
  string id = 1;
  string name = 2;
  string state = 3;
  map<string, TaskStatus> task_statuses = 4;
  string context_json = 5;
}
```

## Section 7: Plugin Structure

```
src/plugins/task-engine/
  index.ts           — Plugin class, registers tools
  state-machine.ts   — TaskStateMachine, applies Raft log entries to SQLite
  scheduler.ts       — ResourceAwareScheduler, scoring algorithm
  workflow-engine.ts  — WorkflowEngine, DAG evaluation + condition sandbox
  condition-eval.ts  — Sandboxed JS condition evaluator (vm module)
  types.ts           — Task/Workflow TypeScript interfaces
  migrations.ts      — SQLite table creation
```

Replaces existing TaskScheduler and task tools in cluster-tools plugin.

## Section 8: Implementation Phases

| Phase | Scope | Deliverables |
|-------|-------|-------------|
| 1 | Persistence + Enhanced Scheduler | SQLite tables, Raft log entries (submit/assign/complete/fail), resource-aware scoring, persistent get_task_result, list_tasks, cancel_task |
| 2 | Workflow Engine | DAG definition, submit_workflow, condition evaluator sandbox, WORKFLOW_ADVANCE, get_workflow_status, fan-out/fan-in |
| 3 | HA & Re-queuing | Failure detection hook, retry with backoff, dead letter queue, drain_node_tasks, graceful drain |
| 4 | Cutover & Polish | Replace old tools, deprecate old scheduler, stream_task_output, audit log queries, docs |

## Section 9: Testing Strategy

- Unit: state machine transitions (deterministic: given Raft log → assert SQLite state)
- Unit: scheduler scoring (mock resources → assert placement)
- Unit: condition evaluator (sandbox security, timeout, expressions)
- Integration: workflow DAG execution (submit → verify ordering)
- Integration: HA re-queue (simulate node failure → verify re-queue)
