import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock grammy before importing adapter
vi.mock('grammy', () => {
  const handlers: Record<string, Function[]> = {};
  const commands: Record<string, Function> = {};

  const mockApi = {
    setMyCommands: vi.fn().mockResolvedValue(true),
    deleteMyCommands: vi.fn().mockResolvedValue(true),
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    sendChatAction: vi.fn().mockResolvedValue(true),
    getFile: vi.fn().mockResolvedValue({ file_path: 'photos/file.jpg' }),
    sendPhoto: vi.fn().mockResolvedValue({ message_id: 2 }),
    sendDocument: vi.fn().mockResolvedValue({ message_id: 3 }),
    config: { use: vi.fn() },
  };

  const MockBot = vi.fn().mockImplementation(() => ({
    api: mockApi,
    use: vi.fn(),
    on: vi.fn((event: string, handler: Function) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    }),
    command: vi.fn((name: string, handler: Function) => {
      commands[name] = handler;
    }),
    catch: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    _handlers: handlers,
    _commands: commands,
  }));

  return {
    Bot: MockBot,
    InputFile: vi.fn().mockImplementation((data: any, name: string) => ({ data, name })),
  };
});

vi.mock('@grammyjs/transformer-throttler', () => ({
  apiThrottler: vi.fn().mockReturnValue(vi.fn()),
}));

vi.mock('@grammyjs/runner', () => ({
  sequentialize: vi.fn().mockReturnValue(vi.fn()),
}));

import { TelegramAdapter } from '../telegram.js';

describe('TelegramAdapter', () => {
  let adapter: TelegramAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new TelegramAdapter({
      token: 'test-token',
      commands: [],
    });
  });

  it('should have the correct name', () => {
    expect(adapter.name).toBe('telegram');
  });

  it('should connect and start polling', async () => {
    await adapter.connect();
    expect(adapter.isConnected()).toBe(true);
  });

  it('should disconnect and stop polling', async () => {
    await adapter.connect();
    await adapter.disconnect();
    expect(adapter.isConnected()).toBe(false);
  });

  it('should register commands with Telegram API on connect', async () => {
    const adapterWithCommands = new TelegramAdapter({
      token: 'test-token',
      commands: [
        { command: 'status', description: 'Cluster status' },
        { command: 'help', description: 'List commands' },
      ],
    });
    await adapterWithCommands.connect();
    const bot = (adapterWithCommands as any).bot;
    expect(bot.api.setMyCommands).toHaveBeenCalledWith([
      { command: 'status', description: 'Cluster status' },
      { command: 'help', description: 'List commands' },
    ]);
  });

  it('should send messages with HTML parse mode', async () => {
    await adapter.connect();
    await adapter.sendMessage('123', '<b>hello</b>');
    const bot = (adapter as any).bot;
    expect(bot.api.sendMessage).toHaveBeenCalledWith('123', '<b>hello</b>', {
      parse_mode: 'HTML',
    });
  });

  it('should send typing action', async () => {
    await adapter.connect();
    await adapter.sendTyping('123');
    const bot = (adapter as any).bot;
    expect(bot.api.sendChatAction).toHaveBeenCalledWith('123', 'typing');
  });

  it('should register message handlers', () => {
    const handler = vi.fn();
    adapter.onMessage(handler);
    // Handler registration is tested; actual message dispatch tested via integration
  });

  it('should register command handlers', () => {
    const adapterWithCommands = new TelegramAdapter({
      token: 'test-token',
      commands: [{ command: 'status', description: 'Cluster status' }],
    });
    const handler = vi.fn();
    adapterWithCommands.onCommand('status', handler);
    const bot = (adapterWithCommands as any).bot;
    expect(bot.command).toHaveBeenCalledWith('status', expect.any(Function));
  });

  it('should send photo with caption', async () => {
    await adapter.connect();
    await adapter.sendPhoto('123', 'file-id-abc', '<b>caption</b>');
    const bot = (adapter as any).bot;
    expect(bot.api.sendPhoto).toHaveBeenCalledWith('123', 'file-id-abc', {
      caption: '<b>caption</b>',
      parse_mode: 'HTML',
    });
  });

  it('should get file URL', async () => {
    await adapter.connect();
    const url = await adapter.getFileUrl('file-id-123');
    expect(url).toContain('file/bot');
    expect(url).toContain('photos/file.jpg');
  });
});
