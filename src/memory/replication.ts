// src/memory/replication.ts
import * as crypto from 'crypto';
import { Logger } from 'winston';
import { RaftNode, LogEntry } from '../cluster/raft.js';
import { MembershipManager } from '../cluster/membership.js';
import { ClusterClient, GrpcClientPool } from '../grpc/client.js';
import { SharedMemoryDB, Classification } from './shared-memory-db.js';

export interface MemoryReplicatorConfig {
  db: SharedMemoryDB;
  raft: RaftNode;
  membership: MembershipManager;
  clientPool: GrpcClientPool;
  logger: Logger;
}

export interface WriteOptions {
  classification?: Classification;
  table?: string;
}

export interface WriteResult {
  success: boolean;
  error?: string;
  changes?: number;
}

/**
 * Bridges SharedMemoryDB writes through Raft consensus.
 *
 * Write path:
 * 1. Caller invokes write(sql, params)
 * 2. If leader: create Raft log entry with SHA-256 checksum, append to log
 * 3. If follower: forward to leader via ForwardMemoryWrite gRPC
 * 4. On commit (majority ack): apply SQL to local SQLite on every node
 *
 * Read path:
 * - Reads go directly to local SQLite via read()/readOne() — no network hop
 */
export class MemoryReplicator {
  private db: SharedMemoryDB;
  private raft: RaftNode;
  private membership: MembershipManager;
  private clientPool: GrpcClientPool;
  private logger: Logger;
  private entryHandler: (entry: LogEntry) => void;
  private integrityInterval: NodeJS.Timeout | null = null;

  constructor(config: MemoryReplicatorConfig) {
    this.db = config.db;
    this.raft = config.raft;
    this.membership = config.membership;
    this.clientPool = config.clientPool;
    this.logger = config.logger;

    // Subscribe to committed entries
    this.entryHandler = (entry: LogEntry) => this.handleCommittedEntry(entry);
    this.raft.on('entryCommitted', this.entryHandler);

    this.logger.info('MemoryReplicator initialized');
  }

  // ================================================================
  // Read Path (local, no network)
  // ================================================================

  read<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    return this.db.query<T>(sql, params);
  }

  readOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T | undefined {
    return this.db.queryOne<T>(sql, params);
  }

  // ================================================================
  // Write Path (through Raft)
  // ================================================================

  async write(sql: string, params: unknown[] = [], options: WriteOptions = {}): Promise<WriteResult> {
    const table = options.table;
    const classification = options.classification ?? this.getClassificationForTable(table);

    // Local-only writes bypass Raft entirely
    if (classification === 'local') {
      return this.applyLocally(sql, params);
    }

    // Compute checksum
    const checksum = crypto
      .createHash('sha256')
      .update(sql + JSON.stringify(params))
      .digest('hex');

    const raftState = this.raft.getState();

    if (raftState === 'leader') {
      return this.writeAsLeader(sql, params, checksum, classification, table);
    } else {
      return this.forwardToLeader(sql, params, checksum, classification, table);
    }
  }

  private async writeAsLeader(
    sql: string,
    params: unknown[],
    checksum: string,
    classification?: Classification,
    table?: string,
  ): Promise<WriteResult> {
    const entry = { sql, params, checksum, classification, table };
    const data = Buffer.from(JSON.stringify(entry));

    try {
      const result = await this.raft.appendEntry('memory_write', data);
      if (result.success) {
        return { success: true, changes: 0 }; // Actual apply happens in handleCommittedEntry
      }
      return { success: false, error: 'Failed to append to Raft log' };
    } catch (error) {
      this.logger.error('Leader write failed', { error });
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  private async forwardToLeader(
    sql: string,
    params: unknown[],
    checksum: string,
    classification?: Classification,
    table?: string,
  ): Promise<WriteResult> {
    const leaderAddr = this.membership.getLeaderAddress();
    if (!leaderAddr) {
      return { success: false, error: 'No leader available to forward write' };
    }

    try {
      const client = new ClusterClient(this.clientPool, leaderAddr);
      const response = await client.forwardMemoryWrite({
        sql,
        params: JSON.stringify(params),
        checksum,
        classification: classification ?? '',
        table: table ?? '',
      });

      return {
        success: response.success,
        error: response.error || undefined,
      };
    } catch (error) {
      this.logger.error('Forward to leader failed', { error, leaderAddr });
      return { success: false, error: error instanceof Error ? error.message : 'Forward failed' };
    }
  }

  // ================================================================
  // Entry Application (called on every node when entry is committed)
  // ================================================================

  private handleCommittedEntry(entry: LogEntry): void {
    if (entry.type !== 'memory_write') return;

    try {
      const payload = JSON.parse(entry.data.toString());
      const { sql, params, checksum } = payload;

      // Verify checksum
      const expectedChecksum = crypto
        .createHash('sha256')
        .update(sql + JSON.stringify(params))
        .digest('hex');

      if (checksum !== expectedChecksum) {
        this.logger.error('Memory write checksum mismatch — rejecting entry', {
          index: entry.index,
          expected: expectedChecksum.substring(0, 16),
          got: checksum?.substring(0, 16),
        });
        return;
      }

      // Apply to local SQLite
      this.db.run(sql, params);
      this.logger.debug('Memory write applied', { index: entry.index, sql: sql.substring(0, 80) });
    } catch (error) {
      this.logger.error('Failed to apply memory write', { index: entry.index, error });
    }
  }

  private applyLocally(sql: string, params: unknown[]): WriteResult {
    try {
      const result = this.db.run(sql, params);
      return { success: true, changes: result.changes };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Local write failed' };
    }
  }

  // ================================================================
  // Classification
  // ================================================================

  private getClassificationForTable(table?: string): Classification {
    if (!table) return 'public';
    return this.db.getTableClassification(table) ?? 'public';
  }

  // ================================================================
  // Integrity Checks
  // ================================================================

  startIntegrityChecks(intervalMs: number = 5 * 60 * 1000): void {
    this.integrityInterval = setInterval(() => {
      this.runIntegrityCheck();
    }, intervalMs);
    this.logger.info('Integrity checks started', { intervalMs });
  }

  private runIntegrityCheck(): void {
    try {
      const localChecksum = this.db.computeChecksum();
      const raftState = this.raft.getState();

      if (raftState === 'leader') {
        this.logger.debug('Leader integrity check', { checksum: localChecksum.substring(0, 16) });
      } else {
        // Follower: log checksum. Full comparison via heartbeat metadata is a future enhancement.
        this.logger.debug('Follower integrity check', { checksum: localChecksum.substring(0, 16) });
      }
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

  // ================================================================
  // Lifecycle
  // ================================================================

  stop(): void {
    this.stopIntegrityChecks();
    this.raft.removeListener('entryCommitted', this.entryHandler);
    this.logger.info('MemoryReplicator stopped');
  }
}
