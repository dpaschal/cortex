import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PluginLoader } from '../../src/plugins/loader.js';
import { Plugin, PluginContext, ToolHandler, ResourceHandler } from '../../src/plugins/types.js';
import { EventEmitter } from 'events';
import { Logger } from 'winston';

function createMockLogger(): Logger {
  return {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  } as unknown as Logger;
}

function createMockContext(overrides: Partial<PluginContext> = {}): PluginContext {
  return {
    raft: {} as any, membership: {} as any, scheduler: {} as any,
    stateManager: {} as any, clientPool: {} as any,
    sharedMemoryDb: {} as any, memoryReplicator: {} as any,
    logger: createMockLogger(), nodeId: 'test-node', sessionId: 'test-session',
    config: {}, events: new EventEmitter(),
    ...overrides,
  };
}

function createMockPlugin(name: string, overrides: Partial<Plugin> = {}): Plugin {
  const tools = new Map<string, ToolHandler>();
  tools.set(`${name}_tool`, {
    description: `Tool from ${name}`,
    inputSchema: { type: 'object' as const, properties: {} },
    handler: async () => ({ ok: true }),
  });
  return {
    name, version: '1.0.0',
    init: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    getTools: () => tools,
    ...overrides,
  };
}

describe('PluginLoader', () => {
  let loader: PluginLoader;
  let logger: Logger;

  beforeEach(() => {
    logger = createMockLogger();
    loader = new PluginLoader(logger);
  });

  describe('loadAll', () => {
    it('should load enabled plugins from registry', async () => {
      const pluginA = createMockPlugin('alpha');
      const registry = { alpha: async () => pluginA };
      const pluginsConfig = { alpha: { enabled: true } };
      const ctx = createMockContext();

      await loader.loadAll(pluginsConfig, ctx, registry);

      expect(pluginA.init).toHaveBeenCalledWith(
        expect.objectContaining({ nodeId: 'test-node', config: { enabled: true } })
      );
    });

    it('should skip disabled plugins', async () => {
      const pluginA = createMockPlugin('alpha');
      const registry = { alpha: async () => pluginA };
      const pluginsConfig = { alpha: { enabled: false } };
      const ctx = createMockContext();

      await loader.loadAll(pluginsConfig, ctx, registry);
      expect(pluginA.init).not.toHaveBeenCalled();
    });

    it('should skip plugins not in registry', async () => {
      const registry = {};
      const pluginsConfig = { unknown: { enabled: true } };
      const ctx = createMockContext();

      await loader.loadAll(pluginsConfig, ctx, registry);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('not found in registry'),
        expect.objectContaining({ plugin: 'unknown' })
      );
    });

    it('should catch and log init failures without crashing', async () => {
      const badPlugin = createMockPlugin('bad');
      badPlugin.init = vi.fn().mockRejectedValue(new Error('init boom'));
      const registry = { bad: async () => badPlugin };
      const pluginsConfig = { bad: { enabled: true } };
      const ctx = createMockContext();

      await loader.loadAll(pluginsConfig, ctx, registry);
      expect(logger.error).toHaveBeenCalled();
      expect(loader.getAllTools().size).toBe(0);
    });
  });

  describe('getAllTools', () => {
    it('should merge tools from all loaded plugins', async () => {
      const pluginA = createMockPlugin('alpha');
      const pluginB = createMockPlugin('beta');
      const registry = { alpha: async () => pluginA, beta: async () => pluginB };
      const pluginsConfig = { alpha: { enabled: true }, beta: { enabled: true } };
      const ctx = createMockContext();

      await loader.loadAll(pluginsConfig, ctx, registry);
      const tools = loader.getAllTools();
      expect(tools.has('alpha_tool')).toBe(true);
      expect(tools.has('beta_tool')).toBe(true);
      expect(tools.size).toBe(2);
    });
  });

  describe('getAllResources', () => {
    it('should merge resources from all loaded plugins', async () => {
      const resources = new Map<string, ResourceHandler>();
      resources.set('cluster://test', {
        uri: 'cluster://test', name: 'Test', description: 'Test resource',
        mimeType: 'application/json', handler: async () => ({}),
      });
      const plugin = createMockPlugin('res');
      plugin.getResources = () => resources;
      const registry = { res: async () => plugin };
      const pluginsConfig = { res: { enabled: true } };
      const ctx = createMockContext();

      await loader.loadAll(pluginsConfig, ctx, registry);
      expect(loader.getAllResources().has('cluster://test')).toBe(true);
    });
  });

  describe('startAll / stopAll', () => {
    it('should start all loaded plugins', async () => {
      const plugin = createMockPlugin('alpha');
      const registry = { alpha: async () => plugin };
      const pluginsConfig = { alpha: { enabled: true } };
      const ctx = createMockContext();

      await loader.loadAll(pluginsConfig, ctx, registry);
      await loader.startAll();
      expect(plugin.start).toHaveBeenCalled();
    });

    it('should stop plugins in reverse order', async () => {
      const order: string[] = [];
      const pluginA = createMockPlugin('alpha');
      pluginA.stop = vi.fn().mockImplementation(async () => { order.push('alpha'); });
      const pluginB = createMockPlugin('beta');
      pluginB.stop = vi.fn().mockImplementation(async () => { order.push('beta'); });

      const registry = { alpha: async () => pluginA, beta: async () => pluginB };
      const pluginsConfig = { alpha: { enabled: true }, beta: { enabled: true } };
      const ctx = createMockContext();

      await loader.loadAll(pluginsConfig, ctx, registry);
      await loader.stopAll();
      expect(order).toEqual(['beta', 'alpha']);
    });

    it('should catch and log start failures without crashing', async () => {
      const plugin = createMockPlugin('bad');
      plugin.start = vi.fn().mockRejectedValue(new Error('start boom'));
      const registry = { bad: async () => plugin };
      const pluginsConfig = { bad: { enabled: true } };
      const ctx = createMockContext();

      await loader.loadAll(pluginsConfig, ctx, registry);
      await loader.startAll();
      expect(logger.error).toHaveBeenCalled();
    });
  });
});
