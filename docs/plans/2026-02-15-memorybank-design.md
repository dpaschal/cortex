# Memorybank MCP Server Design

**Date:** 2026-02-15
**Status:** Approved
**Goal:** Replace SSH+psql timeline access with native MCP tools for typed, structured, fast timeline operations

---

## Problem Statement

**Current State:** Timeline database access requires SSH to anvil + raw SQL queries for every operation. Used by:
- `/whereami` and `/wherewasi` skills
- CLAUDE.md session bootstrap
- Manual timeline updates via `ssh paschal@192.168.1.138 "psql -U cerebrus -d cerebrus"`

**Problems:**
- Slow (SSH + psql overhead on every query)
- Untyped (raw SQL strings, no validation)
- Error-prone (manual SQL construction)
- Not reusable (each skill duplicates SSH+psql logic)
- Limited to single machine (can't share across Claude instances easily)

**Need:** Native MCP server that wraps the timeline schema, providing typed tools for all timeline operations.

---

## Architecture Overview

**Deployment:** Standalone MCP server running on anvil (Ubuntu Server LTS) as systemd service

**Technology Stack:**
- TypeScript with `@modelcontextprotocol/sdk` v1.26.0
- PostgreSQL client via `pg` library
- Network transport with mTLS (client certificates required)
- Winston logging (debug mode initially)

**Security:**
- Server binds localhost only (forces SSH tunnel)
- mTLS with client certificate validation
- CA-signed certificates (server + per-client certs)

**Project Structure:** Monorepo with shared utilities
```
claudecluster/
├── packages/
│   ├── cluster/       # Existing claudecluster (distributed compute)
│   ├── memorybank/    # NEW - Timeline MCP server
│   └── shared/        # NEW - Shared DB client, mTLS, logging
└── package.json       # Workspace config
```

---

## Monorepo Structure

### Directory Layout

```
claudecluster/
├── packages/
│   ├── cluster/              # Existing claudecluster code (moved)
│   │   ├── src/
│   │   │   ├── agent/
│   │   │   ├── cluster/
│   │   │   ├── grpc/
│   │   │   ├── mcp/          # Keep cluster-specific MCP tools
│   │   │   └── index.ts
│   │   ├── package.json      # "@claudecluster/cluster"
│   │   └── tsconfig.json
│   │
│   ├── memorybank/           # NEW - Timeline MCP server
│   │   ├── src/
│   │   │   ├── server.ts     # MCP server entry point
│   │   │   ├── repositories/ # Database access layer
│   │   │   │   ├── ThreadRepository.ts
│   │   │   │   ├── ThoughtRepository.ts
│   │   │   │   ├── ContextRepository.ts
│   │   │   │   └── ProjectRepository.ts
│   │   │   ├── tools/        # MCP tool implementations
│   │   │   │   ├── threads.ts
│   │   │   │   ├── thoughts.ts
│   │   │   │   ├── context.ts
│   │   │   │   └── projects.ts
│   │   │   └── types.ts      # Timeline TypeScript types
│   │   ├── __tests__/        # Unit + integration tests
│   │   ├── package.json      # "@claudecluster/memorybank"
│   │   └── tsconfig.json
│   │
│   └── shared/               # NEW - Shared utilities
│       ├── src/
│       │   ├── db/
│       │   │   ├── client.ts     # PostgreSQL connection pool
│       │   │   └── types.ts      # Common DB types
│       │   ├── mcp/
│       │   │   ├── transport.ts  # mTLS socket setup
│       │   │   └── logger.ts     # MCP-aware logger
│       │   └── security/
│       │       ├── certs.ts      # mTLS certificate management
│       │       └── validation.ts # Input validation helpers
│       ├── package.json      # "@claudecluster/shared"
│       └── tsconfig.json
│
├── package.json              # Root workspace config
├── tsconfig.json             # Base TypeScript config
└── README.md                 # Updated with monorepo docs
```

### Package Dependencies

- `@claudecluster/shared` → no internal deps (base package)
- `@claudecluster/memorybank` → depends on `@claudecluster/shared`
- `@claudecluster/cluster` → depends on `@claudecluster/shared` (optional refactor)

### Workspace Configuration

**Root package.json:**
```json
{
  "name": "claudecluster-workspace",
  "private": true,
  "workspaces": [
    "packages/*"
  ]
}
```

**Benefits:**
- Clear separation: cluster (distributed compute) vs memorybank (timeline access)
- Shared code in one place (DRY principle)
- Independent versioning per package
- npm workspaces handles cross-package dependencies

---

## Shared Packages Architecture

### Database Client (`packages/shared/src/db/`)

**PostgreSQL Connection Pool:**

```typescript
// packages/shared/src/db/client.ts
import { Pool, PoolConfig } from 'pg';
import { Logger } from 'winston';

export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl?: boolean;
  maxConnections?: number;
}

export class DatabaseClient {
  private pool: Pool;
  private logger: Logger;

  constructor(config: DatabaseConfig, logger: Logger) {
    this.logger = logger;
    this.pool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
      max: config.maxConnections || 10,
    });

    this.pool.on('error', (err) => {
      this.logger.error('Unexpected database error', { error: err });
    });
  }

  // Generic query method
  async query<T = any>(sql: string, params?: any[]): Promise<T[]> {
    const start = Date.now();
    try {
      const result = await this.pool.query(sql, params);
      const duration = Date.now() - start;
      this.logger.debug('Query executed', { sql, params, duration, rows: result.rowCount });
      return result.rows;
    } catch (error) {
      this.logger.error('Query failed', { sql, params, error });
      throw error;
    }
  }

  // Transaction support
  async transaction<T>(callback: (client: any) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
```

**Key Features:**
- Connection pooling (max 10 connections by default)
- Query logging with duration tracking (debug mode)
- Transaction support (atomic multi-step operations)
- Error handling with automatic rollback

---

### mTLS Transport (`packages/shared/src/mcp/transport.ts`)

**Network Socket with mTLS:**

```typescript
import { Server as MCPServer } from '@modelcontextprotocol/sdk/server/index.js';
import { createServer, Server as TLSServer } from 'tls';
import { readFileSync } from 'fs';
import { Logger } from 'winston';

export interface TLSConfig {
  certPath: string;      // Server certificate
  keyPath: string;       // Server private key
  caPath: string;        // CA certificate (for client validation)
  host: string;          // Bind address (localhost for SSH tunnel)
  port: number;          // Port to listen on
}

export class MCPTransport {
  private server: TLSServer;
  private logger: Logger;

  constructor(config: TLSConfig, mcpServer: MCPServer, logger: Logger) {
    this.logger = logger;

    // Create TLS server
    this.server = createServer({
      cert: readFileSync(config.certPath),
      key: readFileSync(config.keyPath),
      ca: readFileSync(config.caPath),
      requestCert: true,        // Require client certificate
      rejectUnauthorized: true, // Reject invalid certs
    }, (socket) => {
      this.logger.info('Client connected', {
        remoteAddress: socket.remoteAddress,
        authorized: socket.authorized,
      });

      // Connect MCP server to socket
      mcpServer.connect({
        input: socket,
        output: socket,
      });

      socket.on('error', (err) => {
        this.logger.error('Socket error', { error: err });
      });

      socket.on('close', () => {
        this.logger.info('Client disconnected');
      });
    });

    this.server.listen(config.port, config.host, () => {
      this.logger.info('MCP server listening', {
        host: config.host,
        port: config.port,
        transport: 'mTLS',
      });
    });
  }

  close(): void {
    this.server.close();
  }
}
```

**Security Properties:**
- Client certificate required (no anonymous connections)
- CA validation (both server and client verify certificates)
- Localhost binding (network access requires SSH tunnel)
- TLS 1.3 with strong cipher suites

---

## MCP Tool Schemas

### Thread Management Tools (5 tools)

#### `list_threads` - Query threads with filters

```typescript
{
  description: 'List threads with optional filters',
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['active', 'paused', 'completed', 'archived'],
        description: 'Filter by thread status'
      },
      projectId: {
        type: 'number',
        description: 'Filter by project ID'
      },
      limit: { type: 'number', default: 20 }
    }
  }
}
```

**Returns:** Array of threads with current thought, thought count, tangent count

---

#### `get_thread` - Get full thread details

```typescript
{
  description: 'Get thread with thoughts, position, and context',
  inputSchema: {
    type: 'object',
    properties: {
      threadId: { type: 'number', required: true },
      includeThoughts: { type: 'boolean', default: true },
      includeContext: { type: 'boolean', default: true }
    },
    required: ['threadId']
  }
}
```

**Returns:** Thread with full thought history, current position, linked context entries

---

#### `create_thread` - Start new thread

```typescript
{
  description: 'Create a new thread',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', required: true },
      description: { type: 'string' },
      projectId: { type: 'number' },
      parentThoughtId: { type: 'number' }, // For tangent threads
      initialThought: { type: 'string' }   // Optional first thought
    },
    required: ['name']
  }
}
```

**Returns:** Created thread with ID, position initialized

---

#### `update_thread` - Modify thread metadata

```typescript
{
  description: 'Update thread status, name, or description',
  inputSchema: {
    type: 'object',
    properties: {
      threadId: { type: 'number', required: true },
      status: { type: 'string', enum: ['active', 'paused', 'completed', 'archived'] },
      name: { type: 'string' },
      description: { type: 'string' }
    },
    required: ['threadId']
  }
}
```

**Returns:** Updated thread object

---

#### `delete_thread` - Remove thread (with safety check)

```typescript
{
  description: 'Delete a thread and all its thoughts (WARNING: irreversible)',
  inputSchema: {
    type: 'object',
    properties: {
      threadId: { type: 'number', required: true },
      confirm: { type: 'boolean', required: true } // Must be true
    },
    required: ['threadId', 'confirm']
  }
}
```

**Behavior:** Deletes thread, thoughts, position, and linked context in transaction

---

### Thought Management Tools (3 tools)

#### `log_thought` - Add thought to thread

```typescript
{
  description: 'Add a thought to a thread and update position',
  inputSchema: {
    type: 'object',
    properties: {
      threadId: { type: 'number', required: true },
      content: { type: 'string', required: true },
      thoughtType: {
        type: 'string',
        enum: ['progress', 'decision', 'blocker', 'discovery', 'question'],
        default: 'progress'
      },
      updatePosition: { type: 'boolean', default: true }
    },
    required: ['threadId', 'content']
  }
}
```

**Returns:** Created thought with ID, thread position updated if requested

---

#### `get_thoughts` - Query thoughts for a thread

```typescript
{
  description: 'Get thoughts for a thread with optional filters',
  inputSchema: {
    type: 'object',
    properties: {
      threadId: { type: 'number', required: true },
      thoughtType: { type: 'string' },
      limit: { type: 'number', default: 50 },
      offset: { type: 'number', default: 0 }
    },
    required: ['threadId']
  }
}
```

**Returns:** Array of thoughts ordered by creation time

---

#### `delete_thought` - Remove a thought

```typescript
{
  description: 'Delete a thought (WARNING: may break thread history)',
  inputSchema: {
    type: 'object',
    properties: {
      thoughtId: { type: 'number', required: true },
      confirm: { type: 'boolean', required: true }
    },
    required: ['thoughtId', 'confirm']
  }
}
```

**Warning:** Deleting thoughts can break parent-child relationships and thread continuity

---

### Context Management Tools (3 tools)

#### `get_context` - Query context entries

```typescript
{
  description: 'Get context entries with filters',
  inputSchema: {
    type: 'object',
    properties: {
      threadId: { type: 'number' },
      category: {
        type: 'string',
        enum: ['project', 'pr', 'machine', 'waiting', 'fact', 'reminder']
      },
      pinned: { type: 'boolean' },
      key: { type: 'string' }
    }
  }
}
```

**Returns:** Array of context entries matching filters

---

#### `set_context` - Add/update context entry

```typescript
{
  description: 'Set a context entry (upsert by key)',
  inputSchema: {
    type: 'object',
    properties: {
      key: { type: 'string', required: true },
      value: { type: 'object', required: true }, // JSON value
      threadId: { type: 'number' },
      category: { type: 'string', required: true },
      label: { type: 'string' },
      pinned: { type: 'boolean', default: false }
    },
    required: ['key', 'value', 'category']
  }
}
```

**Behavior:** Upserts by key (updates if exists, inserts if not)

---

#### `delete_context` - Remove context entry

```typescript
{
  description: 'Delete a context entry by key',
  inputSchema: {
    type: 'object',
    properties: {
      key: { type: 'string', required: true }
    },
    required: ['key']
  }
}
```

---

### Project Management Tools (2 tools)

#### `list_projects` - Get all projects

```typescript
{
  description: 'List all projects with optional status filter',
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string' }
    }
  }
}
```

---

#### `create_project` - Add new project

```typescript
{
  description: 'Create a new project',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', required: true },
      description: { type: 'string' },
      employer: { type: 'string' },
      language: { type: 'string' },
      location: { type: 'string' },
      repoUrl: { type: 'string' }
    },
    required: ['name']
  }
}
```

---

**Total: 14 MCP tools** covering full CRUD operations on timeline schema

---

## Database Access Layer

### Repository Pattern

Each entity gets a repository class that encapsulates all database operations:

```
packages/memorybank/src/
├── repositories/
│   ├── ThreadRepository.ts    # Thread CRUD operations
│   ├── ThoughtRepository.ts   # Thought CRUD operations
│   ├── ContextRepository.ts   # Context CRUD operations
│   └── ProjectRepository.ts   # Project CRUD operations
└── tools/
    ├── threads.ts   (uses ThreadRepository)
    ├── thoughts.ts  (uses ThoughtRepository)
    ├── context.ts   (uses ContextRepository)
    └── projects.ts  (uses ProjectRepository)
```

### Example: ThreadRepository

```typescript
// packages/memorybank/src/repositories/ThreadRepository.ts
import { DatabaseClient } from '@claudecluster/shared/db';

export interface Thread {
  id: number;
  name: string;
  description?: string;
  parentThoughtId?: number;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  projectId?: number;
}

export class ThreadRepository {
  constructor(private db: DatabaseClient) {}

  async list(filters: {
    status?: string;
    projectId?: number;
    limit?: number;
  }): Promise<Thread[]> {
    let sql = `
      SELECT
        t.id, t.name, t.description, t.parent_thought_id,
        t.status, t.created_at, t.updated_at, t.project_id,
        tp.current_thought_id,
        ct.content AS current_thought,
        (SELECT COUNT(*) FROM timeline.thoughts th WHERE th.thread_id = t.id)::int AS thought_count
      FROM timeline.threads t
      LEFT JOIN timeline.thread_position tp ON tp.thread_id = t.id
      LEFT JOIN timeline.thoughts ct ON ct.id = tp.current_thought_id
      WHERE 1=1
    `;

    const params: any[] = [];
    let paramIndex = 1;

    if (filters.status) {
      sql += ` AND t.status = $${paramIndex++}`;
      params.push(filters.status);
    }

    if (filters.projectId) {
      sql += ` AND t.project_id = $${paramIndex++}`;
      params.push(filters.projectId);
    }

    sql += ` ORDER BY t.updated_at DESC`;

    if (filters.limit) {
      sql += ` LIMIT $${paramIndex++}`;
      params.push(filters.limit);
    }

    return this.db.query(sql, params);
  }

  async create(data: {
    name: string;
    description?: string;
    projectId?: number;
    parentThoughtId?: number;
  }): Promise<Thread> {
    return this.db.transaction(async (client) => {
      // Insert thread
      const [thread] = await client.query(
        `INSERT INTO timeline.threads (name, description, project_id, parent_thought_id, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'active', NOW(), NOW())
         RETURNING *`,
        [data.name, data.description, data.projectId, data.parentThoughtId]
      );

      // Initialize thread position
      await client.query(
        `INSERT INTO timeline.thread_position (thread_id, current_thought_id, updated_at)
         VALUES ($1, NULL, NOW())`,
        [thread.id]
      );

      return thread;
    });
  }

  async delete(threadId: number): Promise<void> {
    return this.db.transaction(async (client) => {
      // Delete context entries
      await client.query('DELETE FROM timeline.context WHERE thread_id = $1', [threadId]);

      // Delete thread position
      await client.query('DELETE FROM timeline.thread_position WHERE thread_id = $1', [threadId]);

      // Delete thoughts
      await client.query('DELETE FROM timeline.thoughts WHERE thread_id = $1', [threadId]);

      // Delete thread
      await client.query('DELETE FROM timeline.threads WHERE id = $1', [threadId]);
    });
  }
}
```

### Key Patterns

- **Parameterized queries**: SQL injection prevention
- **Transactions**: Multi-step operations are atomic (create thread + initialize position)
- **Type safety**: TypeScript interfaces match database schema
- **Error handling**: Repository throws, tools catch and return MCP errors
- **Logging**: All queries logged with duration (debug mode)

---

## mTLS Security Setup

### Certificate Structure

```
~/.claudecluster/certs/
├── ca/
│   ├── ca.key           # CA private key (keep secure!)
│   └── ca.crt           # CA certificate
├── server/
│   ├── memorybank.key   # Server private key
│   └── memorybank.crt   # Server certificate (signed by CA)
└── clients/
    ├── terminus.key     # Client private key (terminus)
    ├── terminus.crt     # Client certificate
    ├── rog2.key         # Client private key (rog2)
    └── rog2.crt         # Client certificate
```

### Certificate Generation

**Script: `scripts/generate-certs.sh`**

```bash
#!/bin/bash
# Generate CA, server cert, and client certs for memorybank mTLS

CERT_DIR="$HOME/.claudecluster/certs"
mkdir -p "$CERT_DIR"/{ca,server,clients}

# 1. Generate CA (Certificate Authority)
openssl genrsa -out "$CERT_DIR/ca/ca.key" 4096
openssl req -new -x509 -days 3650 -key "$CERT_DIR/ca/ca.key" \
  -out "$CERT_DIR/ca/ca.crt" \
  -subj "/C=US/ST=State/L=City/O=Claudecluster/CN=Claudecluster CA"

# 2. Generate Server Certificate (memorybank on anvil)
openssl genrsa -out "$CERT_DIR/server/memorybank.key" 2048
openssl req -new -key "$CERT_DIR/server/memorybank.key" \
  -out "$CERT_DIR/server/memorybank.csr" \
  -subj "/C=US/ST=State/L=City/O=Claudecluster/CN=anvil"

# Sign server cert with CA
openssl x509 -req -in "$CERT_DIR/server/memorybank.csr" \
  -CA "$CERT_DIR/ca/ca.crt" -CAkey "$CERT_DIR/ca/ca.key" \
  -CAcreateserial -out "$CERT_DIR/server/memorybank.crt" \
  -days 365 -sha256

# 3. Generate Client Certificates (one per machine)
for client in terminus rog2; do
  openssl genrsa -out "$CERT_DIR/clients/$client.key" 2048
  openssl req -new -key "$CERT_DIR/clients/$client.key" \
    -out "$CERT_DIR/clients/$client.csr" \
    -subj "/C=US/ST=State/L=City/O=Claudecluster/CN=$client"

  openssl x509 -req -in "$CERT_DIR/clients/$client.csr" \
    -CA "$CERT_DIR/ca/ca.crt" -CAkey "$CERT_DIR/ca/ca.key" \
    -CAcreateserial -out "$CERT_DIR/clients/$client.crt" \
    -days 365 -sha256
done

# Cleanup CSRs
rm "$CERT_DIR"/**/*.csr

echo "Certificates generated in $CERT_DIR"
echo ""
echo "Next steps:"
echo "1. Copy server certs to anvil:"
echo "   scp -r $CERT_DIR/server $CERT_DIR/ca anvil:~/.claudecluster/certs/"
echo "2. Client certs are in $CERT_DIR/clients/"
```

### Server Configuration

**File: `~/.claudecluster/memorybank.yaml` (on anvil)**

```yaml
server:
  host: localhost        # Only accessible via SSH tunnel
  port: 5555
  tls:
    enabled: true
    certPath: ~/.claudecluster/certs/server/memorybank.crt
    keyPath: ~/.claudecluster/certs/server/memorybank.key
    caPath: ~/.claudecluster/certs/ca/ca.crt

database:
  host: localhost
  port: 5432
  database: cerebrus
  user: cerebrus
  password: cerebrus2025
  maxConnections: 10

logging:
  level: debug           # debug/info/warn/error
  file: ~/.claudecluster/memorybank.log
```

### Client Configuration

**File: `~/.claude/settings.json` (on terminus)**

```json
{
  "mcpServers": {
    "memorybank": {
      "command": "ssh",
      "args": [
        "-L", "5555:localhost:5555",
        "paschal@192.168.1.138",
        "-N", "-f"
      ],
      "client": {
        "url": "tls://localhost:5555",
        "tls": {
          "cert": "~/.claudecluster/certs/clients/terminus.crt",
          "key": "~/.claudecluster/certs/clients/terminus.key",
          "ca": "~/.claudecluster/certs/ca/ca.crt"
        }
      }
    }
  }
}
```

### Security Properties

- **SSH tunnel required**: Server binds localhost only (not accessible from network)
- **Client certificate required**: No anonymous connections allowed
- **CA validation**: Both server and client validate certificates against CA
- **Automatic expiration**: Certificates expire after 1 year, forcing renewal
- **TLS 1.3**: Modern encryption with strong cipher suites

---

## Deployment Configuration

### Systemd Service

**File: `/etc/systemd/system/memorybank.service` (on anvil)**

```ini
[Unit]
Description=Memorybank MCP Server - Timeline access for Claude Code
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=paschal
Group=paschal
WorkingDirectory=/home/paschal/cortex/packages/memorybank
ExecStart=/usr/bin/node dist/server.js --config /home/paschal/.claudecluster/memorybank.yaml
Restart=on-failure
RestartSec=5s

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=memorybank

# Security hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/paschal/.claudecluster

[Install]
WantedBy=multi-user.target
```

### Deployment Process

```bash
# On terminus (development machine)
cd ~/claudecluster
npm run build                    # Build all packages

# Deploy to anvil
rsync -av --exclude node_modules packages/ paschal@192.168.1.138:~/claudecluster/packages/
rsync -av package.json package-lock.json paschal@192.168.1.138:~/claudecluster/

# On anvil (via SSH)
ssh paschal@192.168.1.138 << 'EOF'
  cd ~/claudecluster
  npm install --production       # Install deps

  # Copy systemd service
  sudo cp ~/claudecluster/packages/memorybank/memorybank.service /etc/systemd/system/
  sudo systemctl daemon-reload
  sudo systemctl enable memorybank
  sudo systemctl restart memorybank

  # Check status
  sudo systemctl status memorybank
  journalctl -u memorybank -f    # Watch logs
EOF
```

### Health Check

The server exposes a health check endpoint on a separate port (no mTLS required):

```typescript
// packages/memorybank/src/server.ts
import { createServer } from 'http';

// Health check on separate port (no mTLS)
const healthServer = createServer((req, res) => {
  if (req.url === '/health') {
    // Check database connection
    db.query('SELECT 1').then(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'healthy', uptime: process.uptime() }));
    }).catch((err) => {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'unhealthy', error: err.message }));
    });
  } else {
    res.writeHead(404);
    res.end();
  }
});

healthServer.listen(5556, 'localhost'); // Health check on :5556
```

### Monitoring

```bash
# Check if service is running
systemctl status memorybank

# View recent logs
journalctl -u memorybank --since "1 hour ago"

# Health check
curl http://localhost:5556/health
```

---

## Testing Strategy

### Test Structure

```
packages/memorybank/
├── src/
│   ├── __tests__/
│   │   ├── repositories/
│   │   │   ├── ThreadRepository.test.ts
│   │   │   ├── ThoughtRepository.test.ts
│   │   │   └── ContextRepository.test.ts
│   │   ├── tools/
│   │   │   ├── threads.test.ts
│   │   │   └── thoughts.test.ts
│   │   └── integration/
│   │       ├── mcp-server.test.ts
│   │       └── database.test.ts
│   └── test-utils/
│       ├── mock-db.ts
│       └── test-data.ts
```

### Unit Tests (Repository Layer)

**Example: ThreadRepository tests**

```typescript
// src/__tests__/repositories/ThreadRepository.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { ThreadRepository } from '../../repositories/ThreadRepository';
import { createMockDatabase } from '../../test-utils/mock-db';

describe('ThreadRepository', () => {
  let repo: ThreadRepository;
  let mockDb: any;

  beforeEach(() => {
    mockDb = createMockDatabase();
    repo = new ThreadRepository(mockDb);
  });

  it('should list threads with status filter', async () => {
    mockDb.query.mockResolvedValue([
      { id: 1, name: 'test-thread', status: 'active' }
    ]);

    const threads = await repo.list({ status: 'active' });

    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE 1=1 AND t.status = $1'),
      ['active']
    );
    expect(threads).toHaveLength(1);
    expect(threads[0].name).toBe('test-thread');
  });

  it('should create thread with transaction', async () => {
    mockDb.transaction.mockImplementation(async (callback) => {
      const client = { query: vi.fn() };
      client.query
        .mockResolvedValueOnce([{ id: 1, name: 'new-thread' }])  // INSERT thread
        .mockResolvedValueOnce(undefined);                       // INSERT position
      return callback(client);
    });

    const thread = await repo.create({ name: 'new-thread' });

    expect(thread.id).toBe(1);
    expect(mockDb.transaction).toHaveBeenCalled();
  });
});
```

### Integration Tests (MCP Server)

**Example: End-to-end MCP tool tests**

```typescript
// src/__tests__/integration/mcp-server.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MCPClient } from '@modelcontextprotocol/sdk/client/index.js';
import { startTestServer, stopTestServer } from '../../test-utils/test-server';

describe('MCP Server Integration', () => {
  let client: MCPClient;

  beforeAll(async () => {
    await startTestServer(); // Start server on test port
    client = new MCPClient({
      url: 'tls://localhost:5557',
      tls: {
        cert: './test-certs/client.crt',
        key: './test-certs/client.key',
        ca: './test-certs/ca.crt'
      }
    });
    await client.connect();
  });

  afterAll(async () => {
    await client.disconnect();
    await stopTestServer();
  });

  it('should list active threads', async () => {
    const result = await client.callTool('list_threads', {
      status: 'active'
    });

    expect(result).toBeDefined();
    expect(Array.isArray(result.threads)).toBe(true);
  });

  it('should create and retrieve thread', async () => {
    // Create thread
    const created = await client.callTool('create_thread', {
      name: 'test-integration-thread',
      description: 'Integration test thread'
    });

    expect(created.thread.id).toBeDefined();

    // Retrieve thread
    const retrieved = await client.callTool('get_thread', {
      threadId: created.thread.id
    });

    expect(retrieved.thread.name).toBe('test-integration-thread');
  });
});
```

### Smoke Test Script

**File: `scripts/smoke-test.ts`**

```typescript
import { MCPClient } from '@modelcontextprotocol/sdk/client/index.js';

async function smokeTest() {
  const client = new MCPClient({
    url: 'tls://localhost:5555',
    tls: {
      cert: process.env.HOME + '/.claudecluster/certs/clients/terminus.crt',
      key: process.env.HOME + '/.claudecluster/certs/clients/terminus.key',
      ca: process.env.HOME + '/.claudecluster/certs/ca/ca.crt',
    }
  });

  try {
    await client.connect();
    console.log('✓ Connected to memorybank server');

    // Test list_threads
    const threads = await client.callTool('list_threads', { status: 'active' });
    console.log(`✓ Listed ${threads.threads.length} active threads`);

    // Test create_thread
    const newThread = await client.callTool('create_thread', {
      name: 'smoke-test-' + Date.now(),
      description: 'Automated smoke test'
    });
    console.log(`✓ Created thread ${newThread.thread.id}`);

    // Test log_thought
    await client.callTool('log_thought', {
      threadId: newThread.thread.id,
      content: 'Smoke test thought',
      thoughtType: 'progress'
    });
    console.log('✓ Logged thought');

    console.log('\n✅ All smoke tests passed!');
  } catch (error) {
    console.error('❌ Smoke test failed:', error);
    process.exit(1);
  } finally {
    await client.disconnect();
  }
}

smokeTest();
```

### Manual Testing

```bash
# 1. Start server in dev mode (uses dev config, debug logging)
cd packages/memorybank
npm run dev

# 2. Test with MCP Inspector (official debugging tool)
npx @modelcontextprotocol/inspector tls://localhost:5555 \
  --cert ~/.claudecluster/certs/clients/terminus.crt \
  --key ~/.claudecluster/certs/clients/terminus.key \
  --ca ~/.claudecluster/certs/ca/ca.crt

# 3. Health check
curl http://localhost:5556/health
```

### Test Coverage Goals

- **Unit tests**: 80%+ coverage on repositories and tools
- **Integration tests**: All 14 MCP tools verified end-to-end
- **Smoke tests**: Run after every deployment to production
- **Manual testing**: MCP Inspector for interactive debugging during development

---

## Success Criteria

Before marking implementation complete, verify:

- [ ] Monorepo structure created (packages/cluster, packages/memorybank, packages/shared)
- [ ] All 14 MCP tools implemented and tested
- [ ] mTLS security working (client certs required, localhost binding)
- [ ] Systemd service running on anvil
- [ ] Health check endpoint responding
- [ ] Smoke tests passing
- [ ] `/whereami` and `/wherewasi` skills migrated to use MCP tools
- [ ] CLAUDE.md bootstrap queries migrated to MCP tools
- [ ] Performance: MCP tools faster than SSH+psql (measured)
- [ ] Documentation: README updated with monorepo structure and usage examples

---

## Migration Path

**Phase 1: Build MCP server (implementation plan)**
- Set up monorepo structure
- Implement shared packages (db client, mTLS transport)
- Implement memorybank package (repositories + tools)
- Generate certificates, deploy to anvil
- Run smoke tests

**Phase 2: Migrate existing usage (after implementation)**
- Update `/whereami` skill to use `list_threads` + `get_context` tools
- Update `/wherewasi` skill to use `list_threads` with `status=paused`
- Update CLAUDE.md bootstrap to use MCP tools
- Deprecate SSH+psql queries

**Phase 3: Future enhancements**
- Add dashboard (Task #24) using memorybank tools
- Add timeline analytics/visualization
- Consider read replicas for multi-user access

---

## Rollback Plan

If issues occur after deployment:

1. **Stop memorybank service:**
   ```bash
   sudo systemctl stop memorybank
   ```

2. **Revert to SSH+psql:**
   - Skills still have SSH+psql code (don't delete until verified)
   - CLAUDE.md can reference old queries

3. **Debug and fix:**
   - Check logs: `journalctl -u memorybank`
   - Health check: `curl http://localhost:5556/health`
   - Test database: `psql -U cerebrus -d cerebrus -h localhost -c "SELECT 1"`

4. **Redeploy after fix:**
   - Fix code, rebuild, rsync, restart service

---

## Notes for Implementation

- **TDD Discipline**: Write tests first, watch them fail, then implement
- **Commit frequently**: Each repository class, each tool, each test suite
- **Type safety**: Use TypeScript interfaces for all DB queries and MCP schemas
- **Error handling**: All repositories throw typed errors, tools catch and return MCP error responses
- **Logging**: Debug mode logs everything (queries, connections, tool calls) for initial deployment
- **Security**: Validate all inputs, use parameterized queries, require client certs

---

**Next Step:** Invoke `writing-plans` skill to create detailed implementation plan
