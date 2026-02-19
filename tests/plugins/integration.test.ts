import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PluginLoader } from '../../src/plugins/loader.js';
import { BUILTIN_PLUGINS } from '../../src/plugins/registry.js';
import { PluginContext } from '../../src/plugins/types.js';
import { EventEmitter } from 'events';

// Mock heavy dependencies that plugins import
vi.mock('../../src/mcp/tools.js', () => ({
  createTools: vi.fn().mockReturnValue(new Map([
    ['cluster_status', { description: 'mock', inputSchema: { type: 'object', properties: {} }, handler: async () => ({}) }],
    ['list_nodes', { description: 'mock', inputSchema: { type: 'object', properties: {} }, handler: async () => ({}) }],
  ])),
  ToolHandler: {},
}));

vi.mock('../../src/memory/memory-tools.js', () => ({
  createMemoryTools: vi.fn().mockReturnValue(new Map([
    ['memory_query', { description: 'mock', inputSchema: { type: 'object', properties: {} }, handler: async () => ({}) }],
    ['memory_write', { description: 'mock', inputSchema: { type: 'object', properties: {} }, handler: async () => ({}) }],
  ])),
}));

vi.mock('../../src/kubernetes/adapter.js', () => ({
  KubernetesAdapter: vi.fn().mockImplementation(() => ({
    discoverClusters: vi.fn().mockResolvedValue([]),
    listClusters: vi.fn().mockReturnValue([]),
  })),
}));

vi.mock('../../src/agent/resource-monitor.js', () => ({
  ResourceMonitor: vi.fn().mockImplementation(() => {
    const emitter = new EventEmitter();
    return Object.assign(emitter, { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn() });
  }),
}));

vi.mock('../../src/agent/task-executor.js', () => ({
  TaskExecutor: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../src/agent/health-reporter.js', () => ({
  HealthReporter: vi.fn().mockImplementation(() => {
    const emitter = new EventEmitter();
    return Object.assign(emitter, { start: vi.fn(), stop: vi.fn() });
  }),
}));

vi.mock('../../src/cluster/updater.js', () => ({
  RollingUpdater: vi.fn().mockImplementation(() => ({
    preflight: vi.fn().mockResolvedValue({ ok: true, nodes: [] }),
    execute: vi.fn().mockResolvedValue({ success: true }),
  })),
}));

vi.mock('../../src/mcp/skill-tools.js', () => ({
  createSkillTools: vi.fn().mockResolvedValue({
    tools: new Map([
      ['list_skills', { description: 'mock', inputSchema: { type: 'object', properties: {} }, handler: async () => ({}) }],
    ]),
    loader: { stop: vi.fn() },
  }),
}));

vi.mock('../../src/mcp/messaging-tools.js', () => ({
  createMessagingTools: vi.fn().mockReturnValue({
    tools: new Map([
      ['messaging_send', { description: 'mock', inputSchema: { type: 'object', properties: {} }, handler: async () => ({}) }],
    ]),
    inbox: {},
  }),
}));

function createMockContext(): PluginContext {
  return {
    raft: { isLeader: vi.fn().mockReturnValue(true), getPeers: vi.fn().mockReturnValue([]) } as any,
    membership: {
      getAllNodes: vi.fn().mockReturnValue([]),
      getActiveNodes: vi.fn().mockReturnValue([]),
      getLeaderAddress: vi.fn().mockReturnValue(null),
      getSelfNode: vi.fn().mockReturnValue(null),
      removeNode: vi.fn(),
    } as any,
    scheduler: {
      submit: vi.fn().mockResolvedValue({ accepted: true }),
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
    sharedMemoryDb: { query: vi.fn(), run: vi.fn() } as any,
    memoryReplicator: { replicateWrite: vi.fn() } as any,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    nodeId: 'test-node', sessionId: 'test-session',
    config: {}, events: new EventEmitter(),
  };
}

describe('Plugin Integration', () => {
  let loader: PluginLoader;
  let logger: any;

  beforeEach(() => {
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    loader = new PluginLoader(logger);
  });

  afterEach(async () => {
    await loader.stopAll();
  });

  it('should load all 7 plugins from the real registry', async () => {
    const allEnabled = {
      'memory': { enabled: true },
      'cluster-tools': { enabled: true },
      'kubernetes': { enabled: true },
      'resource-monitor': { enabled: true },
      'updater': { enabled: true },
      'skills': { enabled: true, directories: ['~/.cortex/skills'] },
      'messaging': { enabled: true, inboxPath: '/tmp/test-inbox' },
    };

    await loader.loadAll(allEnabled, createMockContext(), BUILTIN_PLUGINS);

    // All 7 plugins should have loaded
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      'Plugin loaded',
      expect.objectContaining({ plugin: 'memory' })
    );
  });

  it('should merge tools from all plugins', async () => {
    const allEnabled = {
      'memory': { enabled: true },
      'cluster-tools': { enabled: true },
      'kubernetes': { enabled: true },
      'resource-monitor': { enabled: true },
      'updater': { enabled: true },
      'skills': { enabled: true, directories: ['~/.cortex/skills'] },
      'messaging': { enabled: true, inboxPath: '/tmp/test-inbox' },
    };

    await loader.loadAll(allEnabled, createMockContext(), BUILTIN_PLUGINS);
    const tools = loader.getAllTools();

    // Should have tools from memory, cluster-tools, kubernetes, updater, skills, messaging
    // resource-monitor has no tools
    expect(tools.size).toBeGreaterThan(5);
    expect(tools.has('memory_query')).toBe(true);
    expect(tools.has('cluster_status')).toBe(true);
    expect(tools.has('messaging_send')).toBe(true);
    expect(tools.has('list_skills')).toBe(true);
    expect(tools.has('initiate_rolling_update')).toBe(true);
  });

  it('should merge resources from plugins', async () => {
    const allEnabled = {
      'memory': { enabled: true },
      'cluster-tools': { enabled: true },
      'kubernetes': { enabled: true },
      'resource-monitor': { enabled: true },
      'updater': { enabled: true },
      'skills': { enabled: true, directories: ['~/.cortex/skills'] },
      'messaging': { enabled: true, inboxPath: '/tmp/test-inbox' },
    };

    await loader.loadAll(allEnabled, createMockContext(), BUILTIN_PLUGINS);
    const resources = loader.getAllResources();

    // cluster-tools provides 3, kubernetes provides 1
    expect(resources.size).toBeGreaterThanOrEqual(4);
    expect(resources.has('cluster://state')).toBe(true);
    expect(resources.has('cluster://k8s')).toBe(true);
  });

  it('should complete full start/stop lifecycle', async () => {
    const allEnabled = {
      'memory': { enabled: true },
      'cluster-tools': { enabled: true },
      'kubernetes': { enabled: true },
      'resource-monitor': { enabled: true },
      'updater': { enabled: true },
      'skills': { enabled: true, directories: ['~/.cortex/skills'] },
      'messaging': { enabled: true, inboxPath: '/tmp/test-inbox' },
    };

    await loader.loadAll(allEnabled, createMockContext(), BUILTIN_PLUGINS);
    await loader.startAll();
    await loader.stopAll();

    // Should not have any errors
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('should work with only default-enabled plugins', async () => {
    const defaultConfig = {
      'memory': { enabled: true },
      'cluster-tools': { enabled: true },
      'resource-monitor': { enabled: true },
      'updater': { enabled: true },
      'skills': { enabled: false },
      'messaging': { enabled: false },
      'kubernetes': { enabled: false },
    };

    await loader.loadAll(defaultConfig, createMockContext(), BUILTIN_PLUGINS);
    const tools = loader.getAllTools();

    expect(tools.size).toBeGreaterThan(0);
    expect(tools.has('memory_query')).toBe(true);
    expect(tools.has('cluster_status')).toBe(true);
    // Disabled plugins should not contribute tools
    expect(tools.has('messaging_send')).toBe(false);
    expect(tools.has('list_skills')).toBe(false);
    expect(tools.has('k8s_list_clusters')).toBe(false);
  });
});
