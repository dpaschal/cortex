import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KubernetesPlugin } from '../../src/plugins/kubernetes/index.js';
import { PluginContext } from '../../src/plugins/types.js';
import { EventEmitter } from 'events';

const mockCluster = {
  name: 'local',
  type: 'k3s',
  context: 'local',
  server: 'https://localhost:6443',
  nodes: [{ name: 'node1', ready: true }],
  totalCpu: 4,
  totalMemory: 8 * 1024 ** 3,
  gpuNodes: 0,
};

// Mock the KubernetesAdapter module
vi.mock('../../src/kubernetes/adapter.js', () => ({
  KubernetesAdapter: vi.fn().mockImplementation(() => ({
    discoverClusters: vi.fn().mockResolvedValue([mockCluster]),
    listClusters: vi.fn().mockReturnValue([mockCluster]),
    submitJob: vi.fn().mockResolvedValue('test-job-123'),
    getClusterResources: vi.fn().mockResolvedValue({
      totalCpu: 4,
      totalMemory: 8 * 1024 ** 3,
      allocatableCpu: 3.5,
      allocatableMemory: 7 * 1024 ** 3,
      gpuCount: 0,
      runningPods: 5,
    }),
    scaleDeployment: vi.fn().mockResolvedValue(true),
  })),
}));

function createMockContext(config: Record<string, unknown> = {}): PluginContext {
  return {
    raft: {} as any,
    membership: {} as any,
    scheduler: {} as any,
    stateManager: {} as any,
    clientPool: {} as any,
    sharedMemoryDb: {} as any,
    memoryReplicator: {} as any,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    nodeId: 'test-node',
    sessionId: 'test-session',
    config: { enabled: true, ...config },
    events: new EventEmitter(),
  };
}

describe('KubernetesPlugin', () => {
  let plugin: KubernetesPlugin;

  beforeEach(() => {
    vi.clearAllMocks();
    plugin = new KubernetesPlugin();
  });

  it('should have correct name and version', () => {
    expect(plugin.name).toBe('kubernetes');
    expect(plugin.version).toBe('1.0.0');
  });

  it('should initialize and expose 4 k8s tools', async () => {
    await plugin.init(createMockContext());
    const tools = plugin.getTools();
    expect(tools.size).toBe(4);
    expect(tools.has('k8s_list_clusters')).toBe(true);
    expect(tools.has('k8s_submit_job')).toBe(true);
    expect(tools.has('k8s_get_resources')).toBe(true);
    expect(tools.has('k8s_scale')).toBe(true);
  });

  it('should expose cluster://k8s resource', async () => {
    await plugin.init(createMockContext());
    const resources = plugin.getResources();
    expect(resources.has('cluster://k8s')).toBe(true);
    expect(resources.get('cluster://k8s')!.name).toBe('Kubernetes Clusters');
    expect(resources.get('cluster://k8s')!.mimeType).toBe('application/json');
  });

  it('k8s_list_clusters should return formatted cluster info', async () => {
    await plugin.init(createMockContext());
    const tool = plugin.getTools().get('k8s_list_clusters')!;
    const result = await tool.handler({}) as any[];
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      name: 'local',
      type: 'k3s',
      context: 'local',
      nodes: 1,
      totalCpu: 4,
      totalMemoryGb: '8.0',
      gpuNodes: 0,
    });
  });

  it('should start and stop without error', async () => {
    await plugin.init(createMockContext());
    await plugin.start();
    await plugin.stop();
  });
});
