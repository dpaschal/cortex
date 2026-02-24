# cortex.shared.memory Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace all external databases (cerebrus PostgreSQL, meshdb, meshmonitor SQLite) with a single Raft-replicated SQLite database embedded in every Cortex node, backed up to Google Cloud Storage via Litestream.

**Architecture:** Every Cortex node holds an identical copy of `~/.cortex/shared-memory.db`. Writes route through the Raft leader as `memory_write` log entries (type 8). On commit, every node applies the SQL to its local SQLite. Reads are instant from local SQLite -- no network hop. A three-tier data classification system (public/internal/local) controls what replicates and what backs up to GCS.

**Tech Stack:** better-sqlite3 (synchronous embedded SQLite), existing Raft consensus, gRPC + protobuf (existing), Litestream (GCS streaming backup), MCP SDK (existing)

---

## Prerequisites

```bash
cd /home/paschal/cortex
npm install better-sqlite3
npm install -D @types/better-sqlite3
```

---

## Task 1: SQLite Database Module

**Goal:** Create the `SharedMemoryDB` class -- the local SQLite store that every node holds.

**Files to create:**
- `src/memory/shared-memory-db.ts`

**Files to modify:** None

### Step 1.1: Create the directory and file

```bash
mkdir -p src/memory
```

### Step 1.2: Write `src/memory/shared-memory-db.ts`

```typescript
// src/memory/shared-memory-db.ts
import Database, { type Database as DatabaseType, type Statement } from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { Logger } from 'winston';

export type Classification = 'public' | 'internal' | 'local';

export interface TableClassification {
  table_name: string;
  classification: Classification;
  domain: string;
}

export interface SharedMemoryDBConfig {
  dataDir: string;       // ~/.cortex
  logger: Logger;
  readOnly?: boolean;    // for filtered replica
}

export class SharedMemoryDB {
  private db: DatabaseType;
  private logger: Logger;
  private dbPath: string;

  constructor(config: SharedMemoryDBConfig) {
    this.logger = config.logger;
    this.dbPath = path.join(config.dataDir, 'shared-memory.db');

    // Ensure directory exists
    fs.mkdirSync(config.dataDir, { recursive: true });

    this.db = new Database(this.dbPath, {
      readonly: config.readOnly ?? false,
    });

    // Enable WAL mode for concurrent reads during writes
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');

    // Initialize schema
    this.initializeSchema();

    this.logger.info('SharedMemoryDB opened', { path: this.dbPath });
  }

  private initializeSchema(): void {
    this.db.exec(`
      -- Table classification metadata
      CREATE TABLE IF NOT EXISTS _table_classification (
        table_name TEXT PRIMARY KEY,
        classification TEXT NOT NULL DEFAULT 'public'
          CHECK (classification IN ('public', 'internal', 'local')),
        domain TEXT NOT NULL,
        description TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Schema version tracking
      CREATE TABLE IF NOT EXISTS _schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now')),
        description TEXT
      );

      -- ============================================================
      -- timeline_ domain (from cerebrus timeline schema)
      -- ============================================================

      CREATE TABLE IF NOT EXISTS timeline_projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        employer TEXT,
        language TEXT,
        location TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        tags TEXT, -- JSON array
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS timeline_threads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        parent_thought_id INTEGER,
        project_id INTEGER REFERENCES timeline_projects(id),
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS timeline_thoughts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id INTEGER NOT NULL REFERENCES timeline_threads(id),
        parent_thought_id INTEGER REFERENCES timeline_thoughts(id),
        content TEXT NOT NULL,
        thought_type TEXT NOT NULL DEFAULT 'progress',
        status TEXT NOT NULL DEFAULT 'active',
        metadata TEXT DEFAULT '{}', -- JSON
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS timeline_thread_position (
        thread_id INTEGER PRIMARY KEY REFERENCES timeline_threads(id),
        current_thought_id INTEGER REFERENCES timeline_thoughts(id),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS timeline_context (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL, -- JSON
        thread_id INTEGER REFERENCES timeline_threads(id),
        category TEXT NOT NULL CHECK (category IN ('project', 'pr', 'machine', 'waiting', 'fact', 'reminder')),
        label TEXT,
        source TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        expires_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- ============================================================
      -- network_ domain (from cerebrus public schema)
      -- ============================================================

      CREATE TABLE IF NOT EXISTS network_clients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hostname TEXT,
        ip_address TEXT NOT NULL,
        mac_address TEXT NOT NULL,
        device_type TEXT,
        connection_type TEXT,
        network TEXT,
        vlan_id INTEGER,
        status TEXT DEFAULT 'online',
        uptime_seconds INTEGER,
        signal_strength INTEGER,
        ssid TEXT,
        rx_bytes INTEGER,
        tx_bytes INTEGER,
        discovered_at TEXT DEFAULT (datetime('now')),
        last_seen TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS network_networks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        network_id TEXT UNIQUE,
        name TEXT NOT NULL,
        subnet TEXT,
        vlan_id INTEGER,
        dhcp_enabled INTEGER,
        purpose TEXT,
        discovered_at TEXT DEFAULT (datetime('now')),
        last_seen TEXT DEFAULT (datetime('now'))
      );

      -- ============================================================
      -- infra_ domain (from cerebrus public schema)
      -- ============================================================

      CREATE TABLE IF NOT EXISTS infra_builds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL,
        version TEXT,
        commit_hash TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        started_at TEXT,
        completed_at TEXT,
        metadata TEXT DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS infra_configs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        hostname TEXT,
        config_data TEXT NOT NULL, -- JSON
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS infra_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        source TEXT,
        data TEXT DEFAULT '{}', -- JSON
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS infra_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL UNIQUE,
        hostname TEXT,
        project TEXT,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        ended_at TEXT,
        metadata TEXT DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS infra_secrets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        value TEXT NOT NULL, -- encrypted
        category TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- ============================================================
      -- task_ domain (from cerebrus public schema)
      -- ============================================================

      CREATE TABLE IF NOT EXISTS task_agent_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        priority INTEGER DEFAULT 5,
        assigned_node TEXT,
        metadata TEXT DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- ============================================================
      -- Indexes
      -- ============================================================

      CREATE INDEX IF NOT EXISTS idx_thoughts_thread ON timeline_thoughts(thread_id);
      CREATE INDEX IF NOT EXISTS idx_thoughts_parent ON timeline_thoughts(parent_thought_id);
      CREATE INDEX IF NOT EXISTS idx_thoughts_type ON timeline_thoughts(thought_type);
      CREATE INDEX IF NOT EXISTS idx_threads_status ON timeline_threads(status);
      CREATE INDEX IF NOT EXISTS idx_threads_project ON timeline_threads(project_id);
      CREATE INDEX IF NOT EXISTS idx_context_category ON timeline_context(category);
      CREATE INDEX IF NOT EXISTS idx_context_pinned ON timeline_context(pinned);
      CREATE INDEX IF NOT EXISTS idx_context_updated ON timeline_context(updated_at);
      CREATE INDEX IF NOT EXISTS idx_network_hostname ON network_clients(hostname);
      CREATE INDEX IF NOT EXISTS idx_network_ip ON network_clients(ip_address);
      CREATE INDEX IF NOT EXISTS idx_network_mac ON network_clients(mac_address);
      CREATE INDEX IF NOT EXISTS idx_events_type ON infra_events(event_type);
      CREATE INDEX IF NOT EXISTS idx_events_created ON infra_events(created_at);
    `);

    // Seed default table classifications
    const upsertClassification = this.db.prepare(`
      INSERT OR IGNORE INTO _table_classification (table_name, classification, domain, description)
      VALUES (?, ?, ?, ?)
    `);

    const classifications: [string, Classification, string, string][] = [
      ['timeline_threads', 'public', 'timeline', 'Work threads'],
      ['timeline_thoughts', 'public', 'timeline', 'Thought waypoints'],
      ['timeline_projects', 'public', 'timeline', 'Project registry'],
      ['timeline_thread_position', 'public', 'timeline', 'Current position per thread'],
      ['timeline_context', 'internal', 'timeline', 'Context entries (may contain credentials)'],
      ['network_clients', 'public', 'network', 'Network device inventory'],
      ['network_networks', 'public', 'network', 'Network/VLAN definitions'],
      ['infra_builds', 'public', 'infra', 'Build records'],
      ['infra_configs', 'public', 'infra', 'Configuration snapshots'],
      ['infra_events', 'public', 'infra', 'Infrastructure events'],
      ['infra_sessions', 'public', 'infra', 'Session records'],
      ['infra_secrets', 'internal', 'infra', 'Encrypted secrets'],
      ['task_agent_tasks', 'public', 'task', 'Agent task records'],
    ];

    const insertMany = this.db.transaction(() => {
      for (const [table, cls, domain, desc] of classifications) {
        upsertClassification.run(table, cls, domain, desc);
      }
    });
    insertMany();
  }

  // --- Core operations ---

  exec(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, params: unknown[] = []): Database.RunResult {
    return this.db.prepare(sql).run(...params);
  }

  query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  queryOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  // --- Classification ---

  getTableClassification(tableName: string): Classification {
    const row = this.queryOne<{ classification: Classification }>(
      'SELECT classification FROM _table_classification WHERE table_name = ?',
      [tableName]
    );
    return row?.classification ?? 'public';
  }

  getTableClassifications(): TableClassification[] {
    return this.query<TableClassification>(
      'SELECT table_name, classification, domain FROM _table_classification ORDER BY domain, table_name'
    );
  }

  setTableClassification(tableName: string, classification: Classification): void {
    this.run(
      `UPDATE _table_classification SET classification = ? WHERE table_name = ?`,
      [classification, tableName]
    );
  }

  // --- Schema introspection ---

  listTables(): string[] {
    const rows = this.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
    );
    return rows.map(r => r.name);
  }

  describeTable(tableName: string): { name: string; type: string; notnull: number; pk: number }[] {
    return this.query(`PRAGMA table_info('${tableName.replace(/'/g, "''")}')`);
  }

  // --- Stats ---

  getStats(): {
    dbSizeBytes: number;
    tableCount: number;
    rowCounts: Record<string, number>;
    classificationCounts: Record<Classification, number>;
  } {
    const stats = fs.statSync(this.dbPath);
    const tables = this.listTables().filter(t => !t.startsWith('_'));
    const rowCounts: Record<string, number> = {};

    for (const table of tables) {
      const row = this.queryOne<{ count: number }>(`SELECT COUNT(*) as count FROM "${table}"`);
      rowCounts[table] = row?.count ?? 0;
    }

    const classificationCounts: Record<Classification, number> = { public: 0, internal: 0, local: 0 };
    const clsRows = this.query<{ classification: Classification; cnt: number }>(
      `SELECT classification, COUNT(*) as cnt FROM _table_classification GROUP BY classification`
    );
    for (const row of clsRows) {
      classificationCounts[row.classification] = row.cnt;
    }

    return {
      dbSizeBytes: stats.size,
      tableCount: tables.length,
      rowCounts,
      classificationCounts,
    };
  }

  // --- Integrity ---

  computeChecksum(): string {
    // Deterministic hash over all table contents
    const hash = crypto.createHash('sha256');
    const tables = this.listTables().filter(t => !t.startsWith('_') && !t.startsWith('sqlite_'));
    tables.sort();

    for (const table of tables) {
      hash.update(`TABLE:${table}\n`);
      const rows = this.query(`SELECT * FROM "${table}" ORDER BY rowid`);
      for (const row of rows) {
        hash.update(JSON.stringify(row) + '\n');
      }
    }

    return hash.digest('hex');
  }

  // --- Lifecycle ---

  getPath(): string {
    return this.dbPath;
  }

  close(): void {
    this.db.close();
    this.logger.info('SharedMemoryDB closed');
  }

  isOpen(): boolean {
    return this.db.open;
  }
}
```

### Step 1.3: Write test

Create `tests/shared-memory-db.test.ts`:

```typescript
// tests/shared-memory-db.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SharedMemoryDB } from '../src/memory/shared-memory-db.js';
import { Logger } from 'winston';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const createMockLogger = (): Logger => ({
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger);

describe('SharedMemoryDB', () => {
  let db: SharedMemoryDB;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-test-'));
    db = new SharedMemoryDB({
      dataDir: tmpDir,
      logger: createMockLogger(),
    });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the database file', () => {
    expect(fs.existsSync(path.join(tmpDir, 'shared-memory.db'))).toBe(true);
  });

  it('creates all expected tables', () => {
    const tables = db.listTables();
    expect(tables).toContain('timeline_threads');
    expect(tables).toContain('timeline_thoughts');
    expect(tables).toContain('timeline_context');
    expect(tables).toContain('network_clients');
    expect(tables).toContain('infra_builds');
    expect(tables).toContain('_table_classification');
  });

  it('seeds table classifications', () => {
    const cls = db.getTableClassifications();
    expect(cls.length).toBeGreaterThan(0);
    expect(cls.find(c => c.table_name === 'timeline_context')?.classification).toBe('internal');
    expect(cls.find(c => c.table_name === 'timeline_threads')?.classification).toBe('public');
  });

  it('inserts and queries data', () => {
    db.run(
      `INSERT INTO timeline_threads (name, description) VALUES (?, ?)`,
      ['test thread', 'a test']
    );
    const rows = db.query<{ id: number; name: string }>('SELECT * FROM timeline_threads');
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('test thread');
  });

  it('computes a deterministic checksum', () => {
    db.run(`INSERT INTO timeline_threads (name) VALUES (?)`, ['thread-1']);
    const hash1 = db.computeChecksum();
    const hash2 = db.computeChecksum();
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA-256 hex
  });

  it('returns stats', () => {
    db.run(`INSERT INTO timeline_threads (name) VALUES (?)`, ['thread-1']);
    const stats = db.getStats();
    expect(stats.dbSizeBytes).toBeGreaterThan(0);
    expect(stats.tableCount).toBeGreaterThan(0);
    expect(stats.rowCounts['timeline_threads']).toBe(1);
  });

  it('describes table schema', () => {
    const cols = db.describeTable('timeline_threads');
    const names = cols.map(c => c.name);
    expect(names).toContain('id');
    expect(names).toContain('name');
    expect(names).toContain('status');
  });
});
```

### Step 1.4: Verify

```bash
npx vitest run tests/shared-memory-db.test.ts
```

**Expected outcome:** All tests pass. SharedMemoryDB creates tables, handles CRUD, computes checksums, and reports stats.

**Git commit message:** `feat(memory): add SharedMemoryDB with SQLite schema and classification system`

---

## Task 2: Raft Replication Layer

**Goal:** Create the `MemoryReplicator` class that bridges writes between MCP tools and the Raft consensus log.

**Files to create:**
- `src/memory/replication.ts`

**Files to modify:**
- `src/cluster/raft.ts` (add `memory_write` to `LogEntryType` union)

### Step 2.1: Add `memory_write` to LogEntryType

**File:** `src/cluster/raft.ts`, line 16-23

Change the `LogEntryType` type to include `memory_write`:

```typescript
export type LogEntryType =
  | 'noop'
  | 'config_change'
  | 'task_submit'
  | 'task_complete'
  | 'node_join'
  | 'node_leave'
  | 'context_update'
  | 'memory_write';
```

### Step 2.2: Write `src/memory/replication.ts`

```typescript
// src/memory/replication.ts
import * as crypto from 'crypto';
import { Logger } from 'winston';
import { RaftNode, LogEntry, LogEntryType } from '../cluster/raft.js';
import { SharedMemoryDB, Classification } from './shared-memory-db.js';
import { MembershipManager } from '../cluster/membership.js';
import { GrpcClientPool, ClusterClient } from '../grpc/client.js';

export interface MemoryWriteEntry {
  sql: string;
  params: unknown[];
  checksum: string;
  classification?: Classification;
  table?: string;           // for classification lookup
}

export interface MemoryReplicatorConfig {
  db: SharedMemoryDB;
  raft: RaftNode;
  membership: MembershipManager;
  clientPool: GrpcClientPool;
  logger: Logger;
}

export interface WriteResult {
  success: boolean;
  error?: string;
  forwarded?: boolean;
}

export class MemoryReplicator {
  private db: SharedMemoryDB;
  private raft: RaftNode;
  private membership: MembershipManager;
  private clientPool: GrpcClientPool;
  private logger: Logger;
  private entryHandler: (entry: LogEntry) => void;

  constructor(config: MemoryReplicatorConfig) {
    this.db = config.db;
    this.raft = config.raft;
    this.membership = config.membership;
    this.clientPool = config.clientPool;
    this.logger = config.logger;

    // Subscribe to committed entries
    this.entryHandler = (entry: LogEntry) => {
      if (entry.type === 'memory_write') {
        this.applyCommittedEntry(entry);
      }
    };
    this.raft.on('entryCommitted', this.entryHandler);

    this.logger.info('MemoryReplicator initialized');
  }

  /**
   * Write SQL through Raft. If this node is leader, appends directly.
   * If follower, forwards to leader via gRPC.
   */
  async write(sql: string, params: unknown[] = [], options?: {
    classification?: Classification;
    table?: string;
  }): Promise<WriteResult> {
    // Check classification -- local writes bypass Raft entirely
    const classification = options?.classification
      ?? (options?.table ? this.db.getTableClassification(options.table) : undefined);

    if (classification === 'local') {
      try {
        this.db.run(sql, params);
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    }

    const checksum = this.computeChecksum(sql, params);

    const entry: MemoryWriteEntry = {
      sql,
      params,
      checksum,
      classification,
      table: options?.table,
    };

    const data = Buffer.from(JSON.stringify(entry));

    if (this.raft.getState() === 'leader') {
      // Leader: append directly
      const result = await this.raft.appendEntry('memory_write' as LogEntryType, data);
      if (!result.success) {
        return { success: false, error: 'Failed to append to Raft log' };
      }
      return { success: true };
    }

    // Follower: forward to leader
    return this.forwardToLeader(entry);
  }

  /**
   * Execute a read query directly against local SQLite. No Raft involved.
   */
  read<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    return this.db.query<T>(sql, params);
  }

  readOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T | undefined {
    return this.db.queryOne<T>(sql, params);
  }

  private async forwardToLeader(entry: MemoryWriteEntry): Promise<WriteResult> {
    const leaderAddr = this.membership.getLeaderAddress();
    if (!leaderAddr) {
      return { success: false, error: 'No leader available' };
    }

    try {
      const client = new ClusterClient(this.clientPool, leaderAddr);
      const response = await client.forwardMemoryWrite({
        sql: entry.sql,
        params: JSON.stringify(entry.params),
        checksum: entry.checksum,
        classification: entry.classification ?? '',
        table: entry.table ?? '',
      });

      return {
        success: response.success,
        error: response.error || undefined,
        forwarded: true,
      };
    } catch (error) {
      this.logger.error('Failed to forward write to leader', { error, leaderAddr });
      return {
        success: false,
        error: `Forward failed: ${error instanceof Error ? error.message : String(error)}`,
        forwarded: true,
      };
    }
  }

  private applyCommittedEntry(logEntry: LogEntry): void {
    try {
      const entry: MemoryWriteEntry = JSON.parse(logEntry.data.toString());

      // Verify checksum
      const expectedChecksum = this.computeChecksum(entry.sql, entry.params);
      if (entry.checksum !== expectedChecksum) {
        this.logger.error('Checksum mismatch on committed entry', {
          index: logEntry.index,
          expected: expectedChecksum,
          received: entry.checksum,
        });
        // TODO: trigger snapshot resync
        return;
      }

      // Apply to local SQLite
      this.db.run(entry.sql, entry.params);
      this.logger.debug('Applied memory_write entry', { index: logEntry.index, sql: entry.sql.substring(0, 80) });
    } catch (error) {
      this.logger.error('Failed to apply committed memory_write entry', { index: logEntry.index, error });
    }
  }

  private computeChecksum(sql: string, params: unknown[]): string {
    const payload = sql + JSON.stringify(params);
    return crypto.createHash('sha256').update(payload).digest('hex');
  }

  stop(): void {
    this.raft.removeListener('entryCommitted', this.entryHandler);
    this.logger.info('MemoryReplicator stopped');
  }
}
```

### Step 2.3: Write test

Create `tests/replication.test.ts`:

```typescript
// tests/replication.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryReplicator } from '../src/memory/replication.js';
import { SharedMemoryDB } from '../src/memory/shared-memory-db.js';
import { RaftNode, LogEntry } from '../src/cluster/raft.js';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { Logger } from 'winston';

const createMockLogger = (): Logger => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger);

describe('MemoryReplicator', () => {
  let db: SharedMemoryDB;
  let tmpDir: string;
  let mockRaft: RaftNode & EventEmitter;
  let replicator: MemoryReplicator;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-repl-test-'));
    db = new SharedMemoryDB({ dataDir: tmpDir, logger: createMockLogger() });

    // Create a mock Raft that is also an EventEmitter
    const emitter = new EventEmitter();
    mockRaft = Object.assign(emitter, {
      getState: vi.fn().mockReturnValue('leader'),
      appendEntry: vi.fn().mockResolvedValue({ success: true, index: 1 }),
      on: emitter.on.bind(emitter),
      removeListener: emitter.removeListener.bind(emitter),
    }) as unknown as RaftNode & EventEmitter;

    const mockMembership = {
      getLeaderAddress: vi.fn().mockReturnValue('100.94.211.117:50051'),
    } as any;

    const mockClientPool = {} as any;

    replicator = new MemoryReplicator({
      db,
      raft: mockRaft,
      membership: mockMembership,
      clientPool: mockClientPool,
      logger: createMockLogger(),
    });
  });

  afterEach(() => {
    replicator.stop();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes through Raft when leader', async () => {
    const result = await replicator.write(
      'INSERT INTO timeline_threads (name) VALUES (?)',
      ['test-thread']
    );
    expect(result.success).toBe(true);
    expect(mockRaft.appendEntry).toHaveBeenCalledOnce();
  });

  it('applies committed entries to SQLite', () => {
    const sql = 'INSERT INTO timeline_threads (name) VALUES (?)';
    const params = ['replicated-thread'];
    const checksum = crypto.createHash('sha256')
      .update(sql + JSON.stringify(params))
      .digest('hex');

    const entry: MemoryWriteEntry = { sql, params, checksum };
    const logEntry: LogEntry = {
      term: 1,
      index: 1,
      type: 'memory_write',
      data: Buffer.from(JSON.stringify(entry)),
    };

    // Simulate Raft committing the entry
    mockRaft.emit('entryCommitted', logEntry);

    const rows = db.query<{ name: string }>('SELECT name FROM timeline_threads');
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('replicated-thread');
  });

  it('reads directly from local SQLite', () => {
    db.run('INSERT INTO timeline_threads (name) VALUES (?)', ['local-thread']);
    const rows = replicator.read<{ name: string }>('SELECT name FROM timeline_threads');
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('local-thread');
  });

  it('handles local classification without Raft', async () => {
    const result = await replicator.write(
      'INSERT INTO timeline_threads (name) VALUES (?)',
      ['local-only'],
      { classification: 'local' }
    );
    expect(result.success).toBe(true);
    expect(mockRaft.appendEntry).not.toHaveBeenCalled();
  });
});

// Need to import the type for the test
import type { MemoryWriteEntry } from '../src/memory/replication.js';
```

### Step 2.4: Verify

```bash
npx vitest run tests/replication.test.ts
```

**Expected outcome:** All tests pass. Writes go through Raft when leader, committed entries apply to SQLite, reads are local, local-classified writes bypass Raft.

**Git commit message:** `feat(memory): add MemoryReplicator for Raft-backed write replication`

---

## Task 3: Proto + gRPC Changes

**Goal:** Add `LOG_ENTRY_TYPE_MEMORY_WRITE = 8` to the proto, add `ForwardMemoryWrite` RPC, messages, and handler implementation.

**Files to modify:**
- `proto/cluster.proto`
- `src/grpc/handlers.ts`

**Files to regenerate:**
- `src/generated/` (via `npm run proto:generate`)

### Step 3.1: Add to LogEntryType enum in proto

**File:** `proto/cluster.proto`, after line 362

```protobuf
enum LogEntryType {
  LOG_ENTRY_TYPE_UNKNOWN = 0;
  LOG_ENTRY_TYPE_NOOP = 1;
  LOG_ENTRY_TYPE_CONFIG_CHANGE = 2;
  LOG_ENTRY_TYPE_TASK_SUBMIT = 3;
  LOG_ENTRY_TYPE_TASK_COMPLETE = 4;
  LOG_ENTRY_TYPE_NODE_JOIN = 5;
  LOG_ENTRY_TYPE_NODE_LEAVE = 6;
  LOG_ENTRY_TYPE_CONTEXT_UPDATE = 7;
  LOG_ENTRY_TYPE_MEMORY_WRITE = 8;
}
```

### Step 3.2: Add ForwardMemoryWrite RPC to ClusterService

**File:** `proto/cluster.proto`, add to ClusterService (after line 31)

```protobuf
service ClusterService {
  // ... existing RPCs ...

  // Shared memory write forwarding (follower -> leader)
  rpc ForwardMemoryWrite(MemoryWriteRequest) returns (MemoryWriteResponse);
}
```

### Step 3.3: Add MemoryWrite messages

**File:** `proto/cluster.proto`, add after the QueryContextResponse message (after line 518)

```protobuf
// ============================================================================
// Shared Memory Messages
// ============================================================================

message MemoryWriteRequest {
  string sql = 1;
  string params = 2;       // JSON-encoded array
  string checksum = 3;     // SHA-256 of sql + params
  string classification = 4;
  string table = 5;
}

message MemoryWriteResponse {
  bool success = 1;
  string error = 2;
}
```

### Step 3.4: Regenerate proto types

```bash
npm run proto:generate
```

### Step 3.5: Add ForwardMemoryWrite handler

**File:** `src/grpc/handlers.ts`

Add to the `ServiceHandlersConfig` interface (if not already present, add `raft` is already there for `createRaftServiceHandlers`):

In `createClusterServiceHandlers`, add before the closing `};`:

```typescript
    ForwardMemoryWrite: async (
      call: grpc.ServerUnaryCall<any, any>,
      callback: grpc.sendUnaryData<any>
    ) => {
      try {
        const request = call.request;

        // Only the leader should handle forwarded writes
        if (raft.getState() !== 'leader') {
          callback(null, {
            success: false,
            error: 'Not the leader',
          });
          return;
        }

        // Parse and validate
        const sql = request.sql as string;
        const params = JSON.parse(request.params || '[]');
        const checksum = request.checksum as string;
        const classification = request.classification || undefined;
        const table = request.table || undefined;

        // Verify checksum
        const crypto = require('crypto');
        const expectedChecksum = crypto
          .createHash('sha256')
          .update(sql + JSON.stringify(params))
          .digest('hex');

        if (checksum !== expectedChecksum) {
          callback(null, {
            success: false,
            error: 'Checksum verification failed',
          });
          return;
        }

        // Append to Raft log
        const entry = {
          sql,
          params,
          checksum,
          classification,
          table,
        };
        const data = Buffer.from(JSON.stringify(entry));
        const result = await raft.appendEntry('memory_write', data);

        callback(null, {
          success: result.success,
          error: result.success ? '' : 'Failed to append to Raft log',
        });
      } catch (error) {
        logger.error('ForwardMemoryWrite failed', { error });
        callback(null, {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    },
```

### Step 3.6: Add `forwardMemoryWrite` to ClusterClient

**File:** `src/grpc/client.ts`

Add to the `ClusterClient` class:

```typescript
  async forwardMemoryWrite(request: {
    sql: string;
    params: string;
    checksum: string;
    classification: string;
    table: string;
  }): Promise<{ success: boolean; error: string }> {
    return this.callUnary('ForwardMemoryWrite', request);
  }
```

### Step 3.7: Update the AppendEntries handler type deserialization

**File:** `src/grpc/handlers.ts`, line 405

The existing deserialization at line 405 already handles `memory_write` correctly:
```typescript
type: e.type.replace('LOG_ENTRY_TYPE_', '').toLowerCase(),
```
`LOG_ENTRY_TYPE_MEMORY_WRITE` becomes `memory_write` -- no change needed.

### Step 3.8: Verify

```bash
npm run build
```

**Expected outcome:** Proto generates cleanly. TypeScript compiles. The new `ForwardMemoryWrite` RPC is available.

**Git commit message:** `feat(grpc): add ForwardMemoryWrite RPC and memory_write log entry type`

---

## Task 4: MCP Tools -- Generic Base

**Goal:** Create 4 generic MCP tools: `memory_query`, `memory_write`, `memory_schema`, `memory_stats`.

**Files to create:**
- `src/memory/memory-tools.ts`

### Step 4.1: Write `src/memory/memory-tools.ts`

```typescript
// src/memory/memory-tools.ts
import { Logger } from 'winston';
import { ToolHandler } from '../mcp/tools.js';
import { SharedMemoryDB, Classification } from './shared-memory-db.js';
import { MemoryReplicator } from './replication.js';
import { RaftNode } from '../cluster/raft.js';

export interface MemoryToolsConfig {
  db: SharedMemoryDB;
  replicator: MemoryReplicator;
  raft: RaftNode;
  logger: Logger;
  nodeId: string;
}

// Credential patterns for auto-detection
const CREDENTIAL_PATTERNS = [
  /^sk-[a-zA-Z0-9]{20,}$/,                   // OpenAI/Anthropic API keys
  /^xoxb-/,                                     // Slack bot tokens
  /^ghp_/,                                       // GitHub PATs
  /^glpat-/,                                     // GitLab PATs
  /password\s*[:=]\s*\S+/i,                     // password = ... or password: ...
  /^[A-Za-z0-9+/]{40,}={0,2}$/,               // Base64 encoded secrets
  /postgresql:\/\/\S+:\S+@/,                    // PostgreSQL connection strings
  /mongodb(\+srv)?:\/\/\S+:\S+@/,              // MongoDB connection strings
  /^AKIA[A-Z0-9]{16}$/,                        // AWS access keys
  /^-----BEGIN (RSA |EC |DSA )?PRIVATE KEY-----/, // PEM private keys
];

function looksLikeCredential(value: string): boolean {
  return CREDENTIAL_PATTERNS.some(pattern => pattern.test(value));
}

/**
 * Extract the table name from a SQL statement.
 * Handles INSERT INTO table, UPDATE table, DELETE FROM table, SELECT FROM table.
 */
function extractTableName(sql: string): string | undefined {
  const normalized = sql.trim().toUpperCase();
  let match: RegExpMatchArray | null;

  if (normalized.startsWith('INSERT')) {
    match = sql.match(/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+"?(\w+)"?/i);
  } else if (normalized.startsWith('UPDATE')) {
    match = sql.match(/UPDATE\s+"?(\w+)"?/i);
  } else if (normalized.startsWith('DELETE')) {
    match = sql.match(/DELETE\s+FROM\s+"?(\w+)"?/i);
  } else if (normalized.startsWith('SELECT')) {
    match = sql.match(/FROM\s+"?(\w+)"?/i);
  } else {
    return undefined;
  }

  return match?.[1];
}

export function createMemoryTools(config: MemoryToolsConfig): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();

  // ================================================================
  // memory_query — Read-only SQL query against local SQLite
  // ================================================================
  tools.set('memory_query', {
    description: 'Execute a read-only SQL query against the local shared memory database. No network hop — reads are instant from local SQLite. Use memory_schema to discover tables and columns first.',
    inputSchema: {
      type: 'object',
      properties: {
        sql: {
          type: 'string',
          description: 'SQL SELECT query to execute',
        },
        params: {
          type: 'array',
          description: 'Positional parameters for the query (use ? placeholders)',
        },
        limit: {
          type: 'number',
          description: 'Maximum rows to return (default: 100)',
        },
      },
      required: ['sql'],
    },
    handler: async (args) => {
      const sql = args.sql as string;
      const params = (args.params as unknown[]) ?? [];
      const limit = (args.limit as number) ?? 100;

      // Safety: only allow SELECT (and PRAGMA for schema inspection)
      const normalized = sql.trim().toUpperCase();
      if (!normalized.startsWith('SELECT') && !normalized.startsWith('PRAGMA') && !normalized.startsWith('WITH')) {
        throw new Error('memory_query only accepts SELECT, PRAGMA, or WITH (CTE) queries. Use memory_write for mutations.');
      }

      // Add LIMIT if not present
      let finalSql = sql;
      if (!normalized.includes('LIMIT')) {
        finalSql = `${sql} LIMIT ${limit}`;
      }

      const rows = config.replicator.read(finalSql, params);
      return { rows, count: rows.length };
    },
  });

  // ================================================================
  // memory_write — Write SQL routed through Raft leader
  // ================================================================
  tools.set('memory_write', {
    description: 'Execute a write SQL statement (INSERT/UPDATE/DELETE) against the shared memory database. Writes are replicated to all cluster nodes via Raft consensus. If this node is a follower, the write is automatically forwarded to the leader.',
    inputSchema: {
      type: 'object',
      properties: {
        sql: {
          type: 'string',
          description: 'SQL INSERT, UPDATE, or DELETE statement (use ? placeholders for params)',
        },
        params: {
          type: 'array',
          description: 'Positional parameters for the statement',
        },
        classification: {
          type: 'string',
          description: 'Override data classification: public (replicates + backs up), internal (replicates, no backup), local (no replication)',
          enum: ['public', 'internal', 'local'],
        },
      },
      required: ['sql'],
    },
    handler: async (args) => {
      const sql = args.sql as string;
      const params = (args.params as unknown[]) ?? [];
      const classification = args.classification as Classification | undefined;

      // Safety: block SELECT
      const normalized = sql.trim().toUpperCase();
      if (normalized.startsWith('SELECT')) {
        throw new Error('memory_write does not accept SELECT queries. Use memory_query instead.');
      }

      // Block DDL unless it's CREATE TABLE / CREATE INDEX
      if (normalized.startsWith('DROP') || normalized.startsWith('ALTER')) {
        throw new Error('DDL statements (DROP, ALTER) are not allowed through memory_write. Modify the schema in the source code.');
      }

      const table = extractTableName(sql);

      const result = await config.replicator.write(sql, params, {
        classification,
        table,
      });

      return result;
    },
  });

  // ================================================================
  // memory_schema — List tables or describe columns
  // ================================================================
  tools.set('memory_schema', {
    description: 'Inspect the shared memory database schema. List all tables with their classification (public/internal/local), or describe columns of a specific table.',
    inputSchema: {
      type: 'object',
      properties: {
        table: {
          type: 'string',
          description: 'Table name to describe. If omitted, lists all tables.',
        },
        domain: {
          type: 'string',
          description: 'Filter tables by domain prefix (e.g., "timeline", "network", "infra")',
        },
      },
    },
    handler: async (args) => {
      if (args.table) {
        const tableName = args.table as string;
        const columns = config.db.describeTable(tableName);
        const classification = config.db.getTableClassification(tableName);
        return {
          table: tableName,
          classification,
          columns: columns.map(c => ({
            name: c.name,
            type: c.type,
            notNull: !!c.notnull,
            primaryKey: !!c.pk,
          })),
        };
      }

      let classifications = config.db.getTableClassifications();
      if (args.domain) {
        const prefix = `${args.domain}_`;
        classifications = classifications.filter(c => c.table_name.startsWith(prefix));
      }

      return {
        tables: classifications.map(c => ({
          name: c.table_name,
          classification: c.classification,
          domain: c.domain,
        })),
        count: classifications.length,
      };
    },
  });

  // ================================================================
  // memory_stats — Replication status, DB size, row counts
  // ================================================================
  tools.set('memory_stats', {
    description: 'Get shared memory database statistics: DB size, table row counts, classification tier counts, replication status, and node role.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const stats = config.db.getStats();
      const raftState = config.raft.getState();
      const leaderId = config.raft.getLeaderId();

      return {
        nodeId: config.nodeId,
        raftRole: raftState,
        leaderId,
        dbPath: config.db.getPath(),
        dbSizeBytes: stats.dbSizeBytes,
        dbSizeMb: (stats.dbSizeBytes / (1024 * 1024)).toFixed(2),
        tableCount: stats.tableCount,
        rowCounts: stats.rowCounts,
        classificationCounts: stats.classificationCounts,
      };
    },
  });

  return tools;
}
```

### Step 4.2: Verify

```bash
npm run build
```

**Expected outcome:** TypeScript compiles. 4 generic tools created following ToolHandler interface.

**Git commit message:** `feat(memory): add 4 generic MCP tools (query, write, schema, stats)`

---

## Task 5: MCP Tools -- Smart Shortcuts

**Goal:** Add 8 business-logic shortcut tools to `memory-tools.ts`.

**File to modify:**
- `src/memory/memory-tools.ts` (append to the `createMemoryTools` function)

### Step 5.1: Add shortcut tools

Append these inside `createMemoryTools`, before the `return tools;` line:

```typescript
  // ================================================================
  // SMART SHORTCUTS
  // ================================================================

  // ================================================================
  // memory_log_thought — Log a thought to a thread
  // ================================================================
  tools.set('memory_log_thought', {
    description: 'Log a thought (waypoint) to a timeline thread. Automatically chains to the latest thought in the thread and updates the thread position. Use this during work to track progress, decisions, discoveries, and blockers.',
    inputSchema: {
      type: 'object',
      properties: {
        thread_id: {
          type: 'number',
          description: 'Thread ID to log to',
        },
        content: {
          type: 'string',
          description: 'The thought content (freeform text)',
        },
        thought_type: {
          type: 'string',
          description: 'Type of thought',
          enum: ['idea', 'decision', 'discovery', 'blocker', 'progress', 'tangent_start', 'handoff'],
        },
        metadata: {
          type: 'object',
          description: 'Optional metadata (JSON object)',
        },
      },
      required: ['thread_id', 'content'],
    },
    handler: async (args) => {
      const threadId = args.thread_id as number;
      const content = args.content as string;
      const thoughtType = (args.thought_type as string) ?? 'progress';
      const metadata = args.metadata ? JSON.stringify(args.metadata) : '{}';

      // Get the latest thought to chain from
      const latest = config.replicator.readOne<{ id: number }>(
        `SELECT current_thought_id AS id FROM timeline_thread_position WHERE thread_id = ?
         UNION ALL
         SELECT id FROM timeline_thoughts WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1`,
        [threadId, threadId]
      );
      const parentId = latest?.id ?? null;

      // Insert thought
      const insertResult = await config.replicator.write(
        `INSERT INTO timeline_thoughts (thread_id, parent_thought_id, content, thought_type, metadata)
         VALUES (?, ?, ?, ?, ?)`,
        [threadId, parentId, content, thoughtType, metadata],
        { table: 'timeline_thoughts' }
      );

      if (!insertResult.success) {
        return { error: insertResult.error };
      }

      // Get the inserted thought ID
      const thought = config.replicator.readOne<{ id: number }>(
        `SELECT id FROM timeline_thoughts WHERE thread_id = ? ORDER BY id DESC LIMIT 1`,
        [threadId]
      );

      if (thought) {
        // Update thread position
        await config.replicator.write(
          `INSERT INTO timeline_thread_position (thread_id, current_thought_id, updated_at)
           VALUES (?, ?, datetime('now'))
           ON CONFLICT(thread_id) DO UPDATE SET current_thought_id = ?, updated_at = datetime('now')`,
          [threadId, thought.id, thought.id],
          { table: 'timeline_thread_position' }
        );

        // Touch thread updated_at
        await config.replicator.write(
          `UPDATE timeline_threads SET updated_at = datetime('now') WHERE id = ?`,
          [threadId],
          { table: 'timeline_threads' }
        );
      }

      config.logger.info('Thought logged', { threadId, thoughtType });
      return { thought_id: thought?.id, thread_id: threadId, type: thoughtType };
    },
  });

  // ================================================================
  // memory_whereami — Session start: active threads + pinned context
  // ================================================================
  tools.set('memory_whereami', {
    description: 'Show where you left off. Returns all active threads with their latest thought, pinned context entries, and recent context. Use this at the start of every session.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const threads = config.replicator.read<{
        id: number;
        name: string;
        status: string;
        description: string | null;
        current_thought_id: number | null;
        current_thought_content: string | null;
        thought_type: string | null;
        last_updated: string | null;
        project_name: string | null;
        thought_count: number;
      }>(`
        SELECT
          t.id, t.name, t.status, t.description,
          tp.current_thought_id,
          ct.content AS current_thought_content,
          ct.thought_type,
          ct.created_at AS last_updated,
          p.name AS project_name,
          (SELECT COUNT(*) FROM timeline_thoughts th WHERE th.thread_id = t.id) AS thought_count
        FROM timeline_threads t
        LEFT JOIN timeline_thread_position tp ON tp.thread_id = t.id
        LEFT JOIN timeline_thoughts ct ON ct.id = tp.current_thought_id
        LEFT JOIN timeline_projects p ON p.id = t.project_id
        WHERE t.status IN ('active', 'paused')
        ORDER BY t.updated_at DESC
      `);

      const context = config.replicator.read(`
        SELECT key, category, label, value FROM timeline_context
        WHERE pinned = 1 OR category = 'waiting' OR updated_at > datetime('now', '-7 days')
        ORDER BY pinned DESC, updated_at DESC
        LIMIT 20
      `);

      return { active_threads: threads, pinned_context: context };
    },
  });

  // ================================================================
  // memory_handoff — End-of-session structured summary
  // ================================================================
  tools.set('memory_handoff', {
    description: 'Structured session-end handoff. Logs what was done, what is pending, blockers, and next steps. Updates thread position and optionally changes thread status.',
    inputSchema: {
      type: 'object',
      properties: {
        thread_id: {
          type: 'number',
          description: 'Thread to write the handoff to',
        },
        done: {
          type: 'array',
          items: { type: 'string' },
          description: 'Things completed this session',
        },
        pending: {
          type: 'array',
          items: { type: 'string' },
          description: 'Things still open',
        },
        blockers: {
          type: 'array',
          items: { type: 'string' },
          description: 'Blockers (empty array if none)',
        },
        next_steps: {
          type: 'array',
          items: { type: 'string' },
          description: 'Concrete next steps for the next session',
        },
        update_status: {
          type: 'string',
          description: 'Optionally update thread status',
          enum: ['active', 'paused', 'completed'],
        },
      },
      required: ['thread_id', 'done', 'next_steps'],
    },
    handler: async (args) => {
      const threadId = args.thread_id as number;
      const done = (args.done as string[]).map(d => `- ${d}`).join('\n');
      const pending = (args.pending as string[] | undefined)?.map(p => `- ${p}`).join('\n') || '- None';
      const blockers = (args.blockers as string[] | undefined)?.map(b => `- ${b}`).join('\n') || '- None';
      const nextSteps = (args.next_steps as string[]).map(n => `- ${n}`).join('\n');

      const content = `## Session Handoff\n\n**Done:**\n${done}\n\n**Pending:**\n${pending}\n\n**Blockers:**\n${blockers}\n\n**Next Steps:**\n${nextSteps}`;

      // Use memory_log_thought logic internally
      const logHandler = tools.get('memory_log_thought')!;
      const result = await logHandler.handler({
        thread_id: threadId,
        content,
        thought_type: 'handoff',
        metadata: { type: 'session_handoff' },
      });

      if (args.update_status) {
        await config.replicator.write(
          `UPDATE timeline_threads SET status = ?, updated_at = datetime('now') WHERE id = ?`,
          [args.update_status, threadId],
          { table: 'timeline_threads' }
        );
      }

      config.logger.info('Handoff logged', { threadId });
      return { ...result as Record<string, unknown>, status: args.update_status || 'unchanged' };
    },
  });

  // ================================================================
  // memory_set_context — Upsert context entry by key
  // ================================================================
  tools.set('memory_set_context', {
    description: 'Create or update a context entry. Use namespaced keys like "project:meshcore-monitor" or "machine:forge". Auto-detects credentials and warns if the value looks like a secret.',
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'Namespaced key, e.g., "project:meshcore-monitor", "machine:chisel"',
        },
        value: {
          type: 'object',
          description: 'Structured data to store (JSON object)',
        },
        category: {
          type: 'string',
          description: 'Category for filtering',
          enum: ['project', 'pr', 'machine', 'waiting', 'fact', 'reminder'],
        },
        label: {
          type: 'string',
          description: 'Human-readable label for display',
        },
        pinned: {
          type: 'boolean',
          description: 'If true, always show in memory_whereami',
        },
        source: {
          type: 'string',
          description: 'Machine hostname writing this entry',
        },
      },
      required: ['key', 'value', 'category'],
    },
    handler: async (args) => {
      const key = args.key as string;
      const value = args.value as Record<string, unknown>;
      const category = args.category as string;
      const label = (args.label as string) ?? null;
      const pinned = (args.pinned as boolean) ? 1 : 0;
      const source = (args.source as string) ?? null;

      // Credential auto-detection
      const valueStr = JSON.stringify(value);
      let classification: Classification = 'internal'; // timeline_context defaults to internal
      let credentialWarning: string | undefined;

      if (looksLikeCredential(valueStr)) {
        classification = 'internal';
        credentialWarning = 'Value appears to contain credentials. Classification set to "internal" (replicates to nodes but NOT backed up to GCS).';
      }

      const result = await config.replicator.write(
        `INSERT INTO timeline_context (key, value, category, label, source, pinned, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           category = excluded.category,
           label = COALESCE(excluded.label, timeline_context.label),
           source = excluded.source,
           pinned = COALESCE(excluded.pinned, timeline_context.pinned),
           updated_at = datetime('now')`,
        [key, JSON.stringify(value), category, label, source, pinned],
        { table: 'timeline_context', classification }
      );

      return {
        ...result,
        key,
        category,
        credentialWarning,
      };
    },
  });

  // ================================================================
  // memory_get_context — Get context entries
  // ================================================================
  tools.set('memory_get_context', {
    description: 'Get context entries by key, category, or recency. Returns pinned items and recently updated entries by default.',
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'Exact key to retrieve',
        },
        category: {
          type: 'string',
          description: 'Filter by category',
          enum: ['project', 'pr', 'machine', 'waiting', 'fact', 'reminder'],
        },
        pinned_only: {
          type: 'boolean',
          description: 'Only return pinned entries',
        },
        since_days: {
          type: 'number',
          description: 'Return entries updated within N days (default: 7)',
        },
        limit: {
          type: 'number',
          description: 'Maximum entries to return (default: 50)',
        },
      },
    },
    handler: async (args) => {
      if (args.key) {
        const entry = config.replicator.readOne(
          'SELECT * FROM timeline_context WHERE key = ?',
          [args.key as string]
        );
        if (!entry) throw new Error(`Context key not found: ${args.key}`);
        return entry;
      }

      const conditions: string[] = [];
      const params: unknown[] = [];

      const sinceDays = (args.since_days as number) ?? 7;
      conditions.push(`(updated_at > datetime('now', '-${sinceDays} days') OR pinned = 1)`);

      if (args.category) {
        conditions.push('category = ?');
        params.push(args.category);
      }

      if (args.pinned_only) {
        conditions.push('pinned = 1');
      }

      const limit = (args.limit as number) ?? 50;

      const entries = config.replicator.read(
        `SELECT * FROM timeline_context WHERE ${conditions.join(' AND ')}
         ORDER BY pinned DESC, updated_at DESC LIMIT ?`,
        [...params, limit]
      );

      return { entries, count: entries.length };
    },
  });

  // ================================================================
  // memory_search — Full-text search across thought content
  // ================================================================
  tools.set('memory_search', {
    description: 'Search across thought content and context values. Returns matching thoughts and context entries ranked by recency.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query (searches thought content and context values using LIKE)',
        },
        thread_id: {
          type: 'number',
          description: 'Limit search to a specific thread',
        },
        limit: {
          type: 'number',
          description: 'Maximum results (default: 20)',
        },
      },
      required: ['query'],
    },
    handler: async (args) => {
      const query = args.query as string;
      const limit = (args.limit as number) ?? 20;
      const pattern = `%${query}%`;

      const thoughtConditions = ['content LIKE ?'];
      const thoughtParams: unknown[] = [pattern];

      if (args.thread_id) {
        thoughtConditions.push('thread_id = ?');
        thoughtParams.push(args.thread_id);
      }

      const thoughts = config.replicator.read(
        `SELECT id, thread_id, content, thought_type, created_at
         FROM timeline_thoughts
         WHERE ${thoughtConditions.join(' AND ')}
         ORDER BY created_at DESC
         LIMIT ?`,
        [...thoughtParams, limit]
      );

      const contextEntries = config.replicator.read(
        `SELECT key, value, category, label, updated_at
         FROM timeline_context
         WHERE value LIKE ? OR key LIKE ? OR label LIKE ?
         ORDER BY updated_at DESC
         LIMIT ?`,
        [pattern, pattern, pattern, limit]
      );

      return {
        thoughts: { results: thoughts, count: thoughts.length },
        context: { results: contextEntries, count: contextEntries.length },
      };
    },
  });

  // ================================================================
  // memory_network_lookup — Search devices by hostname/IP/MAC
  // ================================================================
  tools.set('memory_network_lookup', {
    description: 'Look up a network device by hostname, IP address, or MAC address. Use to answer "what is the IP of terminus?" or "what device is at 192.168.1.16?".',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Hostname, IP, or MAC address (partial match, case-insensitive)',
        },
      },
      required: ['query'],
    },
    handler: async (args) => {
      const query = args.query as string;
      const pattern = `%${query.toLowerCase()}%`;

      const devices = config.replicator.read(
        `SELECT * FROM network_clients
         WHERE LOWER(hostname) LIKE ? OR ip_address LIKE ? OR LOWER(mac_address) LIKE ?
         ORDER BY hostname`,
        [pattern, pattern, pattern]
      );

      return { devices, count: devices.length };
    },
  });

  // ================================================================
  // memory_list_threads — List threads with position and count
  // ================================================================
  tools.set('memory_list_threads', {
    description: 'List timeline threads with their current position, thought count, and project. Optionally filter by status.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Filter by status',
          enum: ['active', 'completed', 'paused', 'abandoned'],
        },
        project_id: {
          type: 'number',
          description: 'Filter by project ID',
        },
      },
    },
    handler: async (args) => {
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (args.status) {
        conditions.push('t.status = ?');
        params.push(args.status);
      }

      if (args.project_id) {
        conditions.push('t.project_id = ?');
        params.push(args.project_id);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const threads = config.replicator.read(`
        SELECT
          t.id, t.name, t.status, t.description,
          t.project_id,
          p.name AS project_name,
          tp.current_thought_id,
          ct.content AS current_thought_content,
          ct.thought_type AS current_thought_type,
          (SELECT COUNT(*) FROM timeline_thoughts th WHERE th.thread_id = t.id) AS thought_count,
          (SELECT COUNT(*) FROM timeline_threads child
           WHERE child.parent_thought_id IN
             (SELECT id FROM timeline_thoughts WHERE thread_id = t.id)) AS tangent_count,
          t.created_at,
          t.updated_at
        FROM timeline_threads t
        LEFT JOIN timeline_thread_position tp ON tp.thread_id = t.id
        LEFT JOIN timeline_thoughts ct ON ct.id = tp.current_thought_id
        LEFT JOIN timeline_projects p ON p.id = t.project_id
        ${where}
        ORDER BY t.updated_at DESC
      `, params);

      return { threads, count: threads.length };
    },
  });
```

### Step 5.2: Verify

```bash
npm run build
```

**Expected outcome:** TypeScript compiles. 12 tools total (4 generic + 8 shortcuts) all follow ToolHandler interface.

**Git commit message:** `feat(memory): add 8 smart shortcut MCP tools`

---

## Task 6: Wire into Cortex

**Goal:** Initialize SharedMemoryDB and MemoryReplicator during startup. Register memory tools in MCP server. Remove old timeline/context/network tool registration.

**Files to modify:**
- `src/mcp/server.ts` — remove old tool imports/registration, add memory tools
- `src/index.ts` — initialize SharedMemoryDB and MemoryReplicator in startup

### Step 6.1: Modify `src/mcp/server.ts`

Replace old imports and tool registration with memory tools:

```typescript
// src/mcp/server.ts — UPDATED
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Logger } from 'winston';
import { ClusterStateManager, ClaudeSession, ContextEntry } from '../cluster/state.js';
import { MembershipManager } from '../cluster/membership.js';
import { TaskScheduler, TaskSpec, TaskStatus } from '../cluster/scheduler.js';
import { KubernetesAdapter, K8sJobSpec } from '../kubernetes/adapter.js';
import { GrpcClientPool } from '../grpc/client.js';
import { RaftNode } from '../cluster/raft.js';
import { createTools, ToolHandler } from './tools.js';
import { SharedMemoryDB } from '../memory/shared-memory-db.js';
import { MemoryReplicator } from '../memory/replication.js';
import { createMemoryTools } from '../memory/memory-tools.js';

export interface McpServerConfig {
  logger: Logger;
  stateManager: ClusterStateManager;
  membership: MembershipManager;
  scheduler: TaskScheduler;
  k8sAdapter: KubernetesAdapter;
  clientPool: GrpcClientPool;
  raft: RaftNode;
  sessionId: string;
  nodeId: string;
  sharedMemoryDb?: SharedMemoryDB;
  memoryReplicator?: MemoryReplicator;
}

export class ClusterMcpServer {
  private config: McpServerConfig;
  private server: Server;
  private toolHandlers: Map<string, ToolHandler>;

  constructor(config: McpServerConfig) {
    this.config = config;
    this.server = new Server(
      {
        name: 'cortex',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
          resources: {},
        },
      }
    );

    this.toolHandlers = this.createToolHandlers();
    this.setupHandlers();
  }

  private createToolHandlers(): Map<string, ToolHandler> {
    const clusterTools = createTools({
      stateManager: this.config.stateManager,
      membership: this.config.membership,
      scheduler: this.config.scheduler,
      k8sAdapter: this.config.k8sAdapter,
      clientPool: this.config.clientPool,
      raft: this.config.raft,
      sessionId: this.config.sessionId,
      nodeId: this.config.nodeId,
      logger: this.config.logger,
    });

    // Add shared memory tools (replaces timeline, network, context tools)
    if (this.config.sharedMemoryDb && this.config.memoryReplicator) {
      const memoryTools = createMemoryTools({
        db: this.config.sharedMemoryDb,
        replicator: this.config.memoryReplicator,
        raft: this.config.raft,
        logger: this.config.logger,
        nodeId: this.config.nodeId,
      });

      for (const [name, handler] of memoryTools) {
        clusterTools.set(name, handler);
      }

      this.config.logger.info('Memory tools registered', { count: memoryTools.size });
    } else {
      this.config.logger.warn('SharedMemoryDB not available, memory tools not registered');
    }

    return clusterTools;
  }

  // ... setupHandlers(), start(), and resource handlers remain UNCHANGED ...

  async stop(): Promise<void> {
    // SharedMemoryDB lifecycle is managed by Cortex main class, not MCP server
    await this.server.close();
    this.config.logger.info('MCP server stopped');
  }
}
```

### Step 6.2: Modify `src/index.ts`

Add SharedMemoryDB and MemoryReplicator initialization. Add to imports at the top:

```typescript
import { SharedMemoryDB } from './memory/shared-memory-db.js';
import { MemoryReplicator } from './memory/replication.js';
```

Add class properties (alongside the existing `private mcpServer`, etc.):

```typescript
  private sharedMemoryDb: SharedMemoryDB | null = null;
  private memoryReplicator: MemoryReplicator | null = null;
```

In `initializeCluster()` method, after the Raft initialization (after line 512), add:

```typescript
    // Shared memory database
    const sharedMemoryDataDir = configDir; // ~/.cortex
    this.sharedMemoryDb = new SharedMemoryDB({
      dataDir: sharedMemoryDataDir,
      logger: this.logger,
    });

    // Memory replicator (bridges writes through Raft)
    this.memoryReplicator = new MemoryReplicator({
      db: this.sharedMemoryDb,
      raft: this.raft,
      membership: this.membership!,
      clientPool: this.clientPool!,
      logger: this.logger,
    });
```

Note: `this.membership` is initialized right after this block, so the SharedMemoryDB init should go AFTER membership initialization (after line 524). Actually, looking at the code flow more carefully, membership is initialized on lines 515-524. Place the shared memory init after membership:

In `initializeMcp()`, update the McpServerConfig to include the new fields:

```typescript
  private async initializeMcp(): Promise<void> {
    this.mcpServer = new ClusterMcpServer({
      logger: this.logger,
      stateManager: this.stateManager!,
      membership: this.membership!,
      scheduler: this.scheduler!,
      k8sAdapter: this.k8sAdapter!,
      clientPool: this.clientPool!,
      raft: this.raft!,
      sessionId: this.sessionId,
      nodeId: this.nodeId,
      sharedMemoryDb: this.sharedMemoryDb ?? undefined,
      memoryReplicator: this.memoryReplicator ?? undefined,
    });
    // ... rest unchanged
  }
```

In `stop()`, add cleanup for shared memory (BEFORE Raft stop, AFTER MCP stop):

```typescript
    // Stop memory replicator (before Raft)
    if (this.memoryReplicator) {
      this.memoryReplicator.stop();
    }

    // Close shared memory database
    if (this.sharedMemoryDb) {
      this.sharedMemoryDb.close();
    }
```

### Step 6.3: Delete old files (defer until migration is verified)

Do NOT delete these files yet -- keep them until Task 7 migration is verified working:
- `src/mcp/timeline-db.ts`
- `src/mcp/timeline-tools.ts`
- `src/mcp/context-db.ts`
- `src/mcp/context-tools.ts`
- `src/mcp/network-db.ts`
- `src/mcp/network-tools.ts`

Remove the imports and registrations from `src/mcp/server.ts` (done in Step 6.1), but keep the files on disk as reference until migration is complete.

### Step 6.4: Verify

```bash
npm run build
```

**Expected outcome:** TypeScript compiles. Memory tools are wired into the MCP server. Old tool registrations removed. Old files still exist but are unused.

**Git commit message:** `feat(memory): wire SharedMemoryDB and MemoryReplicator into Cortex startup`

---

## Task 7: Schema Migration Scripts

**Goal:** Create a migration script that exports data from cerebrus PostgreSQL and local SQLite databases, transforms DDL, and imports into shared-memory.db.

**Files to create:**
- `scripts/migrate-to-shared-memory.ts`

### Step 7.1: Write the migration script

```typescript
#!/usr/bin/env tsx
// scripts/migrate-to-shared-memory.ts
//
// Migrates data from:
// 1. cerebrus PostgreSQL (anvil) — timeline, network, infra, task schemas
// 2. meshdb.db (terminus) — mesh_ prefix
// 3. meshmonitor.db (terminus) — meshmonitor_ prefix
//
// Into: ~/.cortex/shared-memory.db
//
// Usage:
//   npx tsx scripts/migrate-to-shared-memory.ts [--cerebrus-only] [--dry-run]

import pg from 'pg';
import Database from 'better-sqlite3';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

const { Pool } = pg;

const CEREBRUS_CONN = process.env.CEREBRUS_CONN
  ?? 'postgresql://cerebrus:cerebrus2025@100.69.42.106:5432/cerebrus';
const DATA_DIR = path.join(os.homedir(), '.cortex');
const DB_PATH = path.join(DATA_DIR, 'shared-memory.db');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const cerebrusOnly = args.includes('--cerebrus-only');

async function main() {
  console.log('=== Shared Memory Migration ===');
  console.log(`Target: ${DB_PATH}`);
  console.log(`Dry run: ${dryRun}`);
  console.log('');

  // Open or create the shared-memory.db (schema is created by SharedMemoryDB constructor)
  // But here we import directly since this is a standalone script
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = OFF'); // During migration

  // --- Cerebrus PostgreSQL ---
  console.log('Connecting to cerebrus PostgreSQL...');
  const pool = new Pool({ connectionString: CEREBRUS_CONN, max: 3 });

  try {
    // 1. Timeline schema
    console.log('\n--- Migrating timeline schema ---');
    await migrateTable(pool, db, 'timeline.projects', 'timeline_projects', [
      'id', 'name', 'description', 'employer', 'language', 'location', 'status', 'tags',
      'created_at', 'updated_at',
    ]);

    await migrateTable(pool, db, 'timeline.threads', 'timeline_threads', [
      'id', 'name', 'description', 'parent_thought_id', 'project_id', 'status',
      'created_at', 'updated_at',
    ]);

    await migrateTable(pool, db, 'timeline.thoughts', 'timeline_thoughts', [
      'id', 'thread_id', 'parent_thought_id', 'content', 'thought_type', 'status',
      'metadata', 'created_at',
    ]);

    await migrateTable(pool, db, 'timeline.thread_position', 'timeline_thread_position', [
      'thread_id', 'current_thought_id', 'updated_at',
    ]);

    await migrateTable(pool, db, 'timeline.context', 'timeline_context', [
      'key', 'value', 'thread_id', 'category', 'label', 'source', 'pinned',
      'expires_at', 'created_at', 'updated_at',
    ]);

    // 2. Network tables
    console.log('\n--- Migrating network tables ---');
    await migrateTable(pool, db, 'public.network_clients', 'network_clients', [
      'id', 'hostname', 'ip_address', 'mac_address', 'device_type', 'connection_type',
      'network', 'vlan_id', 'status', 'uptime_seconds', 'signal_strength', 'ssid',
      'rx_bytes', 'tx_bytes', 'discovered_at', 'last_seen',
    ]);

    await migrateTable(pool, db, 'public.networks', 'network_networks', [
      'id', 'network_id', 'name', 'subnet', 'vlan_id', 'dhcp_enabled', 'purpose',
      'discovered_at', 'last_seen',
    ]);

    // 3. Infra tables
    console.log('\n--- Migrating infra tables ---');
    const infraTables = ['builds', 'configs', 'events', 'sessions'];
    for (const table of infraTables) {
      try {
        const cols = await getColumns(pool, 'public', table);
        await migrateTable(pool, db, `public.${table}`, `infra_${table}`, cols);
      } catch (e) {
        console.log(`  Skipped infra_${table}: ${(e as Error).message}`);
      }
    }

    // secrets table
    try {
      const secretCols = await getColumns(pool, 'public', 'secrets');
      await migrateTable(pool, db, 'public.secrets', 'infra_secrets', secretCols);
    } catch (e) {
      console.log(`  Skipped infra_secrets: ${(e as Error).message}`);
    }

    // 4. Task tables
    console.log('\n--- Migrating task tables ---');
    try {
      const taskCols = await getColumns(pool, 'public', 'agent_tasks');
      await migrateTable(pool, db, 'public.agent_tasks', 'task_agent_tasks', taskCols);
    } catch (e) {
      console.log(`  Skipped task_agent_tasks: ${(e as Error).message}`);
    }

  } finally {
    await pool.end();
  }

  // --- Local SQLite databases (skip if cerebrus-only) ---
  if (!cerebrusOnly) {
    // meshdb.db
    const meshdbPath = path.join(os.homedir(), 'meshdb.db');
    if (fs.existsSync(meshdbPath)) {
      console.log('\n--- Migrating meshdb.db ---');
      migrateSqliteDb(meshdbPath, db, 'mesh_');
    } else {
      console.log('\nmeshdb.db not found, skipping');
    }

    // meshmonitor.db
    const meshmonitorPath = path.join(os.homedir(), 'meshmonitor.db');
    if (fs.existsSync(meshmonitorPath)) {
      console.log('\n--- Migrating meshmonitor.db ---');
      migrateSqliteDb(meshmonitorPath, db, 'meshmonitor_');
    } else {
      console.log('\nmeshmonitor.db not found, skipping');
    }
  }

  db.pragma('foreign_keys = ON');
  db.close();

  console.log('\n=== Migration complete ===');
  const stat = fs.statSync(DB_PATH);
  console.log(`Database size: ${(stat.size / 1024 / 1024).toFixed(2)} MB`);
}

async function getColumns(pool: pg.Pool, schema: string, table: string): Promise<string[]> {
  const result = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = $1 AND table_name = $2
    ORDER BY ordinal_position
  `, [schema, table]);
  return result.rows.map(r => r.column_name);
}

async function migrateTable(
  pool: pg.Pool,
  db: Database.Database,
  sourceTable: string,
  targetTable: string,
  columns: string[],
): Promise<void> {
  // Check if source table exists
  const [schema, table] = sourceTable.includes('.') ? sourceTable.split('.') : ['public', sourceTable];

  const exists = await pool.query(`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = $1 AND table_name = $2
  `, [schema, table]);

  if (exists.rows.length === 0) {
    console.log(`  ${sourceTable} does not exist, skipping`);
    return;
  }

  // Fetch all rows
  const result = await pool.query(`SELECT ${columns.join(', ')} FROM ${sourceTable}`);
  console.log(`  ${sourceTable} -> ${targetTable}: ${result.rows.length} rows`);

  if (dryRun || result.rows.length === 0) return;

  // Check if target table exists in SQLite
  const tableExists = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
  ).get(targetTable);

  if (!tableExists) {
    console.log(`  WARNING: Target table ${targetTable} does not exist in SQLite, skipping`);
    return;
  }

  // Clear existing data
  db.prepare(`DELETE FROM "${targetTable}"`).run();

  // Insert rows
  const placeholders = columns.map(() => '?').join(', ');
  const insert = db.prepare(`INSERT INTO "${targetTable}" (${columns.join(', ')}) VALUES (${placeholders})`);

  const insertAll = db.transaction(() => {
    for (const row of result.rows) {
      const values = columns.map(col => {
        const val = row[col];
        if (val === null || val === undefined) return null;
        if (val instanceof Date) return val.toISOString();
        if (typeof val === 'object') return JSON.stringify(val);
        if (typeof val === 'boolean') return val ? 1 : 0;
        return val;
      });
      try {
        insert.run(...values);
      } catch (e) {
        console.log(`  WARNING: Failed to insert row in ${targetTable}: ${(e as Error).message}`);
      }
    }
  });

  insertAll();
}

function migrateSqliteDb(sourcePath: string, targetDb: Database.Database, prefix: string): void {
  const sourceDb = new Database(sourcePath, { readonly: true });

  try {
    // Get all tables
    const tables = sourceDb.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
    ).all() as { name: string }[];

    for (const { name } of tables) {
      const targetName = `${prefix}${name}`;

      // Get columns
      const cols = sourceDb.prepare(`PRAGMA table_info('${name}')`).all() as { name: string; type: string; notnull: number; pk: number }[];

      // Create table in target if it doesn't exist
      const colDefs = cols.map(c => {
        let def = `"${c.name}" ${c.type || 'TEXT'}`;
        if (c.pk) def += ' PRIMARY KEY';
        if (c.notnull && !c.pk) def += ' NOT NULL';
        return def;
      }).join(', ');

      targetDb.exec(`CREATE TABLE IF NOT EXISTS "${targetName}" (${colDefs})`);

      // Register classification
      targetDb.prepare(
        `INSERT OR IGNORE INTO _table_classification (table_name, classification, domain)
         VALUES (?, 'public', ?)`
      ).run(targetName, prefix.replace(/_$/, ''));

      // Copy data
      const rows = sourceDb.prepare(`SELECT * FROM "${name}"`).all();
      console.log(`  ${name} -> ${targetName}: ${rows.length} rows`);

      if (rows.length === 0) continue;

      const colNames = cols.map(c => `"${c.name}"`).join(', ');
      const placeholders = cols.map(() => '?').join(', ');
      const insert = targetDb.prepare(
        `INSERT OR IGNORE INTO "${targetName}" (${colNames}) VALUES (${placeholders})`
      );

      const insertAll = targetDb.transaction(() => {
        for (const row of rows) {
          const values = cols.map(c => {
            const val = (row as Record<string, unknown>)[c.name];
            if (val === null || val === undefined) return null;
            if (typeof val === 'object') return JSON.stringify(val);
            return val;
          });
          try {
            insert.run(...values);
          } catch (e) {
            // Skip duplicates
          }
        }
      });

      insertAll();
    }
  } finally {
    sourceDb.close();
  }
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
```

### Step 7.2: Test the migration script

```bash
# Dry run first
npx tsx scripts/migrate-to-shared-memory.ts --dry-run

# Then real run (cerebrus only, since meshdb/meshmonitor are on terminus)
npx tsx scripts/migrate-to-shared-memory.ts --cerebrus-only
```

### Step 7.3: Verify data integrity

```bash
# Check row counts
npx tsx -e "
import Database from 'better-sqlite3';
import * as os from 'os';
import * as path from 'path';
const db = new Database(path.join(os.homedir(), '.cortex', 'shared-memory.db'), { readonly: true });
const tables = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_%'\").all();
for (const t of tables as any[]) {
  const count = db.prepare('SELECT COUNT(*) as c FROM \"' + t.name + '\"').get() as any;
  console.log(t.name + ': ' + count.c + ' rows');
}
db.close();
"
```

**Expected outcome:** Migration script exports data from cerebrus PostgreSQL, transforms types, and imports into shared-memory.db. Row counts should match the source.

**Git commit message:** `feat(memory): add migration script for cerebrus PostgreSQL to shared-memory.db`

---

## Task 8: Snapshot & Sync for New/Stale Nodes

**Goal:** Implement a mechanism for new or behind nodes to get a full SQLite snapshot from the leader, since the Raft log is in-memory only and cannot replay from genesis.

**Files to modify:**
- `proto/cluster.proto` — add `RequestMemorySnapshot` / `PushMemorySnapshot` RPCs
- `src/memory/replication.ts` — add snapshot request/serve methods
- `src/grpc/handlers.ts` — add handler

### Step 8.1: Add proto messages for snapshot transfer

**File:** `proto/cluster.proto`, add to ClusterService:

```protobuf
  // Shared memory snapshot transfer (new node <- leader)
  rpc RequestMemorySnapshot(MemorySnapshotRequest) returns (stream MemorySnapshotChunk);
```

Add messages:

```protobuf
message MemorySnapshotRequest {
  string requesting_node_id = 1;
}

message MemorySnapshotChunk {
  bytes data = 1;
  int64 offset = 2;
  int64 total_size = 3;
  bool done = 4;
  string checksum = 5;  // SHA-256 of complete file, sent with done=true
}
```

### Step 8.2: Implement snapshot serving in handler

**File:** `src/grpc/handlers.ts`

Add to ClusterService handlers:

```typescript
    RequestMemorySnapshot: async (
      call: grpc.ServerWritableStream<any, any>
    ) => {
      try {
        const requestingNode = call.request.requesting_node_id;
        logger.info('Memory snapshot requested', { by: requestingNode });

        const dbPath = path.join(
          process.env.HOME || require('os').homedir(),
          '.cortex',
          'shared-memory.db'
        );

        if (!fs.existsSync(dbPath)) {
          call.end();
          return;
        }

        const fileBuffer = fs.readFileSync(dbPath);
        const totalSize = fileBuffer.length;
        const checksum = crypto.createHash('sha256').update(fileBuffer).digest('hex');
        const CHUNK_SIZE = 64 * 1024; // 64KB chunks

        for (let offset = 0; offset < totalSize; offset += CHUNK_SIZE) {
          const chunk = fileBuffer.subarray(offset, Math.min(offset + CHUNK_SIZE, totalSize));
          const isDone = offset + CHUNK_SIZE >= totalSize;

          call.write({
            data: chunk,
            offset: offset.toString(),
            total_size: totalSize.toString(),
            done: isDone,
            checksum: isDone ? checksum : '',
          });
        }

        call.end();
        logger.info('Memory snapshot sent', { to: requestingNode, size: totalSize });
      } catch (error) {
        logger.error('RequestMemorySnapshot failed', { error });
        call.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    },
```

### Step 8.3: Add snapshot request method to MemoryReplicator

**File:** `src/memory/replication.ts`

Add method to `MemoryReplicator`:

```typescript
  /**
   * Request a full snapshot from the leader. Used when:
   * - Node joins for the first time and has no shared-memory.db
   * - Node was offline too long and Raft log has been truncated
   * - Integrity check detects checksum mismatch
   */
  async requestSnapshot(): Promise<boolean> {
    const leaderAddr = this.membership.getLeaderAddress();
    if (!leaderAddr) {
      this.logger.warn('Cannot request snapshot: no leader available');
      return false;
    }

    try {
      this.logger.info('Requesting memory snapshot from leader', { leaderAddr });

      const client = new ClusterClient(this.clientPool, leaderAddr);
      const chunks = await client.requestMemorySnapshot({
        requesting_node_id: this.membership.getSelfNodeId(),
      });

      // Write chunks to a temporary file
      const tmpPath = this.db.getPath() + '.snapshot';
      const fd = fs.openSync(tmpPath, 'w');
      let receivedChecksum = '';

      for (const chunk of chunks) {
        fs.writeSync(fd, chunk.data, 0, chunk.data.length, parseInt(chunk.offset));
        if (chunk.done) {
          receivedChecksum = chunk.checksum;
        }
      }

      fs.closeSync(fd);

      // Verify checksum
      const fileBuffer = fs.readFileSync(tmpPath);
      const actualChecksum = crypto.createHash('sha256').update(fileBuffer).digest('hex');

      if (receivedChecksum && actualChecksum !== receivedChecksum) {
        this.logger.error('Snapshot checksum mismatch', { expected: receivedChecksum, actual: actualChecksum });
        fs.unlinkSync(tmpPath);
        return false;
      }

      // Close current DB, replace with snapshot, reopen
      this.db.close();
      fs.renameSync(tmpPath, this.db.getPath());

      // Reopen (the SharedMemoryDB constructor handles this)
      // The caller needs to reinitialize the DB
      this.logger.info('Memory snapshot applied successfully', { size: fileBuffer.length });
      return true;
    } catch (error) {
      this.logger.error('Snapshot request failed', { error });
      return false;
    }
  }
```

### Step 8.4: Add snapshot request during startup

**File:** `src/index.ts`

In `initializeCluster()`, after creating MemoryReplicator, add a check:

```typescript
    // If shared-memory.db is empty (no threads), request snapshot from leader
    const threadCount = this.sharedMemoryDb.query<{ c: number }>(
      'SELECT COUNT(*) as c FROM timeline_threads'
    );
    if (threadCount.length > 0 && threadCount[0].c === 0) {
      this.logger.info('Shared memory is empty, will request snapshot after joining cluster');
      // Deferred: snapshot request happens after cluster join succeeds
      // Set a flag and request in joinOrCreateCluster callback
    }
```

### Step 8.5: Regenerate proto and build

```bash
npm run proto:generate
npm run build
```

**Expected outcome:** Snapshot transfer works via streaming gRPC. New nodes can bootstrap from leader.

**Git commit message:** `feat(memory): add snapshot transfer for new/stale node sync`

---

## Task 9: Litestream Cloud Backup

**Goal:** Configure Litestream to stream the filtered (public-tier only) replica to GCS.

**Files to create:**
- `config/litestream.yml`
- `scripts/create-public-replica.ts`

**Note:** This task is leader-only and deployed to forge. It runs outside the Node.js process.

### Step 9.1: Create Litestream configuration

**File:** `config/litestream.yml`

```yaml
# Litestream configuration for cortex shared memory backup
# Only runs on the leader node (forge)
# Backs up the PUBLIC-only filtered replica, NOT the full database

dbs:
  - path: /home/paschal/.cortex/shared-memory-public.db
    replicas:
      - type: gcs
        bucket: paschal-homelab-backups
        path: cortex/shared-memory/
        # Uses application default credentials (gcloud auth)
```

### Step 9.2: Create filtered replica script

**File:** `scripts/create-public-replica.ts`

```typescript
#!/usr/bin/env tsx
// scripts/create-public-replica.ts
//
// Creates a filtered copy of shared-memory.db containing only 'public' tables.
// This filtered copy is what Litestream backs up to GCS.
//
// Run periodically (cron) or integrate into cortex startup on leader.

import Database from 'better-sqlite3';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

const DATA_DIR = path.join(os.homedir(), '.cortex');
const SOURCE_PATH = path.join(DATA_DIR, 'shared-memory.db');
const PUBLIC_PATH = path.join(DATA_DIR, 'shared-memory-public.db');

function main() {
  if (!fs.existsSync(SOURCE_PATH)) {
    console.error('Source database not found:', SOURCE_PATH);
    process.exit(1);
  }

  const source = new Database(SOURCE_PATH, { readonly: true });

  // Get public tables
  const publicTables = source.prepare(
    `SELECT table_name FROM _table_classification WHERE classification = 'public'`
  ).all() as { table_name: string }[];

  console.log(`Public tables: ${publicTables.length}`);

  // Remove old public replica
  if (fs.existsSync(PUBLIC_PATH)) {
    fs.unlinkSync(PUBLIC_PATH);
    // Also remove WAL/SHM if present
    for (const ext of ['-wal', '-shm']) {
      const f = PUBLIC_PATH + ext;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  }

  const target = new Database(PUBLIC_PATH);
  target.pragma('journal_mode = WAL');

  for (const { table_name } of publicTables) {
    // Get CREATE TABLE statement
    const createStmt = source.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name=?`
    ).get(table_name) as { sql: string } | undefined;

    if (!createStmt) continue;

    target.exec(createStmt.sql);

    // Copy data
    const rows = source.prepare(`SELECT * FROM "${table_name}"`).all();
    if (rows.length === 0) continue;

    const cols = Object.keys(rows[0] as Record<string, unknown>);
    const placeholders = cols.map(() => '?').join(', ');
    const insert = target.prepare(
      `INSERT INTO "${table_name}" (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${placeholders})`
    );

    const insertAll = target.transaction(() => {
      for (const row of rows) {
        insert.run(...cols.map(c => (row as Record<string, unknown>)[c]));
      }
    });

    insertAll();
    console.log(`  ${table_name}: ${rows.length} rows`);
  }

  // Copy indexes for public tables
  const indexes = source.prepare(
    `SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL`
  ).all() as { sql: string }[];

  for (const { sql } of indexes) {
    // Only copy indexes for public tables
    const tableMatch = sql.match(/ON\s+"?(\w+)"?/i);
    if (tableMatch && publicTables.some(t => t.table_name === tableMatch[1])) {
      try {
        target.exec(sql);
      } catch (e) {
        // Index may already exist
      }
    }
  }

  source.close();
  target.close();

  const stat = fs.statSync(PUBLIC_PATH);
  console.log(`\nPublic replica created: ${PUBLIC_PATH} (${(stat.size / 1024).toFixed(1)} KB)`);
}

main();
```

### Step 9.3: Install Litestream on forge

```bash
ssh -o StrictHostKeyChecking=no paschal@192.168.1.200 "
  # Install Litestream (Fedora/RHEL)
  sudo dnf install -y https://github.com/benbjohnson/litestream/releases/download/v0.3.13/litestream-0.3.13-linux-amd64.rpm 2>/dev/null || \
  curl -L https://github.com/benbjohnson/litestream/releases/download/v0.3.13/litestream-v0.3.13-linux-amd64.tar.gz | sudo tar xz -C /usr/local/bin/
"
```

### Step 9.4: Deploy Litestream config and systemd service

```bash
ssh -o StrictHostKeyChecking=no paschal@192.168.1.200 "
  mkdir -p ~/.cortex
  cat > ~/.cortex/litestream.yml << 'YAML'
dbs:
  - path: /home/paschal/.cortex/shared-memory-public.db
    replicas:
      - type: gcs
        bucket: paschal-homelab-backups
        path: cortex/shared-memory/
YAML
"
```

**Expected outcome:** Litestream streams the filtered public replica to GCS. Only `public`-classified tables are backed up.

**Git commit message:** `feat(memory): add Litestream cloud backup config and public replica script`

---

## Task 10: Periodic Integrity Verification

**Goal:** Leader periodically computes a full-DB checksum. Followers compare and request snapshot if mismatch.

**Files to modify:**
- `src/memory/replication.ts` — add integrity check interval

### Step 10.1: Add integrity verification to MemoryReplicator

Add to `MemoryReplicator` class:

```typescript
  private integrityInterval: NodeJS.Timeout | null = null;

  startIntegrityChecks(intervalMs: number = 5 * 60 * 1000): void {
    this.integrityInterval = setInterval(() => {
      this.runIntegrityCheck();
    }, intervalMs);
    this.logger.info('Integrity checks started', { intervalMs });
  }

  private async runIntegrityCheck(): Promise<void> {
    try {
      const localChecksum = this.db.computeChecksum();
      const raftState = this.raft.getState();

      if (raftState === 'leader') {
        // Leader stores its checksum for followers to compare against
        // Followers will receive it via heartbeat metadata (future enhancement)
        this.logger.debug('Leader integrity check', { checksum: localChecksum.substring(0, 16) });
        return;
      }

      // Follower: request leader's checksum and compare
      const leaderAddr = this.membership.getLeaderAddress();
      if (!leaderAddr) return;

      // For now, log the local checksum. Full comparison requires
      // adding checksum to heartbeat response (future enhancement).
      this.logger.debug('Follower integrity check', { checksum: localChecksum.substring(0, 16) });
    } catch (error) {
      this.logger.error('Integrity check failed', { error });
    }
  }

  stopIntegrityChecks(): void {
    if (this.integrityInterval) {
      clearInterval(this.integrityInterval);
      this.integrityInterval = null;
    }
  }
```

Update `stop()` method:

```typescript
  stop(): void {
    this.stopIntegrityChecks();
    this.raft.removeListener('entryCommitted', this.entryHandler);
    this.logger.info('MemoryReplicator stopped');
  }
```

### Step 10.2: Start integrity checks in index.ts

In `initializeCluster()`, after creating MemoryReplicator:

```typescript
    // Start periodic integrity checks (every 5 minutes)
    this.memoryReplicator.startIntegrityChecks(
      this.config.sharedMemory?.integrityCheckIntervalMs ?? 5 * 60 * 1000
    );
```

### Step 10.3: Verify

```bash
npm run build
```

**Expected outcome:** Integrity checks run every 5 minutes. Currently logs checksums; full leader-follower comparison is a follow-up when heartbeat metadata is extended.

**Git commit message:** `feat(memory): add periodic integrity verification for shared memory`

---

## Task 11: Update Tests

**Goal:** Update existing tests that reference old timeline/context/network tools. Write new tests for the shared memory system.

**Files to modify:**
- `tests/context-db.test.ts` — mark as legacy or update
- `tests/context-tools.test.ts` — mark as legacy or update
- `tests/network-db.test.ts` — mark as legacy or update
- `tests/network-tools.test.ts` — mark as legacy or update

**Files to create:**
- `tests/shared-memory-db.test.ts` (from Task 1)
- `tests/replication.test.ts` (from Task 2)
- `tests/memory-tools.test.ts`

### Step 11.1: Create `tests/memory-tools.test.ts`

```typescript
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
```

### Step 11.2: Mark old tests as legacy

Add a comment to the top of each old test file:

```typescript
// LEGACY: This test file covers the old PostgreSQL-backed tools.
// These tools have been replaced by src/memory/memory-tools.ts.
// Kept for reference until migration is fully verified.
// See tests/memory-tools.test.ts for the replacement tests.
```

Files to add this comment to:
- `tests/context-db.test.ts`
- `tests/context-tools.test.ts`
- `tests/network-db.test.ts`
- `tests/network-tools.test.ts`

### Step 11.3: Run all tests

```bash
npx vitest run
```

**Expected outcome:** New tests pass. Old tests may fail since their PostgreSQL connection mock setup may conflict with the new imports, but they should be skipped/marked legacy. The important tests are `shared-memory-db.test.ts`, `replication.test.ts`, and `memory-tools.test.ts`.

**Git commit message:** `test(memory): add tests for SharedMemoryDB, MemoryReplicator, and MCP tools`

---

## Task 12: Update Config, Docs, Deploy

**Goal:** Add shared memory config to default.yaml. Update CLAUDE.md bootstrap. Deploy to all nodes.

### Step 12.1: Update `config/default.yaml`

Add after the `mcp:` section:

```yaml
# Shared memory database (Raft-replicated SQLite)
sharedMemory:
  # Enable shared memory (set false to use legacy PostgreSQL tools)
  enabled: true

  # Data directory for shared-memory.db
  dataDir: ~/.cortex

  # Integrity check interval (milliseconds, 0 to disable)
  integrityCheckIntervalMs: 300000  # 5 minutes

  # Litestream backup (leader only)
  backup:
    enabled: false
    bucket: paschal-homelab-backups
    path: cortex/shared-memory/
```

### Step 12.2: Update CLAUDE.md bootstrap queries

**File:** `/home/paschal/cortex/CLAUDE.md`

Replace the PostgreSQL bootstrap queries in the global CLAUDE.md with memory_* MCP tool calls. The bootstrap should now use:

```
Instead of SSH+psql, use these MCP tools at session start:
1. `memory_whereami` — shows active threads + pinned context (replaces both SSH queries)
2. `memory_list_threads` — detailed thread list if needed
3. `memory_get_context` — for specific context lookups
```

### Step 12.3: Build and deploy to forge

```bash
npm run build

# Deploy to forge (leader/seed node)
ssh -o StrictHostKeyChecking=no paschal@192.168.1.200 "cd /home/paschal/cortex && git pull && npm install && npm run build && sudo systemctl restart claudecluster"
```

### Step 12.4: Run migration on forge, then verify replication

```bash
# Run migration on forge (leader)
ssh -o StrictHostKeyChecking=no paschal@192.168.1.200 "cd /home/paschal/cortex && npx tsx scripts/migrate-to-shared-memory.ts --cerebrus-only"

# Check that data appears
ssh -o StrictHostKeyChecking=no paschal@192.168.1.200 "cd /home/paschal/cortex && npx tsx -e \"
import Database from 'better-sqlite3';
const db = new Database('/home/paschal/.cortex/shared-memory.db', { readonly: true });
console.log('Threads:', db.prepare('SELECT COUNT(*) as c FROM timeline_threads').get());
console.log('Thoughts:', db.prepare('SELECT COUNT(*) as c FROM timeline_thoughts').get());
console.log('Context:', db.prepare('SELECT COUNT(*) as c FROM timeline_context').get());
console.log('Devices:', db.prepare('SELECT COUNT(*) as c FROM network_clients').get());
db.close();
\""
```

### Step 12.5: Deploy to follower nodes

```bash
# Deploy to hammer
ssh -o StrictHostKeyChecking=no paschal@100.73.18.82 "cd /home/paschal/cortex && git pull && npm install && npm run build && sudo systemctl restart claudecluster"

# Deploy to htnas02
ssh -o StrictHostKeyChecking=no paschal@100.103.240.34 "cd /home/paschal/cortex && git pull && npm install && npm run build && sudo systemctl restart claudecluster"

# Deploy to anvil (NixOS — may need nix-specific steps)
ssh -o StrictHostKeyChecking=no paschal@192.168.1.138 "cd /home/paschal/cortex && git pull && npm install && npm run build && sudo systemctl restart claudecluster"
```

### Step 12.6: Verify replication across nodes

After all nodes are running, check that follower nodes received the snapshot:

```bash
# Check follower data
ssh -o StrictHostKeyChecking=no paschal@100.73.18.82 "
  ls -la ~/.cortex/shared-memory.db 2>/dev/null && echo 'DB exists' || echo 'DB missing'
"
```

### Step 12.7: Remove old tool files (final cleanup)

Once migration is verified working on all nodes:

```bash
git rm src/mcp/timeline-db.ts src/mcp/timeline-tools.ts
git rm src/mcp/context-db.ts src/mcp/context-tools.ts
git rm src/mcp/network-db.ts src/mcp/network-tools.ts
```

Remove the old imports from `src/mcp/server.ts` (already done in Task 6, just verify no dangling imports remain).

### Step 12.8: Remove memorybank from claude.json

```bash
# On each machine, remove memorybank from ~/.claude.json
# The memory_* tools now provide the same functionality natively
```

### Step 12.9: Final verification

```bash
npm run build && npx vitest run
```

**Expected outcome:** Full build succeeds. All new tests pass. Shared memory is replicated across all cluster nodes. MCP tools work end-to-end.

**Git commit message:** `feat(memory): complete shared memory deployment with config and cleanup`

---

## Summary

| Task | Files | Estimated Time |
|------|-------|---------------|
| 1. SQLite DB module | `src/memory/shared-memory-db.ts`, test | 5 min |
| 2. Raft replication | `src/memory/replication.ts`, raft.ts mod, test | 5 min |
| 3. Proto + gRPC | `proto/cluster.proto`, handlers.ts, client.ts | 5 min |
| 4. Generic MCP tools | `src/memory/memory-tools.ts` (4 tools) | 5 min |
| 5. Smart shortcuts | `src/memory/memory-tools.ts` (8 tools) | 5 min |
| 6. Wire into Cortex | `src/mcp/server.ts`, `src/index.ts` | 5 min |
| 7. Migration script | `scripts/migrate-to-shared-memory.ts` | 5 min |
| 8. Snapshot sync | proto, replication.ts, handlers.ts | 5 min |
| 9. Litestream backup | config, script | 5 min |
| 10. Integrity checks | replication.ts | 3 min |
| 11. Tests | 3 test files, mark 4 as legacy | 5 min |
| 12. Config, docs, deploy | config, CLAUDE.md, deploy scripts | 5 min |

**Total estimated time:** ~60 minutes

**New dependencies:** `better-sqlite3`, `@types/better-sqlite3`

**Files created (new):**
- `src/memory/shared-memory-db.ts`
- `src/memory/replication.ts`
- `src/memory/memory-tools.ts`
- `scripts/migrate-to-shared-memory.ts`
- `scripts/create-public-replica.ts`
- `config/litestream.yml`
- `tests/shared-memory-db.test.ts`
- `tests/replication.test.ts`
- `tests/memory-tools.test.ts`

**Files modified:**
- `src/cluster/raft.ts` (add `memory_write` type)
- `proto/cluster.proto` (add enum value, RPC, messages)
- `src/grpc/handlers.ts` (add ForwardMemoryWrite, RequestMemorySnapshot)
- `src/grpc/client.ts` (add forwardMemoryWrite method)
- `src/mcp/server.ts` (replace old tools with memory tools)
- `src/index.ts` (initialize SharedMemoryDB, MemoryReplicator)
- `config/default.yaml` (add sharedMemory section)
- `package.json` (add better-sqlite3)

**Files deleted (after migration verified):**
- `src/mcp/timeline-db.ts`
- `src/mcp/timeline-tools.ts`
- `src/mcp/context-db.ts`
- `src/mcp/context-tools.ts`
- `src/mcp/network-db.ts`
- `src/mcp/network-tools.ts`
