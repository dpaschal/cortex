import { Logger } from 'winston';
import { Plugin, PluginContext, PluginsConfig, ToolHandler, ResourceHandler } from './types.js';

export type PluginFactory = () => Promise<Plugin>;
export type PluginRegistry = Record<string, PluginFactory>;

export class PluginLoader {
  private plugins: Plugin[] = [];
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  async loadAll(
    pluginsConfig: PluginsConfig,
    baseCtx: PluginContext,
    registry: PluginRegistry,
  ): Promise<void> {
    for (const [name, entry] of Object.entries(pluginsConfig)) {
      if (!entry.enabled) {
        this.logger.debug('Plugin disabled, skipping', { plugin: name });
        continue;
      }

      const factory = registry[name];
      if (!factory) {
        this.logger.warn('Plugin not found in registry, skipping', { plugin: name });
        continue;
      }

      try {
        const plugin = await factory();
        const ctx: PluginContext = { ...baseCtx, config: entry };
        await plugin.init(ctx);
        this.plugins.push(plugin);
        this.logger.info('Plugin loaded', { plugin: name, version: plugin.version });
      } catch (error) {
        this.logger.error('Plugin init failed, skipping', {
          plugin: name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  getAllTools(): Map<string, ToolHandler> {
    const merged = new Map<string, ToolHandler>();
    for (const plugin of this.plugins) {
      if (plugin.getTools) {
        for (const [name, handler] of plugin.getTools()) {
          merged.set(name, handler);
        }
      }
    }
    return merged;
  }

  getAllResources(): Map<string, ResourceHandler> {
    const merged = new Map<string, ResourceHandler>();
    for (const plugin of this.plugins) {
      if (plugin.getResources) {
        for (const [name, handler] of plugin.getResources()) {
          merged.set(name, handler);
        }
      }
    }
    return merged;
  }

  async startAll(): Promise<void> {
    for (const plugin of this.plugins) {
      try {
        await plugin.start();
        this.logger.info('Plugin started', { plugin: plugin.name });
      } catch (error) {
        this.logger.error('Plugin start failed', {
          plugin: plugin.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async stopAll(): Promise<void> {
    const reversed = [...this.plugins].reverse();
    for (const plugin of reversed) {
      try {
        await plugin.stop();
        this.logger.info('Plugin stopped', { plugin: plugin.name });
      } catch (error) {
        this.logger.error('Plugin stop failed', {
          plugin: plugin.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
