import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { TaskExecutor, TaskSpec, TaskResult, TaskOutput } from '../src/agent/task-executor';

// Mock child_process.spawn
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

// Mock dockerode
vi.mock('dockerode', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      getImage: vi.fn(),
      createContainer: vi.fn(),
      getContainer: vi.fn(),
    })),
  };
});

import { spawn } from 'child_process';
import Docker from 'dockerode';

// Helper to create a mock child process
function createMockProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.kill = vi.fn().mockImplementation(() => {
    proc.killed = true;
  });
  return proc;
}

// Helper to create a mock logger
function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as import('winston').Logger;
}

describe('TaskExecutor', () => {
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockSpawn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger = createMockLogger();
    mockSpawn = spawn as unknown as ReturnType<typeof vi.fn>;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Initialization', () => {
    it('should create with default config', () => {
      const executor = new TaskExecutor({ logger: mockLogger });

      expect(executor).toBeInstanceOf(TaskExecutor);
      expect(executor).toBeInstanceOf(EventEmitter);
    });

    it('should use custom max concurrent tasks', async () => {
      const executor = new TaskExecutor({
        logger: mockLogger,
        maxConcurrentTasks: 5,
      });

      // Start 5 tasks that never complete
      const mockProcs: ReturnType<typeof createMockProcess>[] = [];
      for (let i = 0; i < 5; i++) {
        const mockProc = createMockProcess();
        mockProcs.push(mockProc);
        mockSpawn.mockReturnValueOnce(mockProc);
      }

      const promises = [];
      for (let i = 0; i < 5; i++) {
        promises.push(executor.execute({
          taskId: `task-${i}`,
          type: 'shell',
          shell: { command: 'sleep 10' },
        }));
      }

      // 6th task should fail immediately due to max concurrent
      await expect(executor.execute({
        taskId: 'task-6',
        type: 'shell',
        shell: { command: 'echo hello' },
      })).rejects.toThrow('Max concurrent tasks (5) reached');

      // Clean up - emit close events
      mockProcs.forEach(proc => proc.emit('close', 0, null));
      await Promise.all(promises);
    });

    it('should initialize Docker when socket provided', () => {
      const DockerMock = Docker as unknown as ReturnType<typeof vi.fn>;

      new TaskExecutor({
        logger: mockLogger,
        dockerSocket: '/var/run/docker.sock',
      });

      expect(DockerMock).toHaveBeenCalledWith({ socketPath: '/var/run/docker.sock' });
    });
  });

  describe('Shell Task Execution', () => {
    it('should execute shell command successfully', async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const executor = new TaskExecutor({ logger: mockLogger });
      const resultPromise = executor.execute({
        taskId: 'test-task',
        type: 'shell',
        shell: { command: 'echo hello' },
      });

      // Simulate successful completion
      mockProc.emit('close', 0, null);

      const result = await resultPromise;

      expect(result.taskId).toBe('test-task');
      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(mockSpawn).toHaveBeenCalledWith(
        '/bin/sh',
        ['-c', 'echo hello'],
        expect.objectContaining({
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      );
    });

    it('should capture stdout from shell task', async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const executor = new TaskExecutor({ logger: mockLogger });
      const resultPromise = executor.execute({
        taskId: 'test-task',
        type: 'shell',
        shell: { command: 'echo hello' },
      });

      // Simulate stdout output
      mockProc.stdout.emit('data', Buffer.from('hello world\n'));
      mockProc.emit('close', 0, null);

      const result = await resultPromise;

      expect(result.stdout.toString()).toBe('hello world\n');
    });

    it('should capture stderr from shell task', async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const executor = new TaskExecutor({ logger: mockLogger });
      const resultPromise = executor.execute({
        taskId: 'test-task',
        type: 'shell',
        shell: { command: 'some-command' },
      });

      // Simulate stderr output
      mockProc.stderr.emit('data', Buffer.from('error message\n'));
      mockProc.emit('close', 1, null);

      const result = await resultPromise;

      expect(result.stderr.toString()).toBe('error message\n');
    });

    it('should handle shell command failure (non-zero exit)', async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const executor = new TaskExecutor({ logger: mockLogger });
      const resultPromise = executor.execute({
        taskId: 'test-task',
        type: 'shell',
        shell: { command: 'exit 1' },
      });

      mockProc.emit('close', 1, null);

      const result = await resultPromise;

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
    });

    it('should pass environment variables to shell', async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const executor = new TaskExecutor({ logger: mockLogger });
      const resultPromise = executor.execute({
        taskId: 'test-task',
        type: 'shell',
        shell: { command: 'echo $MY_VAR' },
        environment: { MY_VAR: 'test-value' },
      });

      mockProc.emit('close', 0, null);
      await resultPromise;

      expect(mockSpawn).toHaveBeenCalledWith(
        '/bin/sh',
        ['-c', 'echo $MY_VAR'],
        expect.objectContaining({
          env: expect.objectContaining({ MY_VAR: 'test-value' }),
        })
      );
    });

    it('should use working directory for shell task', async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const executor = new TaskExecutor({ logger: mockLogger });
      const resultPromise = executor.execute({
        taskId: 'test-task',
        type: 'shell',
        shell: { command: 'pwd', workingDirectory: '/tmp' },
      });

      mockProc.emit('close', 0, null);
      await resultPromise;

      expect(mockSpawn).toHaveBeenCalledWith(
        '/bin/sh',
        ['-c', 'pwd'],
        expect.objectContaining({
          cwd: '/tmp',
        })
      );
    });

    it('should use sandbox command when sandboxed=true', async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const executor = new TaskExecutor({
        logger: mockLogger,
        sandboxCommand: '/usr/bin/firejail',
      });

      const resultPromise = executor.execute({
        taskId: 'test-task',
        type: 'shell',
        shell: { command: 'echo hello', sandboxed: true },
      });

      mockProc.emit('close', 0, null);
      await resultPromise;

      expect(mockSpawn).toHaveBeenCalledWith(
        '/usr/bin/firejail',
        ['echo hello'],
        expect.any(Object)
      );
    });

    it('should emit output events during execution', async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const executor = new TaskExecutor({ logger: mockLogger });

      const outputs: Array<{ taskId: string; output: TaskOutput }> = [];
      executor.on('output', (taskId: string, output: TaskOutput) => {
        outputs.push({ taskId, output });
      });

      const resultPromise = executor.execute({
        taskId: 'test-task',
        type: 'shell',
        shell: { command: 'echo hello' },
      });

      mockProc.stdout.emit('data', Buffer.from('stdout data'));
      mockProc.stderr.emit('data', Buffer.from('stderr data'));
      mockProc.emit('close', 0, null);

      await resultPromise;

      expect(outputs).toHaveLength(2);
      expect(outputs[0].taskId).toBe('test-task');
      expect(outputs[0].output.type).toBe('stdout');
      expect(outputs[0].output.data.toString()).toBe('stdout data');
      expect(outputs[1].output.type).toBe('stderr');
      expect(outputs[1].output.data.toString()).toBe('stderr data');
    });
  });

  describe('Task Timeout', () => {
    it('should timeout shell task after timeoutMs', async () => {
      vi.useFakeTimers();
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const executor = new TaskExecutor({ logger: mockLogger });
      const resultPromise = executor.execute({
        taskId: 'test-task',
        type: 'shell',
        shell: { command: 'sleep 60' },
        timeoutMs: 1000,
      });

      // Advance past timeout
      vi.advanceTimersByTime(1001);

      // Timeout should trigger kill
      expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');

      // Simulate process close after kill
      mockProc.emit('close', null, 'SIGTERM');

      const result = await resultPromise;

      expect(result.exitCode).toBe(128);
      expect(result.success).toBe(false);
    });

    it('should kill process on timeout', async () => {
      vi.useFakeTimers();
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const executor = new TaskExecutor({ logger: mockLogger });
      executor.execute({
        taskId: 'test-task',
        type: 'shell',
        shell: { command: 'sleep 60' },
        timeoutMs: 1000,
      });

      vi.advanceTimersByTime(1001);

      expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('should mark timed out task as failed', async () => {
      vi.useFakeTimers();
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const executor = new TaskExecutor({ logger: mockLogger });
      const resultPromise = executor.execute({
        taskId: 'test-task',
        type: 'shell',
        shell: { command: 'sleep 60' },
        timeoutMs: 1000,
      });

      vi.advanceTimersByTime(1001);
      mockProc.emit('close', null, 'SIGTERM');

      const result = await resultPromise;

      expect(result.success).toBe(false);
    });
  });

  describe('Task Cancellation', () => {
    it('should cancel running shell task', async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const executor = new TaskExecutor({ logger: mockLogger });
      const resultPromise = executor.execute({
        taskId: 'test-task',
        type: 'shell',
        shell: { command: 'sleep 60' },
      });

      // Cancel the task
      const cancelled = await executor.cancel('test-task');

      expect(cancelled).toBe(true);
      expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');

      mockProc.emit('close', null, 'SIGTERM');
      const result = await resultPromise;

      expect(result.error).toBe('Task cancelled');
    });

    it('should return false when cancelling non-existent task', async () => {
      const executor = new TaskExecutor({ logger: mockLogger });

      const cancelled = await executor.cancel('non-existent-task');

      expect(cancelled).toBe(false);
    });

    it('should kill process on cancel', async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const executor = new TaskExecutor({ logger: mockLogger });
      executor.execute({
        taskId: 'test-task',
        type: 'shell',
        shell: { command: 'sleep 60' },
      });

      await executor.cancel('test-task');

      expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('should mark cancelled task as failed', async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const executor = new TaskExecutor({ logger: mockLogger });
      const resultPromise = executor.execute({
        taskId: 'test-task',
        type: 'shell',
        shell: { command: 'sleep 60' },
      });

      await executor.cancel('test-task');
      mockProc.emit('close', 0, null);

      const result = await resultPromise;

      expect(result.success).toBe(false);
      expect(result.error).toBe('Task cancelled');
    });
  });

  describe('Concurrency Control', () => {
    it('should track running task IDs', async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const executor = new TaskExecutor({ logger: mockLogger });
      executor.execute({
        taskId: 'test-task-1',
        type: 'shell',
        shell: { command: 'sleep 10' },
      });

      const runningIds = executor.getRunningTaskIds();

      expect(runningIds).toContain('test-task-1');
      expect(runningIds).toHaveLength(1);

      // Clean up
      mockProc.emit('close', 0, null);
    });

    it('should enforce max concurrent tasks limit', async () => {
      const executor = new TaskExecutor({
        logger: mockLogger,
        maxConcurrentTasks: 2,
      });

      const mockProc1 = createMockProcess();
      const mockProc2 = createMockProcess();
      mockSpawn.mockReturnValueOnce(mockProc1).mockReturnValueOnce(mockProc2);

      const promise1 = executor.execute({
        taskId: 'task-1',
        type: 'shell',
        shell: { command: 'sleep 10' },
      });
      const promise2 = executor.execute({
        taskId: 'task-2',
        type: 'shell',
        shell: { command: 'sleep 10' },
      });

      // Third task should fail
      await expect(executor.execute({
        taskId: 'task-3',
        type: 'shell',
        shell: { command: 'echo hi' },
      })).rejects.toThrow('Max concurrent tasks (2) reached');

      // Clean up
      mockProc1.emit('close', 0, null);
      mockProc2.emit('close', 0, null);
      await Promise.all([promise1, promise2]);
    });

    it('should allow new task after previous completes', async () => {
      const executor = new TaskExecutor({
        logger: mockLogger,
        maxConcurrentTasks: 1,
      });

      const mockProc1 = createMockProcess();
      const mockProc2 = createMockProcess();
      mockSpawn.mockReturnValueOnce(mockProc1).mockReturnValueOnce(mockProc2);

      const promise1 = executor.execute({
        taskId: 'task-1',
        type: 'shell',
        shell: { command: 'echo first' },
      });

      // Complete first task
      mockProc1.emit('close', 0, null);
      await promise1;

      // Now second task should be allowed
      const promise2 = executor.execute({
        taskId: 'task-2',
        type: 'shell',
        shell: { command: 'echo second' },
      });

      mockProc2.emit('close', 0, null);
      const result2 = await promise2;

      expect(result2.success).toBe(true);
    });
  });

  describe('Container Tasks', () => {
    it('should fail container task when Docker unavailable', async () => {
      // Create executor without Docker (by making constructor throw)
      const DockerMock = Docker as unknown as ReturnType<typeof vi.fn>;
      DockerMock.mockImplementationOnce(() => {
        throw new Error('Docker not available');
      });

      const executor = new TaskExecutor({ logger: mockLogger });
      const result = await executor.execute({
        taskId: 'container-task',
        type: 'container',
        container: { image: 'alpine:latest' },
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Docker not available');
    });

    it('should return error message when Docker unavailable', async () => {
      const DockerMock = Docker as unknown as ReturnType<typeof vi.fn>;
      DockerMock.mockImplementationOnce(() => {
        throw new Error('Docker not available');
      });

      const executor = new TaskExecutor({ logger: mockLogger });
      const result = await executor.execute({
        taskId: 'container-task',
        type: 'container',
        container: { image: 'node:18' },
      });

      expect(result.error).toBeDefined();
      expect(result.exitCode).toBe(-1);
    });

    it('should attempt to execute container task with Docker', async () => {
      const mockContainer = {
        id: 'container-123',
        attach: vi.fn().mockResolvedValue({
          on: vi.fn(),
        }),
        start: vi.fn().mockResolvedValue(undefined),
        wait: vi.fn().mockResolvedValue({ StatusCode: 0 }),
      };

      const mockImage = {
        inspect: vi.fn().mockResolvedValue({}),
      };

      const DockerMock = Docker as unknown as ReturnType<typeof vi.fn>;
      DockerMock.mockImplementationOnce(() => ({
        getImage: vi.fn().mockReturnValue(mockImage),
        createContainer: vi.fn().mockResolvedValue(mockContainer),
        getContainer: vi.fn().mockReturnValue(mockContainer),
      }));

      const executor = new TaskExecutor({
        logger: mockLogger,
        dockerSocket: '/var/run/docker.sock',
      });

      const result = await executor.execute({
        taskId: 'container-task',
        type: 'container',
        container: {
          image: 'alpine:latest',
          command: ['echo', 'hello'],
        },
      });

      expect(result.taskId).toBe('container-task');
      expect(mockContainer.start).toHaveBeenCalled();
    });
  });

  describe('Subagent Tasks', () => {
    it('should return error when API key not configured', async () => {
      const executor = new TaskExecutor({ logger: mockLogger });
      const result = await executor.execute({
        taskId: 'subagent-task',
        type: 'subagent',
        subagent: {
          prompt: 'Do something complex',
          model: 'claude-3-opus',
        },
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Subagent executor not configured (missing ANTHROPIC_API_KEY)');
    });

    it('should log subagent task without API key', async () => {
      const executor = new TaskExecutor({ logger: mockLogger });

      const result = await executor.execute({
        taskId: 'subagent-task',
        type: 'subagent',
        subagent: {
          prompt: 'Test prompt',
        },
      });

      expect(result.success).toBe(false);
      expect(result.taskId).toBe('subagent-task');
      expect(result.exitCode).toBe(-1);
    });
  });
});
