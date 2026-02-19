import { Plugin, PluginContext, ToolHandler } from '../types.js';
import { createMemoryTools } from '../../memory/memory-tools.js';

export class MemoryPlugin implements Plugin {
  name = 'memory';
  version = '1.0.0';

  private tools: Map<string, ToolHandler> = new Map();

  async init(ctx: PluginContext): Promise<void> {
    this.tools = createMemoryTools({
      db: ctx.sharedMemoryDb,
      replicator: ctx.memoryReplicator,
      raft: ctx.raft,
      nodeId: ctx.nodeId,
      logger: ctx.logger,
    });
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  getTools(): Map<string, ToolHandler> {
    return this.tools;
  }
}
