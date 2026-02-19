// src/memory/memory-tools.ts
import { Logger } from 'winston';
import type { ToolHandler } from '../plugins/types.js';
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
  // GENERIC BASE (4 tools)
  // ================================================================

  // memory_query — Read-only SQL query against local SQLite
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

      const normalized = sql.trim().toUpperCase();
      if (!normalized.startsWith('SELECT') && !normalized.startsWith('PRAGMA') && !normalized.startsWith('WITH')) {
        throw new Error('memory_query only accepts SELECT, PRAGMA, or WITH (CTE) queries. Use memory_write for mutations.');
      }

      let finalSql = sql;
      if (!normalized.includes('LIMIT')) {
        finalSql = `${sql} LIMIT ${limit}`;
      }

      const rows = config.replicator.read(finalSql, params);
      return { rows, count: rows.length };
    },
  });

  // memory_write — Write SQL routed through Raft leader
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

      const normalized = sql.trim().toUpperCase();
      if (normalized.startsWith('SELECT')) {
        throw new Error('memory_write does not accept SELECT queries. Use memory_query instead.');
      }

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

  // memory_schema — List tables or describe columns
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

  // memory_stats — Replication status, DB size, row counts
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

  // ================================================================
  // SMART SHORTCUTS (8 tools)
  // ================================================================

  // memory_log_thought — Log a thought to a thread
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
        `SELECT current_thought_id AS id FROM timeline_thread_position WHERE thread_id = ?`,
        [threadId]
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

  // memory_whereami — Session start: active threads + pinned context
  tools.set('memory_whereami', {
    description: 'Show where you left off. Returns all active threads with their latest thought, pinned context entries, and recent context. Use this at the start of every session.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const threads = config.replicator.read(`
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

  // memory_handoff — End-of-session structured summary
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

  // memory_set_context — Upsert context entry by key
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

  // memory_get_context — Get context entries
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

  // memory_search — Full-text search across thought content
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

  // memory_network_lookup — Search devices by hostname/IP/MAC
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

  // memory_list_threads — List threads with position and count
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

  return tools;
}
