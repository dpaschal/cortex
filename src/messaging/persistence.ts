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
