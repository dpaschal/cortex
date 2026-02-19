import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClusterToolsPlugin } from '../../src/plugins/cluster-tools/index.js';
import { PluginContext, ResourceHandler } from '../../src/plugins/types.js';
import { EventEmitter } from 'events';

function createMockContext(): PluginContext {
  const nodes = [{
    nodeId: 'node-1', hostname: 'test', tailscaleIp: '100.0.0.1',
    grpcPort: 50051, role: 'leader', status: 'active',
    resources: {
      cpuCores: 16, memoryBytes: 32e9, memoryAvailableBytes: 16e9,
      gpus: [], diskBytes: 1e12, diskAvailableBytes: 500e9,
      cpuUsagePercent: 25, gamingDetected: false,
    },
    tags: [], joinedAt: Date.now(), lastSeen: Date.now(),
  }];
  return {
    raft: { isLeader: vi.fn().mockReturnValue(true), getPeers: vi.fn().mockReturnValue([]) } as any,
    membership: {
      getAllNodes: vi.fn().mockReturnValue(nodes),
      getActiveNodes: vi.fn().mockReturnValue(nodes),
      getLeaderAddress: vi.fn().mockReturnValue('100.0.0.1:50051'),
      getSelfNode: vi.fn().mockReturnValue(nodes[0]),
      removeNode: vi.fn().mockResolvedValue(true),
    } as any,
    scheduler: {
      submit: vi.fn().mockResolvedValue({ accepted: true, assignedNode: 'node-1' }),
      getStatus: vi.fn().mockReturnValue(null),
    } as any,
    stateManager: {
      getState: vi.fn().mockReturnValue({ clusterId: 'test', nodes: [] }),
      getSessions: vi.fn().mockReturnValue([]),
      getSession: vi.fn().mockReturnValue(null),
      publishContext: vi.fn(),
      queryContext: vi.fn().mockReturnValue([]),
    } as any,
    clientPool: { closeConnection: vi.fn() } as any,
    sharedMemoryDb: {} as any,
    memoryReplicator: {} as any,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    nodeId: 'node-1', sessionId: 'session-1',
    config: { enabled: true }, events: new EventEmitter(),
  };
}

describe('ClusterToolsPlugin', () => {
  let plugin: ClusterToolsPlugin;

  beforeEach(() => {
    plugin = new ClusterToolsPlugin();
  });

  it('should have correct name and version', () => {
    expect(plugin.name).toBe('cluster-tools');
    expect(plugin.version).toBe('1.0.0');
  });

  it('should initialize and expose cluster tools (no k8s, no updater)', async () => {
    await plugin.init(createMockContext());
    const tools = plugin.getTools();

    // Should have core cluster tools
    expect(tools.has('cluster_status')).toBe(true);
    expect(tools.has('list_nodes')).toBe(true);
    expect(tools.has('submit_task')).toBe(true);
    expect(tools.has('get_task_result')).toBe(true);
    expect(tools.has('run_distributed')).toBe(true);
    expect(tools.has('dispatch_subagents')).toBe(true);
    expect(tools.has('scale_cluster')).toBe(true);

    // Should have session/context tools
    expect(tools.has('list_sessions')).toBe(true);
    expect(tools.has('relay_to_session')).toBe(true);
    expect(tools.has('publish_context')).toBe(true);
    expect(tools.has('query_context')).toBe(true);

    // Should NOT have k8s tools
    expect(tools.has('k8s_list_clusters')).toBe(false);
    expect(tools.has('k8s_submit_job')).toBe(false);
    expect(tools.has('k8s_get_resources')).toBe(false);
    expect(tools.has('k8s_scale')).toBe(false);

    // Should NOT have updater tool
    expect(tools.has('initiate_rolling_update')).toBe(false);

    // Should have 11 tools (16 total - 4 k8s - 1 updater)
    expect(tools.size).toBe(11);
  });

  it('should expose cluster resources', async () => {
    await plugin.init(createMockContext());
    const resources = plugin.getResources();
    expect(resources.has('cluster://state')).toBe(true);
    expect(resources.has('cluster://nodes')).toBe(true);
    expect(resources.has('cluster://sessions')).toBe(true);
    expect(resources.size).toBe(3);
  });

  it('should start and stop without error', async () => {
    await plugin.init(createMockContext());
    await plugin.start();
    await plugin.stop();
  });
});
