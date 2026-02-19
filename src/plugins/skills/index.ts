import { Plugin, PluginContext, ToolHandler } from '../types.js';

export class SkillsPlugin implements Plugin {
  name = 'skills';
  version = '1.0.0';

  private tools: Map<string, ToolHandler> = new Map();
  private loader: any = null;

  async init(ctx: PluginContext): Promise<void> {
    const { createSkillTools } = await import('../../mcp/skill-tools.js');
    const directories = (ctx.config.directories as string[]) ?? ['~/.cortex/skills'];

    const result = await createSkillTools({ directories });
    this.tools = result.tools;
    this.loader = result.loader;
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {
    if (this.loader && typeof this.loader.stop === 'function') {
      this.loader.stop();
    }
    this.loader = null;
  }

  getTools(): Map<string, ToolHandler> {
    return this.tools;
  }
}
