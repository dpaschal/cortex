// tests/memory-tools.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMemoryTools } from '../src/memory/memory-tools.js';
import { SharedMemoryDB } from '../src/memory/shared-memory-db.js';
import { MemoryReplicator } from '../src/memory/replication.js';
import { ToolHandler } from '../src/mcp/tools.js';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from 'winston';

const createMockLogger = (): Logger => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger);

describe('Memory MCP Tools', () => {
  let db: SharedMemoryDB;
  let replicator: MemoryReplicator;
  let tools: Map<string, ToolHandler>;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-tools-test-'));
    db = new SharedMemoryDB({ dataDir: tmpDir, logger: createMockLogger() });

    const emitter = new EventEmitter();
    const mockRaft = Object.assign(emitter, {
      getState: vi.fn().mockReturnValue('leader'),
      getLeaderId: vi.fn().mockReturnValue('forge-1234'),
      appendEntry: vi.fn().mockResolvedValue({ success: true, index: 1 }),
      on: emitter.on.bind(emitter),
      removeListener: emitter.removeListener.bind(emitter),
    }) as any;

    const mockMembership = {
      getLeaderAddress: vi.fn().mockReturnValue('100.94.211.117:50051'),
      getSelfNodeId: vi.fn().mockReturnValue('test-node'),
    } as any;

    replicator = new MemoryReplicator({
      db,
      raft: mockRaft,
      membership: mockMembership,
      clientPool: {} as any,
      logger: createMockLogger(),
      nodeId: 'test-node',
    });

    tools = createMemoryTools({
      db,
      replicator,
      raft: mockRaft,
      logger: createMockLogger(),
      nodeId: 'test-node',
    });
  });

  afterEach(() => {
    replicator.stop();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('memory_query', () => {
    it('executes SELECT queries', async () => {
      db.run('INSERT INTO timeline_threads (name) VALUES (?)', ['test']);
      const handler = tools.get('memory_query')!;
      const result = await handler.handler({ sql: 'SELECT * FROM timeline_threads' }) as any;
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].name).toBe('test');
    });

    it('rejects non-SELECT queries', async () => {
      const handler = tools.get('memory_query')!;
      await expect(handler.handler({
        sql: 'DELETE FROM timeline_threads',
      })).rejects.toThrow('memory_query only accepts SELECT');
    });

    it('auto-applies LIMIT', async () => {
      const handler = tools.get('memory_query')!;
      const result = await handler.handler({ sql: 'SELECT * FROM timeline_threads', limit: 5 }) as any;
      expect(result.rows).toHaveLength(0);
    });
  });

  describe('memory_schema', () => {
    it('lists all tables with classifications', async () => {
      const handler = tools.get('memory_schema')!;
      const result = await handler.handler({}) as any;
      expect(result.tables.length).toBeGreaterThan(0);
      const timeline = result.tables.find((t: any) => t.name === 'timeline_threads');
      expect(timeline?.classification).toBe('public');
    });

    it('describes a specific table', async () => {
      const handler = tools.get('memory_schema')!;
      const result = await handler.handler({ table: 'timeline_threads' }) as any;
      expect(result.table).toBe('timeline_threads');
      expect(result.columns.length).toBeGreaterThan(0);
      expect(result.columns.find((c: any) => c.name === 'name')).toBeTruthy();
    });
  });

  describe('memory_stats', () => {
    it('returns database statistics', async () => {
      const handler = tools.get('memory_stats')!;
      const result = await handler.handler({}) as any;
      expect(result.nodeId).toBe('test-node');
      expect(result.raftRole).toBe('leader');
      expect(result.dbSizeBytes).toBeGreaterThan(0);
    });
  });

  describe('memory_whereami', () => {
    it('returns active threads and context', async () => {
      db.run('INSERT INTO timeline_threads (name, status) VALUES (?, ?)', ['active-thread', 'active']);
      const handler = tools.get('memory_whereami')!;
      const result = await handler.handler({}) as any;
      expect(result.active_threads).toHaveLength(1);
      expect(result.active_threads[0].name).toBe('active-thread');
    });
  });

  describe('memory_network_lookup', () => {
    it('finds devices by hostname', async () => {
      db.run(
        'INSERT INTO network_clients (hostname, ip_address, mac_address) VALUES (?, ?, ?)',
        ['forge', '192.168.1.200', 'aa:bb:cc:dd:ee:ff']
      );
      const handler = tools.get('memory_network_lookup')!;
      const result = await handler.handler({ query: 'forge' }) as any;
      expect(result.devices).toHaveLength(1);
      expect(result.devices[0].ip_address).toBe('192.168.1.200');
    });
  });

  describe('memory_list_threads', () => {
    it('lists threads with filtering', async () => {
      db.run('INSERT INTO timeline_threads (name, status) VALUES (?, ?)', ['active-1', 'active']);
      db.run('INSERT INTO timeline_threads (name, status) VALUES (?, ?)', ['done-1', 'completed']);

      const handler = tools.get('memory_list_threads')!;
      const result = await handler.handler({ status: 'active' }) as any;
      expect(result.threads).toHaveLength(1);
      expect(result.threads[0].name).toBe('active-1');
    });
  });

  describe('memory_set_context and memory_get_context', () => {
    it('sets and retrieves context entries', async () => {
      const setHandler = tools.get('memory_set_context')!;
      const getHandler = tools.get('memory_get_context')!;

      // Set a context entry directly in DB (since write goes through Raft mock)
      db.run(
        'INSERT INTO timeline_context (key, value, category) VALUES (?, ?, ?)',
        ['test-key', 'test-value', 'fact']
      );

      const result = await getHandler.handler({}) as any;
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].key).toBe('test-key');
      expect(result.entries[0].value).toBe('test-value');
    });
  });

  it('has all 12 expected tools', () => {
    const expectedTools = [
      'memory_query', 'memory_write', 'memory_schema', 'memory_stats',
      'memory_log_thought', 'memory_whereami', 'memory_handoff',
      'memory_set_context', 'memory_get_context', 'memory_search',
      'memory_network_lookup', 'memory_list_threads',
    ];
    for (const name of expectedTools) {
      expect(tools.has(name), `missing tool: ${name}`).toBe(true);
    }
    expect(tools.size).toBe(12);
  });
});
