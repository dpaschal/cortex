import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Inbox } from '../inbox.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('Inbox', () => {
  let tmpDir: string;
  let inbox: Inbox;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inbox-test-'));
    inbox = new Inbox(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should write and read a message', async () => {
    const id = await inbox.writeMessage({
      from: 'claudecode',
      to: 'cipher',
      content: 'Hello Cipher',
      type: 'info',
    });

    const msg = await inbox.readMessage(id);
    expect(msg.from).toBe('claudecode');
    expect(msg.to).toBe('cipher');
    expect(msg.content).toBe('Hello Cipher');
    expect(msg.status).toBe('new');
    expect(msg.timestamp).toBeDefined();
  });

  it('should list all messages', async () => {
    await inbox.writeMessage({ from: 'a', to: 'b', content: '1', type: 'info' });
    await inbox.writeMessage({ from: 'a', to: 'b', content: '2', type: 'info' });

    const ids = await inbox.listMessages();
    expect(ids).toHaveLength(2);
  });

  it('should return empty list for nonexistent directory', async () => {
    const noDir = new Inbox('/nonexistent/path');
    const ids = await noDir.listMessages();
    expect(ids).toEqual([]);
  });

  it('should filter new messages', async () => {
    const id1 = await inbox.writeMessage({ from: 'a', to: 'b', content: '1', type: 'info' });
    await inbox.writeMessage({ from: 'a', to: 'b', content: '2', type: 'info' });

    await inbox.markRead(id1);

    const newMessages = await inbox.getNewMessages();
    expect(newMessages).toHaveLength(1);
    expect(newMessages[0].content).toBe('2');
  });

  it('should archive old messages', async () => {
    await inbox.writeMessage({ from: 'a', to: 'b', content: 'old', type: 'info' });

    const ids = await inbox.listMessages();
    const msg = await inbox.readMessage(ids[0]);
    msg.timestamp = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    await fs.writeFile(path.join(tmpDir, `${ids[0]}.json`), JSON.stringify(msg));

    const archived = await inbox.archiveOlderThan(30);
    expect(archived).toBe(1);
    expect(await inbox.listMessages()).toHaveLength(0);
  });

  it('should throw for nonexistent message', async () => {
    await expect(inbox.readMessage('nonexistent')).rejects.toThrow('Message not found');
  });
});
