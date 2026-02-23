// src/messaging/channels/telegram.ts
import { Bot } from 'grammy';
import { sequentialize } from '@grammyjs/runner';
import { apiThrottler } from '@grammyjs/transformer-throttler';
import type { Context } from 'grammy';
import type { ChannelAdapter, ChannelMessage } from '../types.js';

export interface TelegramCommand {
  command: string;
  description: string;
}

export interface TelegramAdapterConfig {
  token: string;
  commands?: TelegramCommand[];
  logger?: {
    info: (...args: any[]) => void;
    warn: (...args: any[]) => void;
    error: (...args: any[]) => void;
  };
}

type CommandHandler = (chatId: string, args: string, ctx: Context) => void | Promise<void>;

export class TelegramAdapter implements ChannelAdapter {
  readonly name = 'telegram';
  private bot: Bot;
  private connected = false;
  private messageHandlers: Array<(message: ChannelMessage) => void> = [];
  private commandHandlers: Map<string, CommandHandler> = new Map();
  private commands: TelegramCommand[];
  private logger?: TelegramAdapterConfig['logger'];

  constructor(config: TelegramAdapterConfig) {
    this.logger = config.logger;
    this.commands = config.commands ?? [];

    this.bot = new Bot(config.token);
    this.bot.api.config.use(apiThrottler());

    // Sequentialize per-chat to avoid race conditions
    this.bot.use(
      sequentialize((ctx) => {
        const chatId = ctx.chat?.id;
        return chatId ? String(chatId) : 'unknown';
      }),
    );

    // Catch all errors
    this.bot.catch((err) => {
      this.logger?.error('Telegram bot error', { error: String(err.error ?? err) });
    });

    // Register command handlers
    for (const cmd of this.commands) {
      this.bot.command(cmd.command, async (ctx) => {
        const handler = this.commandHandlers.get(cmd.command);
        if (handler) {
          const chatId = String(ctx.chat.id);
          const args = ctx.match?.trim() ?? '';
          await handler(chatId, args, ctx);
        }
      });
    }

    // Handle text messages (non-command)
    this.bot.on('message:text', (ctx) => {
      // Skip commands (they start with /)
      if (ctx.message.text.startsWith('/')) return;

      const channelMessage = this.buildChannelMessage(ctx);
      if (channelMessage) {
        for (const handler of this.messageHandlers) {
          handler(channelMessage);
        }
      }
    });

    // Handle photos
    this.bot.on('message:photo', (ctx) => {
      const channelMessage = this.buildChannelMessage(ctx);
      if (channelMessage) {
        const photo = ctx.message.photo;
        const largest = photo[photo.length - 1];
        channelMessage.media = [{
          type: 'photo',
          fileId: largest.file_id,
          fileSize: largest.file_size,
        }];
        for (const handler of this.messageHandlers) {
          handler(channelMessage);
        }
      }
    });

    // Handle documents
    this.bot.on('message:document', (ctx) => {
      const channelMessage = this.buildChannelMessage(ctx);
      if (channelMessage) {
        const doc = ctx.message.document;
        channelMessage.media = [{
          type: 'document',
          fileId: doc.file_id,
          fileName: doc.file_name,
          mimeType: doc.mime_type,
          fileSize: doc.file_size,
        }];
        for (const handler of this.messageHandlers) {
          handler(channelMessage);
        }
      }
    });

    // Handle voice messages
    this.bot.on('message:voice', (ctx) => {
      const channelMessage = this.buildChannelMessage(ctx);
      if (channelMessage) {
        const voice = ctx.message.voice;
        channelMessage.media = [{
          type: 'voice',
          fileId: voice.file_id,
          mimeType: voice.mime_type,
          fileSize: voice.file_size,
        }];
        for (const handler of this.messageHandlers) {
          handler(channelMessage);
        }
      }
    });

    // Handle audio
    this.bot.on('message:audio', (ctx) => {
      const channelMessage = this.buildChannelMessage(ctx);
      if (channelMessage) {
        const audio = ctx.message.audio;
        channelMessage.media = [{
          type: 'audio',
          fileId: audio.file_id,
          fileName: audio.file_name,
          mimeType: audio.mime_type,
          fileSize: audio.file_size,
        }];
        for (const handler of this.messageHandlers) {
          handler(channelMessage);
        }
      }
    });

    // Handle video
    this.bot.on('message:video', (ctx) => {
      const channelMessage = this.buildChannelMessage(ctx);
      if (channelMessage) {
        const video = ctx.message.video;
        channelMessage.media = [{
          type: 'video',
          fileId: video.file_id,
          fileName: video.file_name,
          mimeType: video.mime_type,
          fileSize: video.file_size,
        }];
        for (const handler of this.messageHandlers) {
          handler(channelMessage);
        }
      }
    });
  }

  private buildChannelMessage(ctx: Context): ChannelMessage | null {
    const msg = ctx.message;
    if (!msg) return null;

    return {
      channelType: 'telegram',
      channelId: String(msg.chat.id),
      userId: String(msg.from?.id ?? 'unknown'),
      username: msg.from?.username ?? msg.from?.first_name ?? 'unknown',
      content: msg.text ?? msg.caption ?? '',
      timestamp: new Date(msg.date * 1000).toISOString(),
      replyTo: msg.reply_to_message ? String(msg.reply_to_message.message_id) : undefined,
    };
  }

  async connect(): Promise<void> {
    this.logger?.info('Telegram adapter starting with grammY');

    // Register commands with Telegram
    if (this.commands.length > 0) {
      await this.bot.api.deleteMyCommands().catch(() => {});
      await this.bot.api.setMyCommands(this.commands);
    }

    this.bot.start({
      onStart: () => {
        this.logger?.info('Telegram bot polling started');
      },
    });
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.logger?.info('Telegram adapter stopping');
    await this.bot.stop();
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  onMessage(handler: (message: ChannelMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  onCommand(name: string, handler: CommandHandler): void {
    this.commandHandlers.set(name, handler);
  }

  async sendMessage(channelId: string, content: string, replyTo?: string): Promise<void> {
    const options: Record<string, unknown> = { parse_mode: 'HTML' };
    if (replyTo) {
      options.reply_to_message_id = parseInt(replyTo, 10);
    }
    try {
      await this.bot.api.sendMessage(channelId, content, options);
    } catch (err) {
      // If HTML parsing fails, retry without parse_mode
      const errMsg = err instanceof Error ? err.message : String(err);
      if (/can't parse entities|parse entities/i.test(errMsg)) {
        this.logger?.warn('HTML parse failed, retrying as plain text');
        const plainOptions: Record<string, unknown> = {};
        if (replyTo) plainOptions.reply_to_message_id = parseInt(replyTo, 10);
        await this.bot.api.sendMessage(channelId, content, plainOptions);
      } else {
        throw err;
      }
    }
  }

  async sendTyping(channelId: string): Promise<void> {
    await this.bot.api.sendChatAction(channelId, 'typing');
  }

  async sendPhoto(channelId: string, fileId: string, caption?: string): Promise<void> {
    const options: Record<string, unknown> = {};
    if (caption) {
      options.caption = caption;
      options.parse_mode = 'HTML';
    }
    await this.bot.api.sendPhoto(channelId, fileId, options);
  }

  async sendDocument(channelId: string, fileId: string, caption?: string): Promise<void> {
    const options: Record<string, unknown> = {};
    if (caption) {
      options.caption = caption;
      options.parse_mode = 'HTML';
    }
    await this.bot.api.sendDocument(channelId, fileId, options);
  }

  /** Download a file by file_id. Returns a URL to fetch from. */
  async getFileUrl(fileId: string): Promise<string> {
    const file = await this.bot.api.getFile(fileId);
    if (!file.file_path) throw new Error('No file_path returned from Telegram');
    return `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`;
  }
}
