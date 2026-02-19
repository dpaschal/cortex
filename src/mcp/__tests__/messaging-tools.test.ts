// src/mcp/__tests__/messaging-tools.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMessagingTools } from '../messaging-tools.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('messaging MCP tools', () => {
  let tmpDir: string;
  let tools: Map<string, any>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-msg-test-'));
    const result = createMessagingTools({ inboxPath: tmpDir });
    tools = result.tools;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should register all expected tools', () => {
    expect(tools.has('messaging_send')).toBe(true);
    expect(tools.has('messaging_check')).toBe(true);
    expect(tools.has('messaging_list')).toBe(true);
    expect(tools.has('messaging_get')).toBe(true);
    expect(tools.has('messaging_gateway_status')).toBe(true);
  });

  it('messaging_send should write a message to the inbox', async () => {
    const handler = tools.get('messaging_send')!;
    const result = await handler.handler({
      from: 'claudecode',
      to: 'cipher',
      content: 'Test message',
      type: 'info',
    });

    expect(result.messageId).toBeDefined();
    const files = await fs.readdir(tmpDir);
    expect(files.length).toBe(1);
  });

  it('messaging_check should return new messages', async () => {
    await fs.writeFile(path.join(tmpDir, 'test-msg.json'), JSON.stringify({
      id: 'test-msg', from: 'cipher', to: 'claudecode', content: 'Hello',
      type: 'info', status: 'new', timestamp: new Date().toISOString(),
    }));

    const handler = tools.get('messaging_check')!;
    const result = await handler.handler({});
    expect(result.messages).toHaveLength(1);
  });

  it('messaging_list should return message IDs', async () => {
    await fs.writeFile(path.join(tmpDir, 'msg1.json'), '{}');
    await fs.writeFile(path.join(tmpDir, 'msg2.json'), '{}');

    const handler = tools.get('messaging_list')!;
    const result = await handler.handler({});
    expect(result.conversations).toHaveLength(2);
  });

  it('messaging_get should return a specific message', async () => {
    await fs.writeFile(path.join(tmpDir, 'test-id.json'), JSON.stringify({
      id: 'test-id', from: 'cipher', to: 'claudecode', content: 'Specific message',
      type: 'info', status: 'new', timestamp: new Date().toISOString(),
    }));

    const handler = tools.get('messaging_get')!;
    const result = await handler.handler({ messageId: 'test-id' });
    expect(result.message.content).toBe('Specific message');
  });
});
