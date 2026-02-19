import * as fs from 'fs/promises';
import * as path from 'path';
import { randomBytes } from 'crypto';
import type { InboxMessage, WriteMessageInput } from './types.js';

export class Inbox {
  private inboxPath: string;
  private archivePath: string;

  constructor(inboxPath: string) {
    this.inboxPath = inboxPath;
    this.archivePath = path.join(inboxPath, '..', 'archive');
  }

  async writeMessage(input: WriteMessageInput): Promise<string> {
    await fs.mkdir(this.inboxPath, { recursive: true });

    const id = `${Date.now()}-${randomBytes(4).toString('hex')}`;
    const message: InboxMessage = {
      id,
      from: input.from,
      to: input.to,
      content: input.content,
      type: input.type,
      status: 'new',
      timestamp: new Date().toISOString(),
      threadId: input.threadId,
      context: input.context,
    };

    await fs.writeFile(
      path.join(this.inboxPath, `${id}.json`),
      JSON.stringify(message, null, 2),
    );

    return id;
  }

  async readMessage(messageId: string): Promise<InboxMessage> {
    const messagePath = path.join(this.inboxPath, `${messageId}.json`);
    try {
      const content = await fs.readFile(messagePath, 'utf-8');
      return JSON.parse(content) as InboxMessage;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Message not found: ${messageId}`);
      }
      throw err;
    }
  }

  async listMessages(): Promise<string[]> {
    try {
      const files = await fs.readdir(this.inboxPath);
      return files
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace('.json', ''));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw err;
    }
  }

  async getNewMessages(): Promise<InboxMessage[]> {
    const ids = await this.listMessages();
    const messages: InboxMessage[] = [];

    for (const id of ids) {
      try {
        const msg = await this.readMessage(id);
        if (msg.status === 'new') {
          messages.push(msg);
        }
      } catch {
        // Skip unreadable messages
      }
    }

    return messages;
  }

  async markRead(messageId: string): Promise<void> {
    const msg = await this.readMessage(messageId);
    msg.status = 'read';
    await fs.writeFile(
      path.join(this.inboxPath, `${messageId}.json`),
      JSON.stringify(msg, null, 2),
    );
  }

  async archiveOlderThan(days: number): Promise<number> {
    const ids = await this.listMessages();
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    let archived = 0;

    await fs.mkdir(this.archivePath, { recursive: true });

    for (const id of ids) {
      try {
        const msg = await this.readMessage(id);
        const msgTime = new Date(msg.timestamp).getTime();
        if (msgTime < cutoff) {
          msg.status = 'archived';
          const src = path.join(this.inboxPath, `${id}.json`);
          const dest = path.join(this.archivePath, `${id}.json`);
          await fs.writeFile(dest, JSON.stringify(msg, null, 2));
          await fs.unlink(src);
          archived++;
        }
      } catch {
        // Skip unreadable messages
      }
    }

    return archived;
  }
}
