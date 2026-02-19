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
  spec: string;
  constraints: string | null;
  retry_policy: string | null;
  assigned_node: string | null;
  attempt: number;
  result: string | null;
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
  definition: string;
  context: string;
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
  detail: string | null;
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
  condition?: string;
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
  scheduledAfter: string;
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
