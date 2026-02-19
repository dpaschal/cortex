// src/mcp/messaging-tools.ts
import type { ToolHandler } from '../plugins/types.js';
import { Inbox } from '../messaging/inbox.js';

export interface MessagingToolsConfig {
  inboxPath: string;
}

export function createMessagingTools(config: MessagingToolsConfig): { tools: Map<string, ToolHandler>; inbox: Inbox } {
  const inbox = new Inbox(config.inboxPath);
  const tools = new Map<string, ToolHandler>();

  tools.set('messaging_send', {
    description: 'Send a message to the messaging inbox (Discord, Telegram, or inter-agent)',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Sender identifier (e.g., claudecode, cipher)' },
        to: { type: 'string', description: 'Recipient identifier' },
        content: { type: 'string', description: 'Message content' },
        type: { type: 'string', description: 'Message type', enum: ['info', 'question', 'task', 'response', 'error'] },
        threadId: { type: 'string', description: 'Optional thread/conversation ID' },
      },
      required: ['from', 'to', 'content', 'type'],
    },
    handler: async (args) => {
      const messageId = await inbox.writeMessage({
        from: args.from as string,
        to: args.to as string,
        content: args.content as string,
        type: args.type as 'info' | 'question' | 'task' | 'response' | 'error',
        threadId: args.threadId as string | undefined,
      });
      return { messageId, status: 'sent' };
    },
  });

  tools.set('messaging_check', {
    description: 'Check for new unread messages in the inbox',
    inputSchema: {
      type: 'object',
      properties: {
        staleThresholdMinutes: { type: 'number', description: 'Minutes after which a message is stale (default: 30)' },
      },
    },
    handler: async (args) => {
      const threshold = (args.staleThresholdMinutes as number) ?? 30;
      const messages = await inbox.getNewMessages();
      const now = Date.now();

      return {
        count: messages.length,
        messages: messages.map(msg => ({
          ...msg,
          stale: (now - new Date(msg.timestamp).getTime()) > threshold * 60 * 1000,
        })),
      };
    },
  });

  tools.set('messaging_list', {
    description: 'List all message/conversation IDs in the inbox',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const conversations = await inbox.listMessages();
      return { conversations, count: conversations.length };
    },
  });

  tools.set('messaging_get', {
    description: 'Retrieve a specific message by ID',
    inputSchema: {
      type: 'object',
      properties: {
        messageId: { type: 'string', description: 'The message ID to retrieve' },
      },
      required: ['messageId'],
    },
    handler: async (args) => {
      const message = await inbox.readMessage(args.messageId as string);
      return { message };
    },
  });

  tools.set('messaging_gateway_status', {
    description: 'Get the status of the messaging gateway (connected channels, leader node)',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      return {
        status: 'not_initialized',
        channels: [],
        leaderNode: null,
      };
    },
  });

  return { tools, inbox };
}
