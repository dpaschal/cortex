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
