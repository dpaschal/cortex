# Cipher OpenClaw Feature Parity Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the minimal Telegram bot adapter with a grammY-based bot that has slash commands, rich formatting, media handling, inline buttons, typing indicators, and CSM-backed session persistence.

**Architecture:** grammY `Bot` instance with throttler + sequentializer middleware, managed by the existing `MessagingPlugin`. Slash commands map directly to Cortex MCP tools (no LLM roundtrip). Free-text messages go through `ConversationHandler` with tool loop. History persisted in shared memory `bot_conversations` table.

**Tech Stack:** grammY 4.x, @grammyjs/runner, @grammyjs/transformer-throttler, Cortex shared memory (SQLite via Raft), vitest

---

## Prerequisites

- Working directory: `/home/paschal/claudecluster`
- Test command: `npx vitest run` (all tests) or `npx vitest run <path>` (specific file)
- Build command: `npm run build`
- grammY docs: https://grammy.dev/

---

### Task 1: Install grammY and remove node-telegram-bot-api

**Files:**
- Modify: `package.json`

**Step 1: Install grammY packages**

Run:
```bash
cd /home/paschal/claudecluster && npm install grammy @grammyjs/runner @grammyjs/transformer-throttler
```

**Step 2: Remove old Telegram library**

Run:
```bash
npm uninstall node-telegram-bot-api @types/node-telegram-bot-api
```

**Step 3: Verify build still compiles**

Run: `npm run build`
Expected: Compilation errors in `src/messaging/channels/telegram.ts` and its test (expected — we're about to rewrite them).

**Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "deps: replace node-telegram-bot-api with grammy"
```

---

### Task 2: Create Markdown-to-Telegram-HTML formatter

**Files:**
- Create: `src/messaging/format.ts`
- Create: `src/messaging/__tests__/format.test.ts`

**Step 1: Write the failing tests**

File: `src/messaging/__tests__/format.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { markdownToTelegramHtml, smartChunk } from '../format.js';

describe('markdownToTelegramHtml', () => {
  it('should escape HTML entities', () => {
    expect(markdownToTelegramHtml('a < b > c & d')).toBe('a &lt; b &gt; c &amp; d');
  });

  it('should convert bold', () => {
    expect(markdownToTelegramHtml('**bold**')).toBe('<b>bold</b>');
  });

  it('should convert italic', () => {
    expect(markdownToTelegramHtml('*italic*')).toBe('<i>italic</i>');
  });

  it('should convert inline code', () => {
    expect(markdownToTelegramHtml('use `foo()` here')).toBe('use <code>foo()</code> here');
  });

  it('should convert code blocks', () => {
    const input = '```js\nconst x = 1;\n```';
    expect(markdownToTelegramHtml(input)).toBe('<pre><code>const x = 1;</code></pre>');
  });

  it('should convert code blocks without language tag', () => {
    const input = '```\nhello\n```';
    expect(markdownToTelegramHtml(input)).toBe('<pre><code>hello</code></pre>');
  });

  it('should convert links', () => {
    expect(markdownToTelegramHtml('[click](https://example.com)')).toBe(
      '<a href="https://example.com">click</a>'
    );
  });

  it('should convert strikethrough', () => {
    expect(markdownToTelegramHtml('~~deleted~~')).toBe('<s>deleted</s>');
  });

  it('should handle nested bold and italic', () => {
    expect(markdownToTelegramHtml('***bold italic***')).toBe('<b><i>bold italic</i></b>');
  });

  it('should pass through plain text unchanged (except escaping)', () => {
    expect(markdownToTelegramHtml('hello world')).toBe('hello world');
  });

  it('should not convert underscores inside words', () => {
    expect(markdownToTelegramHtml('foo_bar_baz')).toBe('foo_bar_baz');
  });

  it('should handle empty input', () => {
    expect(markdownToTelegramHtml('')).toBe('');
  });

  it('should escape HTML inside code spans', () => {
    expect(markdownToTelegramHtml('`<div>`')).toBe('<code>&lt;div&gt;</code>');
  });

  it('should escape HTML inside code blocks', () => {
    const input = '```\n<script>alert("xss")</script>\n```';
    expect(markdownToTelegramHtml(input)).toBe(
      '<pre><code>&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;</code></pre>'
    );
  });
});

describe('smartChunk', () => {
  it('should return single chunk for short text', () => {
    expect(smartChunk('hello', 4096)).toEqual(['hello']);
  });

  it('should split at paragraph boundary', () => {
    const a = 'a'.repeat(2000);
    const b = 'b'.repeat(2000);
    const text = `${a}\n\n${b}`;
    const chunks = smartChunk(text, 4096);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(a);
    expect(chunks[1]).toBe(b);
  });

  it('should split at line boundary when no paragraph break', () => {
    const a = 'a'.repeat(3000);
    const b = 'b'.repeat(3000);
    const text = `${a}\n${b}`;
    const chunks = smartChunk(text, 4096);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(a);
    expect(chunks[1]).toBe(b);
  });

  it('should hard split when no newlines', () => {
    const text = 'x'.repeat(8192);
    const chunks = smartChunk(text, 4096);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].length).toBe(4096);
    expect(chunks[1].length).toBe(4096);
  });

  it('should handle empty input', () => {
    expect(smartChunk('', 4096)).toEqual(['']);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/messaging/__tests__/format.test.ts`
Expected: FAIL — module `../format.js` not found

**Step 3: Write the implementation**

File: `src/messaging/format.ts`

```typescript
// src/messaging/format.ts
// Self-contained Markdown → Telegram HTML converter.
// Supports: bold, italic, bold-italic, code, code blocks, links, strikethrough.
// Does NOT depend on OpenClaw's markdown IR library.

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function markdownToTelegramHtml(markdown: string): string {
  if (!markdown) return '';

  // Extract code blocks first to protect them from inline formatting
  const codeBlocks: string[] = [];
  let text = markdown.replace(/```(?:\w*)\n?([\s\S]*?)```/g, (_match, code: string) => {
    const trimmed = code.replace(/\n$/, '');
    const placeholder = `\x00CB${codeBlocks.length}\x00`;
    codeBlocks.push(`<pre><code>${escapeHtml(trimmed)}</code></pre>`);
    return placeholder;
  });

  // Extract inline code to protect from further processing
  const inlineCode: string[] = [];
  text = text.replace(/`([^`]+)`/g, (_match, code: string) => {
    const placeholder = `\x00IC${inlineCode.length}\x00`;
    inlineCode.push(`<code>${escapeHtml(code)}</code>`);
    return placeholder;
  });

  // Escape HTML in remaining text
  text = escapeHtml(text);

  // Bold+italic (***text*** or ___text___)
  text = text.replace(/\*{3}(.+?)\*{3}/g, '<b><i>$1</i></b>');

  // Bold (**text**)
  text = text.replace(/\*{2}(.+?)\*{2}/g, '<b>$1</b>');

  // Italic (*text*) — but not inside words (foo*bar*baz)
  text = text.replace(/(?<![a-zA-Z0-9])\*(.+?)\*(?![a-zA-Z0-9])/g, '<i>$1</i>');

  // Strikethrough (~~text~~)
  text = text.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // Links [text](url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Restore inline code
  text = text.replace(/\x00IC(\d+)\x00/g, (_match, idx: string) => inlineCode[parseInt(idx, 10)]);

  // Restore code blocks
  text = text.replace(/\x00CB(\d+)\x00/g, (_match, idx: string) => codeBlocks[parseInt(idx, 10)]);

  return text;
}

/**
 * Split text into chunks respecting Telegram's message size limit.
 * Tries paragraph boundaries first, then line boundaries, then hard split.
 */
export function smartChunk(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try paragraph boundary
    let splitAt = remaining.lastIndexOf('\n\n', maxLength);
    if (splitAt < maxLength / 2) {
      // Try line boundary
      splitAt = remaining.lastIndexOf('\n', maxLength);
    }
    if (splitAt < maxLength / 2) {
      // Hard split
      splitAt = maxLength;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, '');
  }

  return chunks;
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/messaging/__tests__/format.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/messaging/format.ts src/messaging/__tests__/format.test.ts
git commit -m "feat(messaging): add Markdown-to-Telegram-HTML formatter with smart chunking"
```

---

### Task 3: Create the bot_conversations CSM table and persistence helpers

**Files:**
- Create: `src/messaging/persistence.ts`
- Create: `src/messaging/__tests__/persistence.test.ts`

**Step 1: Write the failing tests**

File: `src/messaging/__tests__/persistence.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConversationStore } from '../persistence.js';
import type { ChatMessage } from '../../providers/types.js';
import Database from 'better-sqlite3';

function createInMemoryDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  return db;
}

describe('ConversationStore', () => {
  let db: Database.Database;
  let store: ConversationStore;

  beforeEach(() => {
    db = createInMemoryDb();
    store = new ConversationStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('should create the bot_conversations table on construction', () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='bot_conversations'"
    ).all();
    expect(tables).toHaveLength(1);
  });

  it('should return empty array for unknown chat', () => {
    expect(store.load('unknown-chat')).toEqual([]);
  });

  it('should save and load history', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ];
    store.save('chat-1', history);
    expect(store.load('chat-1')).toEqual(history);
  });

  it('should overwrite existing history on save', () => {
    store.save('chat-1', [{ role: 'user', content: 'first' }]);
    store.save('chat-1', [{ role: 'user', content: 'second' }]);
    const loaded = store.load('chat-1');
    expect(loaded).toHaveLength(1);
    expect(loaded[0].content).toBe('second');
  });

  it('should clear history for a chat', () => {
    store.save('chat-1', [{ role: 'user', content: 'hello' }]);
    store.clear('chat-1');
    expect(store.load('chat-1')).toEqual([]);
  });

  it('should not affect other chats on clear', () => {
    store.save('chat-1', [{ role: 'user', content: 'a' }]);
    store.save('chat-2', [{ role: 'user', content: 'b' }]);
    store.clear('chat-1');
    expect(store.load('chat-1')).toEqual([]);
    expect(store.load('chat-2')).toHaveLength(1);
  });

  it('should handle ContentBlock arrays in history', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'checking' },
          { type: 'tool_use', id: 'tc-1', name: 'status', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tc-1', content: '{"ok":true}' },
        ],
      },
    ];
    store.save('chat-1', history);
    expect(store.load('chat-1')).toEqual(history);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/messaging/__tests__/persistence.test.ts`
Expected: FAIL — module `../persistence.js` not found

**Step 3: Write the implementation**

File: `src/messaging/persistence.ts`

```typescript
// src/messaging/persistence.ts
// CSM-backed conversation history persistence for the Telegram bot.
import type Database from 'better-sqlite3';
import type { ChatMessage } from '../providers/types.js';

export class ConversationStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bot_conversations (
        chat_id TEXT PRIMARY KEY,
        history TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
  }

  load(chatId: string): ChatMessage[] {
    const row = this.db.prepare(
      'SELECT history FROM bot_conversations WHERE chat_id = ?'
    ).get(chatId) as { history: string } | undefined;
    if (!row) return [];
    try {
      return JSON.parse(row.history);
    } catch {
      return [];
    }
  }

  save(chatId: string, history: ChatMessage[]): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO bot_conversations (chat_id, history, updated_at)
       VALUES (?, ?, datetime('now'))`
    ).run(chatId, JSON.stringify(history));
  }

  clear(chatId: string): void {
    this.db.prepare('DELETE FROM bot_conversations WHERE chat_id = ?').run(chatId);
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/messaging/__tests__/persistence.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/messaging/persistence.ts src/messaging/__tests__/persistence.test.ts
git commit -m "feat(messaging): add CSM-backed conversation persistence"
```

---

### Task 4: Extend ConversationHandler with CSM persistence and typing callback

**Files:**
- Modify: `src/messaging/conversation.ts`
- Modify: `src/messaging/__tests__/conversation.test.ts`

**Step 1: Write failing tests for new features**

Append to `src/messaging/__tests__/conversation.test.ts`:

```typescript
  // -------------------------------------------------------------------------
  // 9. CSM persistence
  // -------------------------------------------------------------------------
  describe('CSM persistence', () => {
    it('should load history from store on first message', async () => {
      const chatFn = vi.fn().mockResolvedValue(textResponse('hi'));
      const provider = createMockProvider(chatFn);
      const store = {
        load: vi.fn().mockReturnValue([
          { role: 'user', content: 'previous' },
          { role: 'assistant', content: 'prev reply' },
        ]),
        save: vi.fn(),
        clear: vi.fn(),
      };

      const handler = new ConversationHandler({
        provider,
        tools: new Map(),
        logger,
        store,
      });

      await handler.handleMessage(makeMessage({ content: 'new msg' }));

      expect(store.load).toHaveBeenCalledWith('chat-1');
      const [messages] = chatFn.mock.calls[0];
      expect(messages).toHaveLength(3); // 2 from store + 1 new
      expect(messages[0].content).toBe('previous');
    });

    it('should save history to store after response', async () => {
      const chatFn = vi.fn().mockResolvedValue(textResponse('reply'));
      const provider = createMockProvider(chatFn);
      const store = {
        load: vi.fn().mockReturnValue([]),
        save: vi.fn(),
        clear: vi.fn(),
      };

      const handler = new ConversationHandler({
        provider,
        tools: new Map(),
        logger,
        store,
      });

      await handler.handleMessage(makeMessage({ content: 'hello' }));

      expect(store.save).toHaveBeenCalledWith('chat-1', expect.any(Array));
      const savedHistory = store.save.mock.calls[0][1];
      expect(savedHistory).toHaveLength(2); // user + assistant
    });
  });

  // -------------------------------------------------------------------------
  // 10. Typing callback
  // -------------------------------------------------------------------------
  describe('typing callback', () => {
    it('should call onTyping before LLM call', async () => {
      const chatFn = vi.fn().mockResolvedValue(textResponse('ok'));
      const provider = createMockProvider(chatFn);
      const onTyping = vi.fn();

      const handler = new ConversationHandler({
        provider,
        tools: new Map(),
        logger,
        onTyping,
      });

      await handler.handleMessage(makeMessage());

      expect(onTyping).toHaveBeenCalledWith('chat-1');
    });
  });
```

**Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run src/messaging/__tests__/conversation.test.ts`
Expected: New tests FAIL (store and onTyping not recognized in config)

**Step 3: Update ConversationHandler to accept store and onTyping**

Modify `src/messaging/conversation.ts`:

Add to `ConversationHandlerConfig`:
```typescript
  store?: {
    load(chatId: string): ChatMessage[];
    save(chatId: string, history: ChatMessage[]): void;
    clear(chatId: string): void;
  };
  onTyping?: (chatId: string) => void | Promise<void>;
```

Add private fields:
```typescript
  private store?: ConversationHandlerConfig['store'];
  private onTyping?: ConversationHandlerConfig['onTyping'];
```

In constructor:
```typescript
    this.store = config.store;
    this.onTyping = config.onTyping;
```

In `handleMessage()`, replace `const history: ChatMessage[] = [...this.getHistory(chatId)];` with:
```typescript
    const history: ChatMessage[] = this.store
      ? [...this.store.load(chatId)]
      : [...this.getHistory(chatId)];
```

Before the first `this.provider.chat()` call, add:
```typescript
    await this.onTyping?.(chatId);
```

Before the final return, replace `this.histories.set(chatId, history);` with:
```typescript
    if (this.store) {
      this.store.save(chatId, history);
    } else {
      this.histories.set(chatId, history);
    }
```

In `trimHistory`, also handle store-backed trimming. After trimming, if store is set, save back:

Actually, simpler: do trimming on the local `history` array (already happens), and the `save` at the end persists the trimmed version. The existing `trimHistory` method works on in-memory map entries though. Refactor: move the trim logic to operate on the `history` array directly before saving. Here's the updated approach for `handleMessage()`:

After `history.push({ role: 'assistant', content: response.content });`, replace the commit+trim block with:
```typescript
    // Trim history if over limit
    this.trimHistoryArray(history);

    // Persist
    if (this.store) {
      this.store.save(chatId, history);
    } else {
      this.histories.set(chatId, history);
    }
```

And change `trimHistory` to `trimHistoryArray` that operates on a passed array:
```typescript
  private trimHistoryArray(history: ChatMessage[]): void {
    if (history.length <= this.maxHistory) return;

    const excess = history.length - this.maxHistory;
    history.splice(0, excess);

    while (history.length > 0) {
      const first = history[0];
      const isToolResult =
        Array.isArray(first.content) &&
        first.content.some((b) => b.type === 'tool_result');
      if (first.role !== 'user' || isToolResult) {
        history.splice(0, 1);
      } else {
        break;
      }
    }
  }
```

Remove the old `trimHistory(chatId)` method and update `clearHistory` to also clear the store:
```typescript
  clearHistory(chatId: string): void {
    this.histories.delete(chatId);
    this.store?.clear(chatId);
  }
```

**Step 4: Run all conversation tests**

Run: `npx vitest run src/messaging/__tests__/conversation.test.ts`
Expected: All PASS (both old and new tests)

**Step 5: Commit**

```bash
git add src/messaging/conversation.ts src/messaging/__tests__/conversation.test.ts
git commit -m "feat(messaging): add CSM persistence and typing callback to ConversationHandler"
```

---

### Task 5: Extend ChannelMessage type with media fields

**Files:**
- Modify: `src/messaging/types.ts`

**Step 1: Add media fields to ChannelMessage**

Add to the `ChannelMessage` interface in `src/messaging/types.ts`:

```typescript
  /** Media attachments (photos, docs, voice, etc.) */
  media?: Array<{
    type: 'photo' | 'document' | 'voice' | 'audio' | 'video' | 'video_note';
    fileId: string;
    fileName?: string;
    mimeType?: string;
    fileSize?: number;
  }>;
```

**Step 2: Verify existing tests still pass**

Run: `npx vitest run src/messaging/`
Expected: All PASS (media is optional, no breaking change)

**Step 3: Commit**

```bash
git add src/messaging/types.ts
git commit -m "feat(messaging): add media fields to ChannelMessage type"
```

---

### Task 6: Rewrite TelegramAdapter with grammY

This is the largest task. The adapter becomes a full grammY bot with commands, media, typing, and inline buttons.

**Files:**
- Rewrite: `src/messaging/channels/telegram.ts`
- Rewrite: `src/messaging/channels/__tests__/telegram.test.ts`

**Step 1: Write the failing tests**

File: `src/messaging/channels/__tests__/telegram.test.ts`

```typescript
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
    const handler = vi.fn();
    adapter.onCommand('status', handler);
    const bot = (adapter as any).bot;
    expect(bot.command).toHaveBeenCalledWith('status', expect.any(Function));
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/messaging/channels/__tests__/telegram.test.ts`
Expected: FAIL (TelegramAdapter constructor signature changed)

**Step 3: Write the new TelegramAdapter**

File: `src/messaging/channels/telegram.ts`

```typescript
// src/messaging/channels/telegram.ts
import { Bot, InputFile } from 'grammy';
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
```

**Step 4: Run tests**

Run: `npx vitest run src/messaging/channels/__tests__/telegram.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/messaging/channels/telegram.ts src/messaging/channels/__tests__/telegram.test.ts
git commit -m "feat(messaging): rewrite TelegramAdapter with grammY, commands, media, typing"
```

---

### Task 7: Wire up slash commands and CSM persistence in MessagingPlugin

**Files:**
- Modify: `src/plugins/messaging/index.ts`
- Modify: `src/plugins/messaging/__tests__/messaging-plugin.test.ts`

**Step 1: Update MessagingPlugin to use new adapter features**

Rewrite `src/plugins/messaging/index.ts`. Key changes:

1. Import `ConversationStore` from `../../messaging/persistence.js`
2. Import `markdownToTelegramHtml`, `smartChunk` from `../../messaging/format.js`
3. Define command list with tool mappings
4. Create `ConversationStore` from `ctx.sharedMemoryDb.db` (the raw better-sqlite3 instance)
5. Pass `store` and `onTyping` to `ConversationHandler`
6. Register command handlers via `adapter.onCommand()`
7. Format LLM responses through `markdownToTelegramHtml` + `smartChunk` before sending

The slash commands should call tools directly (no LLM):

```typescript
const COMMANDS = [
  { command: 'status', description: 'Cluster status overview' },
  { command: 'health', description: 'Detailed health report' },
  { command: 'nodes', description: 'List cluster nodes' },
  { command: 'tasks', description: 'List running tasks' },
  { command: 'sessions', description: 'Active Claude sessions' },
  { command: 'new', description: 'Clear conversation history' },
  { command: 'help', description: 'List available commands' },
  { command: 'squelch', description: 'Suppress alerts (minutes)' },
  { command: 'whereami', description: 'Show timeline state' },
];

// Map command names to tool names for direct execution
const COMMAND_TOOL_MAP: Record<string, string> = {
  status: 'cluster_status',
  health: 'cluster_health',
  nodes: 'list_nodes',
  tasks: 'list_tasks',
  sessions: 'list_sessions',
  squelch: 'squelch_alerts',
  whereami: 'memory_whereami',
};
```

For each command handler:
- Look up the tool in `allTools`
- Execute it with parsed args
- Format the JSON result into readable text
- Send via `adapter.sendMessage()`

For `/new`: call `conversationHandler.clearHistory(chatId)` and respond "Conversation cleared."

For `/help`: send the command list as formatted text.

For `/squelch <minutes>`: parse the argument, call `squelch_alerts` with `{ minutes: parseInt(args) }`.

For the message handler (non-command text):
- Call `adapter.sendTyping(channelId)` before processing
- Run through `conversationHandler.handleMessage()`
- Convert response with `markdownToTelegramHtml()`
- Split with `smartChunk(result, 4096)`
- Send each chunk via `adapter.sendMessage()`

**Step 2: Update the `sendReply` method to use formatter**

Replace the existing `sendReply` method with one that uses `markdownToTelegramHtml` + `smartChunk`:

```typescript
private async sendReply(adapter: TelegramAdapter, channelId: string, text: string): Promise<void> {
  const html = markdownToTelegramHtml(text);
  const chunks = smartChunk(html, 4096);
  for (const chunk of chunks) {
    await adapter.sendMessage(channelId, chunk);
  }
}
```

**Step 3: Update tests to match new constructor signatures**

Update `src/plugins/messaging/__tests__/messaging-plugin.test.ts` to use the new `TelegramAdapter` mock (grammY-based, with `commands` array in config).

**Step 4: Run all messaging tests**

Run: `npx vitest run src/messaging/ src/plugins/messaging/`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/plugins/messaging/index.ts src/plugins/messaging/__tests__/messaging-plugin.test.ts
git commit -m "feat(messaging): wire slash commands, CSM persistence, and rich formatting into MessagingPlugin"
```

---

### Task 8: Build and verify

**Step 1: Run full build**

Run: `npm run build`
Expected: Clean compilation

**Step 2: Run all tests**

Run: `npx vitest run`
Expected: All tests pass

**Step 3: Fix any build or test failures**

Address any type errors or test regressions.

**Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix: resolve build and test issues from Telegram adapter rewrite"
```

---

### Task 9: Integration test — deploy and verify on live cluster

**Step 1: Squelch alerts before deployment**

Run: `cortex squelch 15`

**Step 2: Build on terminus**

Run:
```bash
cd /home/paschal/claudecluster && npm run build
```

**Step 3: Deploy via rolling update**

Use `initiate_rolling_update` MCP tool, or manually:
```bash
# Sync dist/ to all nodes, then rolling restart
```

**Step 4: Verify bot responds in Telegram**

- Send `/help` to Cipher — should show command list
- Send `/status` — should show cluster status in readable format
- Send `/new` — should confirm history cleared
- Send a free-text message — should get an LLM response with proper formatting
- Send `/nodes` — should list all cluster nodes
- Restart Cortex on leader node, send a message — history should persist from CSM

**Step 5: Re-enable alerts**

Run: `cortex squelch 0`

**Step 6: Final commit if any live fixes needed**

---

### Task 10: Clean up OpenClaw telegram code (optional, post-verification)

**Files:**
- Delete: `src/openclaw/telegram/` (entire directory)

Only after confirming the new implementation works in production. The OpenClaw code served as reference and is no longer needed.

**Step 1: Remove the directory**

```bash
rm -rf src/openclaw/telegram/
```

**Step 2: Verify build still passes**

Run: `npm run build && npx vitest run`

**Step 3: Commit**

```bash
git add -A
git commit -m "chore: remove archived OpenClaw telegram code (replaced by native Cortex adapter)"
```
