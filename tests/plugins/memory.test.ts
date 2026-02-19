import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryPlugin } from '../../src/plugins/memory/index.js';
import { PluginContext } from '../../src/plugins/types.js';
import { EventEmitter } from 'events';

vi.mock('../../src/memory/memory-tools.js', () => ({
  createMemoryTools: vi.fn().mockReturnValue(new Map([
    ['memory_query', { description: 'mock', inputSchema: { type: 'object', properties: {} }, handler: async () => ({}) }],
    ['memory_write', { description: 'mock', inputSchema: { type: 'object', properties: {} }, handler: async () => ({}) }],
    ['memory_log_thought', { description: 'mock', inputSchema: { type: 'object', properties: {} }, handler: async () => ({}) }],
    ['memory_whereami', { description: 'mock', inputSchema: { type: 'object', properties: {} }, handler: async () => ({}) }],
  ])),
}));

function createMockContext(config: Record<string, unknown> = {}): PluginContext {
  return {
    raft: { isLeader: vi.fn().mockReturnValue(true) } as any,
    membership: {} as any,
    scheduler: {} as any,
    stateManager: {} as any,
    clientPool: {} as any,
    sharedMemoryDb: { query: vi.fn(), run: vi.fn() } as any,
    memoryReplicator: { replicateWrite: vi.fn() } as any,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    nodeId: 'test-node',
    sessionId: 'test-session',
    config: { enabled: true, ...config },
    events: new EventEmitter(),
  };
}

describe('MemoryPlugin', () => {
  let plugin: MemoryPlugin;

  beforeEach(() => {
    vi.clearAllMocks();
    plugin = new MemoryPlugin();
  });

  it('should have correct name and version', () => {
    expect(plugin.name).toBe('memory');
    expect(plugin.version).toBe('1.0.0');
  });

  it('should initialize and expose memory tools', async () => {
    const ctx = createMockContext();
    await plugin.init(ctx);

    const tools = plugin.getTools();
    expect(tools).toBeDefined();
    expect(tools.size).toBeGreaterThan(0);
    expect(tools.has('memory_query')).toBe(true);
    expect(tools.has('memory_whereami')).toBe(true);
  });

  it('should pass db and replicator to createMemoryTools', async () => {
    const { createMemoryTools } = await import('../../src/memory/memory-tools.js');
    const ctx = createMockContext();
    await plugin.init(ctx);

    expect(createMemoryTools).toHaveBeenCalledWith(
      expect.objectContaining({
        db: ctx.sharedMemoryDb,
        replicator: ctx.memoryReplicator,
      })
    );
  });

  it('should start and stop without error', async () => {
    await plugin.init(createMockContext());
    await plugin.start();
    await plugin.stop();
  });
});
