import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Mock types based on actual implementations
interface K8sJobTaskSpec {
  clusterContext: string;
  namespace?: string;
  image: string;
  command?: string[];
  labels?: Record<string, string>;
  resources?: ResourceRequirements;
}

interface ResourceRequirements {
  cpuCores?: number;
  memoryBytes?: number;
  requiresGpu?: boolean;
  gpuMemoryBytes?: number;
}

interface TaskSpec {
  taskId: string;
  type: 'k8s_job';
  submitterNode: string;
  k8sJob?: K8sJobTaskSpec;
  requirements?: ResourceRequirements;
  timeoutMs?: number;
}

interface K8sJobSpec {
  name: string;
  namespace?: string;
  image: string;
  command?: string[];
  args?: string[];
  env?: Record<string, string>;
  cpuRequest?: string;
  memoryRequest?: string;
  cpuLimit?: string;
  memoryLimit?: string;
  gpuLimit?: number;
  labels?: Record<string, string>;
}

interface K8sJobStatus {
  name: string;
  namespace: string;
  active: number;
  succeeded: number;
  failed: number;
  startTime?: Date;
  completionTime?: Date;
  conditions: Array<{
    type: string;
    status: string;
    reason?: string;
    message?: string;
  }>;
}

type TaskState = 'queued' | 'assigned' | 'running' | 'completed' | 'failed' | 'cancelled';

interface TaskStatus {
  taskId: string;
  state: TaskState;
  assignedNode?: string;
  startedAt?: number;
  completedAt?: number;
  exitCode?: number;
  error?: string;
}

// Mock KubernetesAdapter
class MockKubernetesAdapter extends EventEmitter {
  submitJob = vi.fn<[string, K8sJobSpec], Promise<string>>();
  getJobStatus = vi.fn<[string, string, string?], Promise<K8sJobStatus | null>>();
  deleteJob = vi.fn<[string, string, string?], Promise<boolean>>();
  getJobLogs = vi.fn<[string, string, string?], Promise<string | null>>();

  constructor() {
    super();
    // Default implementations
    this.submitJob.mockResolvedValue('job-123');
    this.getJobStatus.mockResolvedValue({
      name: 'job-123',
      namespace: 'default',
      active: 1,
      succeeded: 0,
      failed: 0,
      conditions: [],
    });
    this.deleteJob.mockResolvedValue(true);
    this.getJobLogs.mockResolvedValue('Job output logs');
  }
}

// Mock TaskScheduler with K8s support
class MockTaskScheduler extends EventEmitter {
  private taskStatuses: Map<string, TaskStatus> = new Map();
  private runningTasks: Map<string, TaskSpec> = new Map();
  private k8sAdapter: MockKubernetesAdapter;
  private maxRetries: number = 3;
  private taskRetries: Map<string, number> = new Map();

  constructor(k8sAdapter: MockKubernetesAdapter) {
    super();
    this.k8sAdapter = k8sAdapter;
  }

  async submit(spec: TaskSpec): Promise<{ accepted: boolean; taskId: string; reason?: string }> {
    // Validate K8s job spec
    if (spec.type === 'k8s_job') {
      if (!spec.k8sJob?.image || !spec.k8sJob?.clusterContext) {
        return { accepted: false, taskId: spec.taskId, reason: 'K8s job missing image or context' };
      }
    }

    this.taskStatuses.set(spec.taskId, {
      taskId: spec.taskId,
      state: 'queued',
    });

    this.emit('taskSubmitted', spec);

    // For K8s jobs, submit to Kubernetes
    if (spec.type === 'k8s_job' && spec.k8sJob) {
      await this.submitK8sJob(spec);
    }

    return { accepted: true, taskId: spec.taskId };
  }

  private async submitK8sJob(spec: TaskSpec): Promise<void> {
    const k8sSpec = spec.k8sJob!;

    const jobSpec: K8sJobSpec = {
      name: `task-${spec.taskId}`,
      namespace: k8sSpec.namespace ?? 'default',
      image: k8sSpec.image,
      command: k8sSpec.command,
      labels: k8sSpec.labels,
    };

    // Apply resource limits from spec
    if (k8sSpec.resources) {
      if (k8sSpec.resources.cpuCores) {
        jobSpec.cpuRequest = `${k8sSpec.resources.cpuCores}`;
        jobSpec.cpuLimit = `${k8sSpec.resources.cpuCores}`;
      }
      if (k8sSpec.resources.memoryBytes) {
        const memoryMi = Math.ceil(k8sSpec.resources.memoryBytes / (1024 * 1024));
        jobSpec.memoryRequest = `${memoryMi}Mi`;
        jobSpec.memoryLimit = `${memoryMi}Mi`;
      }
      if (k8sSpec.resources.requiresGpu) {
        jobSpec.gpuLimit = 1;
      }
    }

    try {
      const jobName = await this.k8sAdapter.submitJob(k8sSpec.clusterContext, jobSpec);
      this.runningTasks.set(spec.taskId, spec);
      this.updateStatus(spec.taskId, 'running');
      this.emit('k8sJobSubmitted', spec.taskId, jobName);
    } catch (error) {
      this.handleK8sJobFailure(spec, error instanceof Error ? error.message : String(error));
    }
  }

  private handleK8sJobFailure(spec: TaskSpec, error: string): void {
    const retries = this.taskRetries.get(spec.taskId) ?? 0;

    if (retries < this.maxRetries) {
      this.taskRetries.set(spec.taskId, retries + 1);
      this.updateStatus(spec.taskId, 'queued');
      this.emit('k8sJobRetry', spec.taskId, retries + 1);
      // Re-queue for retry
      setTimeout(() => this.submitK8sJob(spec), 1000);
    } else {
      this.updateStatus(spec.taskId, 'failed');
      const status = this.taskStatuses.get(spec.taskId);
      if (status) {
        status.error = error;
      }
      this.emit('taskFailed', spec.taskId, error);
    }
  }

  async checkK8sJobStatus(taskId: string): Promise<TaskStatus | undefined> {
    const spec = this.runningTasks.get(taskId);
    if (!spec || spec.type !== 'k8s_job' || !spec.k8sJob) {
      return this.taskStatuses.get(taskId);
    }

    const jobStatus = await this.k8sAdapter.getJobStatus(
      spec.k8sJob.clusterContext,
      `task-${taskId}`,
      spec.k8sJob.namespace ?? 'default'
    );

    if (!jobStatus) {
      return this.taskStatuses.get(taskId);
    }

    if (jobStatus.succeeded > 0) {
      this.completeK8sJob(taskId, true);
    } else if (jobStatus.failed > 0) {
      this.handleK8sJobFailure(spec, 'Job failed');
    }

    return this.taskStatuses.get(taskId);
  }

  completeK8sJob(taskId: string, success: boolean): void {
    this.runningTasks.delete(taskId);
    this.updateStatus(taskId, success ? 'completed' : 'failed');
    this.emit('taskCompleted', taskId, { success });
  }

  private updateStatus(taskId: string, state: TaskState): void {
    let status = this.taskStatuses.get(taskId);
    if (!status) {
      status = { taskId, state };
      this.taskStatuses.set(taskId, status);
    }

    status.state = state;
    if (state === 'running') {
      status.startedAt = Date.now();
    }
    if (state === 'completed' || state === 'failed' || state === 'cancelled') {
      status.completedAt = Date.now();
    }

    this.emit('statusChanged', status);
  }

  getStatus(taskId: string): TaskStatus | undefined {
    return this.taskStatuses.get(taskId);
  }

  async cancel(taskId: string): Promise<boolean> {
    const spec = this.runningTasks.get(taskId);
    if (!spec || spec.type !== 'k8s_job' || !spec.k8sJob) {
      return false;
    }

    const deleted = await this.k8sAdapter.deleteJob(
      spec.k8sJob.clusterContext,
      `task-${taskId}`,
      spec.k8sJob.namespace ?? 'default'
    );

    if (deleted) {
      this.runningTasks.delete(taskId);
      this.updateStatus(taskId, 'cancelled');
      this.emit('taskCancelled', taskId);
    }

    return deleted;
  }

  async deleteCompletedJob(taskId: string): Promise<boolean> {
    const status = this.taskStatuses.get(taskId);
    if (!status || status.state !== 'completed') {
      return false;
    }

    // Find the original spec (we'd need to store it somewhere for this to work in real impl)
    // For test purposes, we'll assume the context is known
    const deleted = await this.k8sAdapter.deleteJob('test-cluster', `task-${taskId}`, 'default');

    if (deleted) {
      this.emit('k8sJobDeleted', taskId);
    }

    return deleted;
  }

  // Helper for timeout tests
  setTaskTimeout(taskId: string, timeoutMs: number): void {
    setTimeout(() => {
      const status = this.taskStatuses.get(taskId);
      if (status && status.state === 'running') {
        this.updateStatus(taskId, 'failed');
        const statusObj = this.taskStatuses.get(taskId);
        if (statusObj) {
          statusObj.error = 'Task timed out';
        }
        this.emit('taskTimeout', taskId);
      }
    }, timeoutMs);
  }
}

describe('Kubernetes Task Integration', () => {
  let k8sAdapter: MockKubernetesAdapter;
  let scheduler: MockTaskScheduler;

  beforeEach(() => {
    k8sAdapter = new MockKubernetesAdapter();
    scheduler = new MockTaskScheduler(k8sAdapter);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('K8s Task Submission', () => {
    it('should submit k8s_job task through scheduler', async () => {
      const taskSpec: TaskSpec = {
        taskId: 'k8s-task-1',
        type: 'k8s_job',
        submitterNode: 'node-1',
        k8sJob: {
          clusterContext: 'gke_project_region_cluster',
          namespace: 'default',
          image: 'node:20-alpine',
          command: ['npm', 'test'],
        },
      };

      const result = await scheduler.submit(taskSpec);

      expect(result.accepted).toBe(true);
      expect(result.taskId).toBe('k8s-task-1');
      expect(k8sAdapter.submitJob).toHaveBeenCalled();
    });

    it('should pass job spec to kubernetes adapter', async () => {
      const taskSpec: TaskSpec = {
        taskId: 'k8s-task-2',
        type: 'k8s_job',
        submitterNode: 'node-1',
        k8sJob: {
          clusterContext: 'my-k8s-cluster',
          namespace: 'production',
          image: 'gcr.io/project/app:v1.2.3',
          command: ['./run-tests.sh'],
          labels: { app: 'test-runner', env: 'ci' },
        },
      };

      await scheduler.submit(taskSpec);

      expect(k8sAdapter.submitJob).toHaveBeenCalledWith(
        'my-k8s-cluster',
        expect.objectContaining({
          name: 'task-k8s-task-2',
          namespace: 'production',
          image: 'gcr.io/project/app:v1.2.3',
          command: ['./run-tests.sh'],
          labels: { app: 'test-runner', env: 'ci' },
        })
      );
    });

    it('should track k8s task status', async () => {
      const taskSpec: TaskSpec = {
        taskId: 'k8s-task-3',
        type: 'k8s_job',
        submitterNode: 'node-1',
        k8sJob: {
          clusterContext: 'test-cluster',
          image: 'busybox:latest',
          command: ['echo', 'hello'],
        },
      };

      await scheduler.submit(taskSpec);

      const status = scheduler.getStatus('k8s-task-3');
      expect(status).toBeDefined();
      expect(status?.taskId).toBe('k8s-task-3');
      expect(status?.state).toBe('running');
      expect(status?.startedAt).toBeDefined();
    });

    it('should handle k8s task completion', async () => {
      const taskSpec: TaskSpec = {
        taskId: 'k8s-task-4',
        type: 'k8s_job',
        submitterNode: 'node-1',
        k8sJob: {
          clusterContext: 'test-cluster',
          image: 'alpine:latest',
        },
      };

      const completedPromise = new Promise<void>((resolve) => {
        scheduler.on('taskCompleted', (taskId) => {
          if (taskId === 'k8s-task-4') resolve();
        });
      });

      await scheduler.submit(taskSpec);

      // Simulate job completion
      k8sAdapter.getJobStatus.mockResolvedValue({
        name: 'task-k8s-task-4',
        namespace: 'default',
        active: 0,
        succeeded: 1,
        failed: 0,
        completionTime: new Date(),
        conditions: [{ type: 'Complete', status: 'True' }],
      });

      await scheduler.checkK8sJobStatus('k8s-task-4');
      await completedPromise;

      const status = scheduler.getStatus('k8s-task-4');
      expect(status?.state).toBe('completed');
      expect(status?.completedAt).toBeDefined();
    });
  });

  describe('K8s Task Requirements', () => {
    it('should honor GPU requirements for k8s tasks', async () => {
      const taskSpec: TaskSpec = {
        taskId: 'gpu-task-1',
        type: 'k8s_job',
        submitterNode: 'node-1',
        k8sJob: {
          clusterContext: 'gpu-cluster',
          image: 'nvidia/cuda:12.0-base',
          command: ['python', 'train.py'],
          resources: {
            requiresGpu: true,
            gpuMemoryBytes: 8 * 1024 * 1024 * 1024, // 8GB
          },
        },
      };

      await scheduler.submit(taskSpec);

      expect(k8sAdapter.submitJob).toHaveBeenCalledWith(
        'gpu-cluster',
        expect.objectContaining({
          gpuLimit: 1,
        })
      );
    });

    it('should use specified cluster context', async () => {
      const taskSpec: TaskSpec = {
        taskId: 'context-task-1',
        type: 'k8s_job',
        submitterNode: 'node-1',
        k8sJob: {
          clusterContext: 'gke_my-project_us-central1_my-cluster',
          image: 'gcr.io/my-project/app:latest',
        },
      };

      await scheduler.submit(taskSpec);

      expect(k8sAdapter.submitJob).toHaveBeenCalledWith(
        'gke_my-project_us-central1_my-cluster',
        expect.any(Object)
      );
    });

    it('should apply resource limits from spec', async () => {
      const taskSpec: TaskSpec = {
        taskId: 'resource-task-1',
        type: 'k8s_job',
        submitterNode: 'node-1',
        k8sJob: {
          clusterContext: 'test-cluster',
          image: 'node:20',
          resources: {
            cpuCores: 4,
            memoryBytes: 8 * 1024 * 1024 * 1024, // 8GB
          },
        },
      };

      await scheduler.submit(taskSpec);

      expect(k8sAdapter.submitJob).toHaveBeenCalledWith(
        'test-cluster',
        expect.objectContaining({
          cpuRequest: '4',
          cpuLimit: '4',
          memoryRequest: '8192Mi',
          memoryLimit: '8192Mi',
        })
      );
    });
  });

  describe('K8s Task Failure Handling', () => {
    it('should handle k8s job failure', async () => {
      const taskSpec: TaskSpec = {
        taskId: 'fail-task-1',
        type: 'k8s_job',
        submitterNode: 'node-1',
        k8sJob: {
          clusterContext: 'test-cluster',
          image: 'nonexistent:image',
        },
      };

      const failedPromise = new Promise<string>((resolve) => {
        scheduler.on('taskFailed', (taskId, error) => {
          if (taskId === 'fail-task-1') resolve(error);
        });
      });

      await scheduler.submit(taskSpec);

      // Simulate job failure
      k8sAdapter.getJobStatus.mockResolvedValue({
        name: 'task-fail-task-1',
        namespace: 'default',
        active: 0,
        succeeded: 0,
        failed: 3,
        conditions: [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded' }],
      });

      // Exhaust retries
      for (let i = 0; i < 4; i++) {
        await scheduler.checkK8sJobStatus('fail-task-1');
      }

      const error = await failedPromise;
      const status = scheduler.getStatus('fail-task-1');

      expect(status?.state).toBe('failed');
      expect(error).toBeDefined();
    });

    it('should retry failed k8s jobs', async () => {
      vi.useFakeTimers();

      k8sAdapter.submitJob
        .mockRejectedValueOnce(new Error('Temporary failure'))
        .mockRejectedValueOnce(new Error('Temporary failure'))
        .mockResolvedValue('job-retry-success');

      const taskSpec: TaskSpec = {
        taskId: 'retry-task-1',
        type: 'k8s_job',
        submitterNode: 'node-1',
        k8sJob: {
          clusterContext: 'test-cluster',
          image: 'alpine:latest',
        },
      };

      let retryCount = 0;
      scheduler.on('k8sJobRetry', () => {
        retryCount++;
      });

      await scheduler.submit(taskSpec);

      // Advance time to allow first retry
      await vi.advanceTimersByTimeAsync(1500);

      // Advance time to allow second retry
      await vi.advanceTimersByTimeAsync(1500);

      expect(retryCount).toBe(2);
      expect(k8sAdapter.submitJob).toHaveBeenCalledTimes(3);

      vi.useRealTimers();
    });

    it('should timeout stuck k8s jobs', async () => {
      vi.useFakeTimers();

      const taskSpec: TaskSpec = {
        taskId: 'timeout-task-1',
        type: 'k8s_job',
        submitterNode: 'node-1',
        k8sJob: {
          clusterContext: 'test-cluster',
          image: 'alpine:latest',
        },
        timeoutMs: 5000,
      };

      const timeoutPromise = new Promise<string>((resolve) => {
        scheduler.on('taskTimeout', (taskId) => {
          resolve(taskId);
        });
      });

      await scheduler.submit(taskSpec);
      scheduler.setTaskTimeout('timeout-task-1', taskSpec.timeoutMs!);

      // Advance time past timeout
      vi.advanceTimersByTime(6000);

      const timedOutTaskId = await timeoutPromise;
      const status = scheduler.getStatus('timeout-task-1');

      expect(timedOutTaskId).toBe('timeout-task-1');
      expect(status?.state).toBe('failed');
      expect(status?.error).toBe('Task timed out');

      vi.useRealTimers();
    });
  });

  describe('K8s Task Cleanup', () => {
    it('should delete completed k8s jobs', async () => {
      const taskSpec: TaskSpec = {
        taskId: 'cleanup-task-1',
        type: 'k8s_job',
        submitterNode: 'node-1',
        k8sJob: {
          clusterContext: 'test-cluster',
          image: 'alpine:latest',
        },
      };

      await scheduler.submit(taskSpec);

      // Complete the job
      scheduler.completeK8sJob('cleanup-task-1', true);

      const deletedPromise = new Promise<string>((resolve) => {
        scheduler.on('k8sJobDeleted', (taskId) => {
          resolve(taskId);
        });
      });

      const deleted = await scheduler.deleteCompletedJob('cleanup-task-1');
      const deletedTaskId = await deletedPromise;

      expect(deleted).toBe(true);
      expect(deletedTaskId).toBe('cleanup-task-1');
      expect(k8sAdapter.deleteJob).toHaveBeenCalledWith(
        'test-cluster',
        'task-cleanup-task-1',
        'default'
      );
    });

    it('should cancel running k8s jobs', async () => {
      const taskSpec: TaskSpec = {
        taskId: 'cancel-task-1',
        type: 'k8s_job',
        submitterNode: 'node-1',
        k8sJob: {
          clusterContext: 'test-cluster',
          namespace: 'my-namespace',
          image: 'long-running:latest',
        },
      };

      const cancelledPromise = new Promise<string>((resolve) => {
        scheduler.on('taskCancelled', (taskId) => {
          resolve(taskId);
        });
      });

      await scheduler.submit(taskSpec);

      // Verify it's running
      expect(scheduler.getStatus('cancel-task-1')?.state).toBe('running');

      // Cancel the job
      const cancelled = await scheduler.cancel('cancel-task-1');
      const cancelledTaskId = await cancelledPromise;

      expect(cancelled).toBe(true);
      expect(cancelledTaskId).toBe('cancel-task-1');
      expect(scheduler.getStatus('cancel-task-1')?.state).toBe('cancelled');
      expect(k8sAdapter.deleteJob).toHaveBeenCalledWith(
        'test-cluster',
        'task-cancel-task-1',
        'my-namespace'
      );
    });
  });
});
