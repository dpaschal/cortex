import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessagingPlugin } from '../../src/plugins/messaging/index.js';
import { PluginContext } from '../../src/plugins/types.js';
import { EventEmitter } from 'events';

vi.mock('../../src/mcp/messaging-tools.js', () => ({
  createMessagingTools: vi.fn().mockReturnValue({
    tools: new Map([
      ['messaging_send', { description: 'mock', inputSchema: { type: 'object', properties: {} }, handler: async () => ({}) }],
      ['messaging_check', { description: 'mock', inputSchema: { type: 'object', properties: {} }, handler: async () => ({}) }],
      ['messaging_list', { description: 'mock', inputSchema: { type: 'object', properties: {} }, handler: async () => ({}) }],
      ['messaging_get', { description: 'mock', inputSchema: { type: 'object', properties: {} }, handler: async () => ({}) }],
      ['messaging_gateway_status', { description: 'mock', inputSchema: { type: 'object', properties: {} }, handler: async () => ({}) }],
    ]),
    inbox: {},
  }),
}));

function createMockContext(config: Record<string, unknown> = {}): PluginContext {
  return {
    raft: {} as any, membership: {} as any, scheduler: {} as any,
    stateManager: {} as any, clientPool: {} as any,
    sharedMemoryDb: {} as any, memoryReplicator: {} as any,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    nodeId: 'test-node', sessionId: 'test-session',
    config: { enabled: true, inboxPath: '/tmp/test-inbox', ...config },
    events: new EventEmitter(),
  };
}

describe('MessagingPlugin', () => {
  let plugin: MessagingPlugin;

  beforeEach(() => {
    vi.clearAllMocks();
    plugin = new MessagingPlugin();
  });

  it('should have correct name and version', () => {
    expect(plugin.name).toBe('messaging');
    expect(plugin.version).toBe('1.0.0');
  });

  it('should initialize and expose messaging tools', async () => {
    await plugin.init(createMockContext());
    const tools = plugin.getTools!();
    expect(tools.size).toBe(5);
    expect(tools.has('messaging_send')).toBe(true);
    expect(tools.has('messaging_check')).toBe(true);
    expect(tools.has('messaging_list')).toBe(true);
    expect(tools.has('messaging_get')).toBe(true);
    expect(tools.has('messaging_gateway_status')).toBe(true);
  });

  it('should pass inboxPath to createMessagingTools', async () => {
    const { createMessagingTools } = await import('../../src/mcp/messaging-tools.js');
    await plugin.init(createMockContext({ inboxPath: '/custom/inbox' }));
    expect(createMessagingTools).toHaveBeenCalledWith({ inboxPath: '/custom/inbox' });
  });

  it('should start and stop without error', async () => {
    await plugin.init(createMockContext());
    await plugin.start();
    await plugin.stop();
  });
});
