import { Plugin, PluginContext, ToolHandler } from '../types.js';

export class MessagingPlugin implements Plugin {
  name = 'messaging';
  version = '1.0.0';

  private tools: Map<string, ToolHandler> = new Map();
  private inbox: any = null;

  async init(ctx: PluginContext): Promise<void> {
    const { createMessagingTools } = await import('../../mcp/messaging-tools.js');
    const inboxPath = (ctx.config.inboxPath as string) ?? '~/.cortex/inbox';

    const result = createMessagingTools({ inboxPath });
    this.tools = result.tools;
    this.inbox = result.inbox;
  }

  async start(): Promise<void> {
    // MessagingGateway (Discord/Telegram) activation is leader-only
    // and requires channel config — deferred to a future enhancement.
    // For now, the inbox-based tools work on all nodes.
  }

  async stop(): Promise<void> {
    this.inbox = null;
  }

  getTools(): Map<string, ToolHandler> {
    return this.tools;
  }
}
