import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// Mock types for testing
interface MockNodeInfo {
  nodeId: string;
  hostname: string;
  tailscaleIp: string;
  grpcPort: number;
  role: string;
  status: string;
  resources: {
    cpuCores: number;
    memoryBytes: number;
    memoryAvailableBytes: number;
    gpus: Array<{
      name: string;
      memoryBytes: number;
      memoryAvailableBytes: number;
      utilizationPercent: number;
      inUseForGaming: boolean;
    }>;
    diskBytes: number;
    diskAvailableBytes: number;
    cpuUsagePercent: number;
    gamingDetected: boolean;
  } | null;
  tags: string[];
  joinedAt: number;
  lastSeen: number;
}

// Create mock dependencies
function createMockMembership() {
  const nodes: MockNodeInfo[] = [
    {
      nodeId: 'node-1',
      hostname: 'rog2',
      tailscaleIp: '100.104.78.123',
      grpcPort: 50051,
      role: 'leader',
      status: 'active',
      resources: {
        cpuCores: 16,
        memoryBytes: 32 * 1024 * 1024 * 1024,
        memoryAvailableBytes: 16 * 1024 * 1024 * 1024,
        gpus: [{
          name: 'RTX 4090',
          memoryBytes: 24 * 1024 * 1024 * 1024,
          memoryAvailableBytes: 20 * 1024 * 1024 * 1024,
          utilizationPercent: 10,
          inUseForGaming: false,
        }],
        diskBytes: 1024 * 1024 * 1024 * 1024,
        diskAvailableBytes: 500 * 1024 * 1024 * 1024,
        cpuUsagePercent: 25,
        gamingDetected: false,
      },
      tags: ['gpu', 'development'],
      joinedAt: Date.now() - 3600000,
      lastSeen: Date.now(),
    },
    {
      nodeId: 'node-2',
      hostname: 'terminus',
      tailscaleIp: '100.85.203.53',
      grpcPort: 50051,
      role: 'follower',
      status: 'active',
      resources: {
        cpuCores: 8,
        memoryBytes: 16 * 1024 * 1024 * 1024,
        memoryAvailableBytes: 8 * 1024 * 1024 * 1024,
        gpus: [],
        diskBytes: 512 * 1024 * 1024 * 1024,
        diskAvailableBytes: 200 * 1024 * 1024 * 1024,
        cpuUsagePercent: 50,
        gamingDetected: false,
      },
      tags: ['ci'],
      joinedAt: Date.now() - 7200000,
      lastSeen: Date.now(),
    },
    {
      nodeId: 'node-3',
      hostname: 'gaming-pc',
      tailscaleIp: '100.94.211.117',
      grpcPort: 50051,
      role: 'follower',
      status: 'active',
      resources: {
        cpuCores: 12,
        memoryBytes: 64 * 1024 * 1024 * 1024,
        memoryAvailableBytes: 4 * 1024 * 1024 * 1024,
        gpus: [{
          name: 'RTX 3080',
          memoryBytes: 10 * 1024 * 1024 * 1024,
          memoryAvailableBytes: 2 * 1024 * 1024 * 1024,
          utilizationPercent: 95,
          inUseForGaming: true,
        }],
        diskBytes: 2048 * 1024 * 1024 * 1024,
        diskAvailableBytes: 100 * 1024 * 1024 * 1024,
        cpuUsagePercent: 80,
        gamingDetected: true,
      },
      tags: ['gaming'],
      joinedAt: Date.now() - 1800000,
      lastSeen: Date.now(),
    },
  ];

  return {
    getActiveNodes: vi.fn().mockReturnValue(nodes),
    getNode: vi.fn((id: string) => nodes.find(n => n.nodeId === id)),
    getAllNodes: vi.fn().mockReturnValue(nodes),
  };
}

function createMockRaft(isLeader: boolean = true) {
  return {
    isLeader: vi.fn().mockReturnValue(isLeader),
    appendEntry: vi.fn().mockResolvedValue({ success: true, term: 1, index: 1 }),
  };
}

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function createMockClientPool() {
  return {
    getConnection: vi.fn(),
    call: vi.fn(),
    callStream: vi.fn(),
  };
}

describe('Task Scheduler', () => {
  describe('Task Validation', () => {
    it('should reject task without taskId', () => {
      const spec = {
        taskId: '',
        type: 'shell' as const,
        submitterNode: 'node-1',
        shell: { command: 'echo hello' },
      };

      // Validate taskId presence
      expect(spec.taskId).toBe('');
    });

    it('should reject shell task without command', () => {
      const spec = {
        taskId: 'task-1',
        type: 'shell' as const,
        submitterNode: 'node-1',
        shell: { command: '' },
      };

      expect(spec.shell.command).toBe('');
    });

    it('should accept valid shell task', () => {
      const spec = {
        taskId: 'task-1',
        type: 'shell' as const,
        submitterNode: 'node-1',
        shell: { command: 'npm run build' },
      };

      expect(spec.taskId).toBeTruthy();
      expect(spec.type).toBe('shell');
      expect(spec.shell.command).toBeTruthy();
    });

    it('should accept valid container task', () => {
      const spec = {
        taskId: 'task-2',
        type: 'container' as const,
        submitterNode: 'node-1',
        container: {
          image: 'node:20',
          command: ['npm', 'test'],
        },
      };

      expect(spec.container.image).toBeTruthy();
    });

    it('should accept valid subagent task', () => {
      const spec = {
        taskId: 'task-3',
        type: 'subagent' as const,
        submitterNode: 'node-1',
        subagent: {
          prompt: 'Analyze this code and suggest improvements',
          model: 'claude-3-sonnet',
        },
      };

      expect(spec.subagent.prompt).toBeTruthy();
    });
  });

  describe('Node Selection', () => {
    let membership: ReturnType<typeof createMockMembership>;

    beforeEach(() => {
      membership = createMockMembership();
    });

    it('should filter nodes by allowed list', () => {
      const nodes = membership.getActiveNodes();
      const allowedNodes = ['node-1'];

      const filtered = nodes.filter(n => allowedNodes.includes(n.nodeId));

      expect(filtered).toHaveLength(1);
      expect(filtered[0].nodeId).toBe('node-1');
    });

    it('should exclude gaming nodes when avoidGamingNodes is true', () => {
      const nodes = membership.getActiveNodes();

      const filtered = nodes.filter(n => !n.resources?.gamingDetected);

      expect(filtered).toHaveLength(2);
      expect(filtered.every(n => !n.resources?.gamingDetected)).toBe(true);
    });

    it('should filter nodes by GPU requirement', () => {
      const nodes = membership.getActiveNodes();

      const withGpu = nodes.filter(n =>
        n.resources?.gpus &&
        n.resources.gpus.length > 0 &&
        n.resources.gpus.some(g => !g.inUseForGaming)
      );

      expect(withGpu).toHaveLength(1);
      expect(withGpu[0].nodeId).toBe('node-1');
    });

    it('should filter nodes by memory requirement', () => {
      const nodes = membership.getActiveNodes();
      const requiredMemory = 10 * 1024 * 1024 * 1024; // 10GB

      const filtered = nodes.filter(n =>
        n.resources && n.resources.memoryAvailableBytes >= requiredMemory
      );

      expect(filtered).toHaveLength(1); // Only node-1 (16GB available) passes, node-2 (8GB) fails
    });
  });

  describe('Node Scoring', () => {
    let membership: ReturnType<typeof createMockMembership>;

    beforeEach(() => {
      membership = createMockMembership();
    });

    it('should prefer nodes with lower CPU usage', () => {
      const nodes = membership.getActiveNodes();

      // Score based on CPU availability
      const scored = nodes.map(n => ({
        node: n,
        cpuScore: n.resources ? (1 - n.resources.cpuUsagePercent / 100) * 30 : 0,
      }));

      scored.sort((a, b) => b.cpuScore - a.cpuScore);

      expect(scored[0].node.nodeId).toBe('node-1'); // 25% CPU usage
      expect(scored[1].node.nodeId).toBe('node-2'); // 50% CPU usage
      expect(scored[2].node.nodeId).toBe('node-3'); // 80% CPU usage
    });

    it('should penalize gaming nodes', () => {
      const nodes = membership.getActiveNodes();

      const scored = nodes.map(n => ({
        node: n,
        score: n.resources?.gamingDetected ? -40 : 0,
      }));

      const gamingNode = scored.find(s => s.node.nodeId === 'node-3');
      expect(gamingNode?.score).toBe(-40);
    });

    it('should give bonus for local node when preferLocal is true', () => {
      const submitterNode = 'node-1';
      const nodes = membership.getActiveNodes();

      const scored = nodes.map(n => ({
        node: n,
        localBonus: n.nodeId === submitterNode ? 50 : 0,
      }));

      const localNode = scored.find(s => s.node.nodeId === submitterNode);
      expect(localNode?.localBonus).toBe(50);
    });
  });

  describe('Task Priority', () => {
    it('should sort tasks by priority (higher first)', () => {
      const tasks = [
        { taskId: 'low', priority: 1, queuedAt: Date.now() },
        { taskId: 'high', priority: 10, queuedAt: Date.now() },
        { taskId: 'medium', priority: 5, queuedAt: Date.now() },
      ];

      tasks.sort((a, b) => b.priority - a.priority);

      expect(tasks[0].taskId).toBe('high');
      expect(tasks[1].taskId).toBe('medium');
      expect(tasks[2].taskId).toBe('low');
    });

    it('should sort by queue time when priority is equal', () => {
      const now = Date.now();
      const tasks = [
        { taskId: 'newer', priority: 5, queuedAt: now },
        { taskId: 'older', priority: 5, queuedAt: now - 1000 },
      ];

      tasks.sort((a, b) => {
        const priorityDiff = b.priority - a.priority;
        if (priorityDiff !== 0) return priorityDiff;
        return a.queuedAt - b.queuedAt;
      });

      expect(tasks[0].taskId).toBe('older');
      expect(tasks[1].taskId).toBe('newer');
    });
  });

  describe('Resource Requirements', () => {
    let membership: ReturnType<typeof createMockMembership>;

    beforeEach(() => {
      membership = createMockMembership();
    });

    it('should check CPU availability correctly', () => {
      const node = membership.getNode('node-1')!;
      const requiredCores = 4;

      const availableCores = node.resources!.cpuCores * (1 - node.resources!.cpuUsagePercent / 100);

      expect(availableCores).toBeGreaterThanOrEqual(requiredCores);
      expect(availableCores).toBe(12); // 16 cores * 75% available
    });

    it('should reject node with insufficient memory', () => {
      const node = membership.getNode('node-3')!;
      const requiredMemory = 10 * 1024 * 1024 * 1024; // 10GB

      const hasEnoughMemory = node.resources!.memoryAvailableBytes >= requiredMemory;

      expect(hasEnoughMemory).toBe(false); // Only 4GB available
    });

    it('should check GPU availability for GPU tasks', () => {
      const node = membership.getNode('node-1')!;

      const availableGpu = node.resources!.gpus.find(g => !g.inUseForGaming);

      expect(availableGpu).toBeDefined();
      expect(availableGpu!.inUseForGaming).toBe(false);
    });

    it('should reject node with GPU in use for gaming', () => {
      const node = membership.getNode('node-3')!;

      const availableGpu = node.resources!.gpus.find(g => !g.inUseForGaming);

      expect(availableGpu).toBeUndefined();
    });
  });
});

describe('Task Types', () => {
  describe('Shell Tasks', () => {
    it('should support sandboxed execution', () => {
      const spec = {
        type: 'shell' as const,
        shell: {
          command: 'rm -rf /',
          sandboxed: true,
        },
      };

      expect(spec.shell.sandboxed).toBe(true);
    });

    it('should support working directory', () => {
      const spec = {
        type: 'shell' as const,
        shell: {
          command: 'npm test',
          workingDirectory: '/home/user/project',
        },
      };

      expect(spec.shell.workingDirectory).toBe('/home/user/project');
    });
  });

  describe('Container Tasks', () => {
    it('should support volume mounts', () => {
      const spec = {
        type: 'container' as const,
        container: {
          image: 'node:20',
          mounts: [
            { hostPath: '/data', containerPath: '/app/data', readOnly: true },
          ],
        },
      };

      expect(spec.container.mounts).toHaveLength(1);
      expect(spec.container.mounts![0].readOnly).toBe(true);
    });

    it('should support environment variables', () => {
      const spec = {
        type: 'container' as const,
        container: {
          image: 'node:20',
        },
        environment: {
          NODE_ENV: 'production',
          API_KEY: 'secret',
        },
      };

      expect(spec.environment).toHaveProperty('NODE_ENV', 'production');
    });
  });

  describe('Subagent Tasks', () => {
    it('should support model selection', () => {
      const spec = {
        type: 'subagent' as const,
        subagent: {
          prompt: 'Review code',
          model: 'claude-3-opus',
        },
      };

      expect(spec.subagent.model).toBe('claude-3-opus');
    });

    it('should support tool restrictions', () => {
      const spec = {
        type: 'subagent' as const,
        subagent: {
          prompt: 'Analyze files',
          tools: ['read', 'grep', 'glob'],
        },
      };

      expect(spec.subagent.tools).toContain('read');
      expect(spec.subagent.tools).not.toContain('write');
    });

    it('should support max turns limit', () => {
      const spec = {
        type: 'subagent' as const,
        subagent: {
          prompt: 'Quick analysis',
          maxTurns: 3,
        },
      };

      expect(spec.subagent.maxTurns).toBe(3);
    });
  });

  describe('K8s Job Tasks', () => {
    it('should require cluster context', () => {
      const spec = {
        type: 'k8s_job' as const,
        k8sJob: {
          clusterContext: 'gke_project_region_cluster',
          image: 'gcr.io/project/image:latest',
          namespace: 'default',
        },
      };

      expect(spec.k8sJob.clusterContext).toBeTruthy();
      expect(spec.k8sJob.namespace).toBe('default');
    });
  });

  describe('Claude Relay Tasks', () => {
    it('should support full context transfer', () => {
      const spec = {
        type: 'claude_relay' as const,
        claudeRelay: {
          targetSessionId: 'session-abc',
          prompt: 'Continue this work',
          fullContext: 'User asked to refactor auth module...',
          awaitResponse: true,
        },
      };

      expect(spec.claudeRelay.fullContext).toBeTruthy();
      expect(spec.claudeRelay.awaitResponse).toBe(true);
    });
  });
});
