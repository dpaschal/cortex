# Memorybank MCP Server Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build standalone MCP server for typed, structured timeline database access

**Architecture:** Monorepo with shared packages (DatabaseClient, mTLS transport) and memorybank package (repositories + 14 MCP tools). Server runs on anvil with mTLS security, localhost binding requiring SSH tunnel.

**Tech Stack:** TypeScript, @modelcontextprotocol/sdk v1.26.0, pg (PostgreSQL), Winston logging, Node.js 20+, systemd deployment

---

## Task 1: Initialize Monorepo Structure

**Files:**
- Modify: `package.json` (root)
- Create: `packages/cluster/.gitkeep`
- Create: `packages/memorybank/.gitkeep`
- Create: `packages/shared/.gitkeep`
- Create: `tsconfig.json` (root)

**Step 1: Create workspace structure**

Run:
```bash
cd ~/claudecluster
mkdir -p packages/{cluster,memorybank,shared}
touch packages/cluster/.gitkeep packages/memorybank/.gitkeep packages/shared/.gitkeep
```

Expected: Directories created

**Step 2: Configure npm workspaces**

Read current package.json:
```bash
cat package.json
```

Add workspaces configuration to `package.json`:
```json
{
  "name": "claudecluster-workspace",
  "version": "1.0.0",
  "private": true,
  "workspaces": [
    "packages/*"
  ],
  "scripts": {
    "build": "npm run build --workspaces",
    "test": "npm run test --workspaces",
    "dev": "npm run dev --workspace=@claudecluster/memorybank"
  }
}
```

**Step 3: Create root TypeScript config**

Write `tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "moduleResolution": "node",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "exclude": ["node_modules", "dist", "__tests__"]
}
```

**Step 4: Verify workspace setup**

Run:
```bash
npm install
```

Expected: npm recognizes workspaces, no errors

**Step 5: Commit**

```bash
git add package.json tsconfig.json packages/
git commit -m "feat: initialize monorepo structure with npm workspaces"
```

---

## Task 2: Set Up Shared Package Foundation

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/index.ts`

**Step 1: Create shared package.json**

Write `packages/shared/package.json`:
```json
{
  "name": "@claudecluster/shared",
  "version": "1.0.0",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "test": "vitest"
  },
  "dependencies": {
    "pg": "^8.18.0",
    "winston": "^3.19.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "@types/pg": "^8.11.0",
    "typescript": "^5.3.0",
    "vitest": "^1.2.0"
  }
}
```

**Step 2: Create TypeScript config**

Write `packages/shared/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "src/__tests__"]
}
```

**Step 3: Create index barrel export**

Write `packages/shared/src/index.ts`:
```typescript
// Database
export * from './db/client';
export * from './db/types';

// MCP
export * from './mcp/transport';
export * from './mcp/logger';

// Security
export * from './security/certs';
export * from './security/validation';
```

**Step 4: Install dependencies**

Run:
```bash
npm install
```

Expected: Dependencies installed for @claudecluster/shared

**Step 5: Commit**

```bash
git add packages/shared/
git commit -m "feat(shared): initialize shared package with TypeScript config"
```

---

## Task 3: Database Client - Write Tests

**Files:**
- Create: `packages/shared/src/__tests__/db/client.test.ts`
- Create: `packages/shared/vitest.config.ts`

**Step 1: Create vitest config**

Write `packages/shared/vitest.config.ts`:
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
  },
});
```

**Step 2: Write DatabaseClient tests**

Create `packages/shared/src/__tests__/db/client.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseClient } from '../../db/client';
import { Pool } from 'pg';

vi.mock('pg', () => ({
  Pool: vi.fn(),
}));

describe('DatabaseClient', () => {
  let mockPool: any;
  let mockLogger: any;

  beforeEach(() => {
    mockPool = {
      query: vi.fn(),
      connect: vi.fn(),
      end: vi.fn(),
      on: vi.fn(),
    };
    (Pool as any).mockImplementation(() => mockPool);

    mockLogger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    };
  });

  it('should execute query with parameters', async () => {
    const db = new DatabaseClient({
      host: 'localhost',
      port: 5432,
      database: 'test',
      user: 'test',
      password: 'test',
    }, mockLogger);

    mockPool.query.mockResolvedValue({ rows: [{ id: 1 }], rowCount: 1 });

    const result = await db.query('SELECT * FROM test WHERE id = $1', [1]);

    expect(result).toEqual([{ id: 1 }]);
    expect(mockPool.query).toHaveBeenCalledWith('SELECT * FROM test WHERE id = $1', [1]);
    expect(mockLogger.debug).toHaveBeenCalled();
  });

  it('should handle query errors', async () => {
    const db = new DatabaseClient({
      host: 'localhost',
      port: 5432,
      database: 'test',
      user: 'test',
      password: 'test',
    }, mockLogger);

    const error = new Error('Query failed');
    mockPool.query.mockRejectedValue(error);

    await expect(db.query('SELECT * FROM test')).rejects.toThrow('Query failed');
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('should execute transaction with commit', async () => {
    const db = new DatabaseClient({
      host: 'localhost',
      port: 5432,
      database: 'test',
      user: 'test',
      password: 'test',
    }, mockLogger);

    const mockClient = {
      query: vi.fn(),
      release: vi.fn(),
    };
    mockPool.connect.mockResolvedValue(mockClient);
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 1 }] }) // callback query
      .mockResolvedValueOnce(undefined); // COMMIT

    const result = await db.transaction(async (client) => {
      const res = await client.query('INSERT INTO test VALUES ($1)', [1]);
      return res.rows[0];
    });

    expect(result).toEqual({ id: 1 });
    expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    expect(mockClient.release).toHaveBeenCalled();
  });

  it('should rollback transaction on error', async () => {
    const db = new DatabaseClient({
      host: 'localhost',
      port: 5432,
      database: 'test',
      user: 'test',
      password: 'test',
    }, mockLogger);

    const mockClient = {
      query: vi.fn(),
      release: vi.fn(),
    };
    mockPool.connect.mockResolvedValue(mockClient);
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockRejectedValueOnce(new Error('Insert failed')) // callback query
      .mockResolvedValueOnce(undefined); // ROLLBACK

    await expect(db.transaction(async (client) => {
      await client.query('INSERT INTO test VALUES ($1)', [1]);
    })).rejects.toThrow('Insert failed');

    expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClient.release).toHaveBeenCalled();
  });
});
```

**Step 3: Run tests to verify they fail**

Run:
```bash
cd packages/shared
npm test
```

Expected: FAIL - "Cannot find module '../../db/client'"

**Step 4: Commit failing tests**

```bash
git add packages/shared/src/__tests__/ packages/shared/vitest.config.ts
git commit -m "test(shared): add DatabaseClient tests (failing)"
```

---

## Task 4: Database Client - Implementation

**Files:**
- Create: `packages/shared/src/db/types.ts`
- Create: `packages/shared/src/db/client.ts`

**Step 1: Write database types**

Create `packages/shared/src/db/types.ts`:
```typescript
export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl?: boolean;
  maxConnections?: number;
}
```

**Step 2: Implement DatabaseClient**

Create `packages/shared/src/db/client.ts`:
```typescript
import { Pool, PoolClient, QueryResult } from 'pg';
import { Logger } from 'winston';
import { DatabaseConfig } from './types';

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

  async query<T = any>(sql: string, params?: any[]): Promise<T[]> {
    const start = Date.now();
    try {
      const result: QueryResult = await this.pool.query(sql, params);
      const duration = Date.now() - start;
      this.logger.debug('Query executed', {
        sql: sql.substring(0, 100),
        params,
        duration,
        rows: result.rowCount
      });
      return result.rows;
    } catch (error) {
      this.logger.error('Query failed', { sql, params, error });
      throw error;
    }
  }

  async transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
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

**Step 3: Run tests to verify they pass**

Run:
```bash
cd packages/shared
npm test
```

Expected: PASS - All DatabaseClient tests pass

**Step 4: Build package**

Run:
```bash
npm run build
```

Expected: TypeScript compiles successfully, `dist/` directory created

**Step 5: Commit implementation**

```bash
git add packages/shared/src/db/
git commit -m "feat(shared): implement DatabaseClient with connection pooling and transactions"
```

---

## Task 5: MCP Logger - Write Tests

**Files:**
- Create: `packages/shared/src/__tests__/mcp/logger.test.ts`

**Step 1: Write logger tests**

Create `packages/shared/src/__tests__/mcp/logger.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest';
import { createMCPLogger } from '../../mcp/logger';
import winston from 'winston';

vi.mock('winston', () => ({
  default: {
    createLogger: vi.fn(),
    format: {
      combine: vi.fn(),
      timestamp: vi.fn(),
      printf: vi.fn(),
      json: vi.fn(),
    },
    transports: {
      Console: vi.fn(),
      File: vi.fn(),
    },
  },
}));

describe('createMCPLogger', () => {
  it('should create logger with debug level', () => {
    const mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };
    (winston.createLogger as any).mockReturnValue(mockLogger);

    const logger = createMCPLogger({
      level: 'debug',
      logFile: '/tmp/test.log',
    });

    expect(winston.createLogger).toHaveBeenCalled();
    expect(logger).toBeDefined();
  });

  it('should create logger with console transport only', () => {
    const mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
    };
    (winston.createLogger as any).mockReturnValue(mockLogger);

    const logger = createMCPLogger({
      level: 'info',
    });

    expect(winston.createLogger).toHaveBeenCalled();
  });
});
```

**Step 2: Run tests to verify they fail**

Run:
```bash
cd packages/shared
npm test
```

Expected: FAIL - "Cannot find module '../../mcp/logger'"

**Step 3: Commit failing tests**

```bash
git add packages/shared/src/__tests__/mcp/
git commit -m "test(shared): add MCP logger tests (failing)"
```

---

## Task 6: MCP Logger - Implementation

**Files:**
- Create: `packages/shared/src/mcp/logger.ts`

**Step 1: Implement createMCPLogger**

Create `packages/shared/src/mcp/logger.ts`:
```typescript
import winston from 'winston';

export interface LoggerConfig {
  level: 'debug' | 'info' | 'warn' | 'error';
  logFile?: string;
}

export function createMCPLogger(config: LoggerConfig): winston.Logger {
  const transports: winston.transport[] = [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const metaStr = Object.keys(meta).length > 0 ? JSON.stringify(meta) : '';
          return `${timestamp} [${level}] ${message} ${metaStr}`;
        })
      ),
    }),
  ];

  if (config.logFile) {
    transports.push(
      new winston.transports.File({
        filename: config.logFile,
        format: winston.format.json(),
      })
    );
  }

  return winston.createLogger({
    level: config.level,
    transports,
  });
}
```

**Step 2: Run tests to verify they pass**

Run:
```bash
cd packages/shared
npm test
```

Expected: PASS - All logger tests pass

**Step 3: Build package**

Run:
```bash
npm run build
```

Expected: Builds successfully

**Step 4: Commit implementation**

```bash
git add packages/shared/src/mcp/logger.ts
git commit -m "feat(shared): implement MCP logger with console and file transports"
```

---

## Task 7: mTLS Transport - Write Tests

**Files:**
- Create: `packages/shared/src/__tests__/mcp/transport.test.ts`

**Step 1: Write transport tests**

Create `packages/shared/src/__tests__/mcp/transport.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MCPTransport } from '../../mcp/transport';
import * as tls from 'tls';
import * as fs from 'fs';

vi.mock('tls');
vi.mock('fs');

describe('MCPTransport', () => {
  let mockLogger: any;
  let mockMCPServer: any;

  beforeEach(() => {
    mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
    };

    mockMCPServer = {
      connect: vi.fn(),
    };

    (fs.readFileSync as any).mockReturnValue('mock-cert-data');
  });

  it('should create TLS server with mTLS config', () => {
    const mockServer = {
      listen: vi.fn((port, host, callback) => callback()),
      close: vi.fn(),
    };
    (tls.createServer as any).mockReturnValue(mockServer);

    const transport = new MCPTransport({
      certPath: '/path/to/cert',
      keyPath: '/path/to/key',
      caPath: '/path/to/ca',
      host: 'localhost',
      port: 5555,
    }, mockMCPServer, mockLogger);

    expect(tls.createServer).toHaveBeenCalledWith(
      expect.objectContaining({
        requestCert: true,
        rejectUnauthorized: true,
      }),
      expect.any(Function)
    );
    expect(mockServer.listen).toHaveBeenCalledWith(5555, 'localhost', expect.any(Function));
    expect(mockLogger.info).toHaveBeenCalledWith('MCP server listening', expect.any(Object));
  });

  it('should connect MCP server to socket on client connection', () => {
    const mockSocket = {
      remoteAddress: '127.0.0.1',
      authorized: true,
      on: vi.fn(),
    };

    const mockServer = {
      listen: vi.fn((port, host, callback) => callback()),
      close: vi.fn(),
    };

    let connectionHandler: any;
    (tls.createServer as any).mockImplementation((options, handler) => {
      connectionHandler = handler;
      return mockServer;
    });

    const transport = new MCPTransport({
      certPath: '/path/to/cert',
      keyPath: '/path/to/key',
      caPath: '/path/to/ca',
      host: 'localhost',
      port: 5555,
    }, mockMCPServer, mockLogger);

    // Simulate client connection
    connectionHandler(mockSocket);

    expect(mockMCPServer.connect).toHaveBeenCalledWith({
      input: mockSocket,
      output: mockSocket,
    });
    expect(mockLogger.info).toHaveBeenCalledWith('Client connected', expect.any(Object));
  });
});
```

**Step 2: Run tests to verify they fail**

Run:
```bash
cd packages/shared
npm test
```

Expected: FAIL - "Cannot find module '../../mcp/transport'"

**Step 3: Commit failing tests**

```bash
git add packages/shared/src/__tests__/mcp/transport.test.ts
git commit -m "test(shared): add mTLS transport tests (failing)"
```

---

## Task 8: mTLS Transport - Implementation

**Files:**
- Create: `packages/shared/src/mcp/transport.ts`

**Step 1: Add @modelcontextprotocol/sdk dependency**

Modify `packages/shared/package.json`, add to dependencies:
```json
"@modelcontextprotocol/sdk": "^1.26.0"
```

Run:
```bash
cd packages/shared
npm install
```

**Step 2: Implement MCPTransport**

Create `packages/shared/src/mcp/transport.ts`:
```typescript
import { Server as MCPServer } from '@modelcontextprotocol/sdk/server/index.js';
import { createServer, Server as TLSServer, TlsOptions } from 'tls';
import { readFileSync } from 'fs';
import { Logger } from 'winston';

export interface TLSConfig {
  certPath: string;
  keyPath: string;
  caPath: string;
  host: string;
  port: number;
}

export class MCPTransport {
  private server: TLSServer;
  private logger: Logger;

  constructor(config: TLSConfig, mcpServer: MCPServer, logger: Logger) {
    this.logger = logger;

    const tlsOptions: TlsOptions = {
      cert: readFileSync(config.certPath),
      key: readFileSync(config.keyPath),
      ca: readFileSync(config.caPath),
      requestCert: true,
      rejectUnauthorized: true,
    };

    this.server = createServer(tlsOptions, (socket) => {
      this.logger.info('Client connected', {
        remoteAddress: socket.remoteAddress,
        authorized: socket.authorized,
      });

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

**Step 3: Run tests to verify they pass**

Run:
```bash
cd packages/shared
npm test
```

Expected: PASS - All transport tests pass

**Step 4: Build package**

Run:
```bash
npm run build
```

Expected: Builds successfully

**Step 5: Commit implementation**

```bash
git add packages/shared/
git commit -m "feat(shared): implement mTLS transport for MCP server"
```

---

## Task 9: Security Utilities - Implementation

**Files:**
- Create: `packages/shared/src/security/validation.ts`
- Create: `packages/shared/src/security/certs.ts`

**Step 1: Implement input validation helpers**

Create `packages/shared/src/security/validation.ts`:
```typescript
export function validateThreadStatus(status: string): boolean {
  return ['active', 'paused', 'completed', 'archived'].includes(status);
}

export function validateThoughtType(type: string): boolean {
  return ['progress', 'decision', 'blocker', 'discovery', 'question'].includes(type);
}

export function validateContextCategory(category: string): boolean {
  return ['project', 'pr', 'machine', 'waiting', 'fact', 'reminder'].includes(category);
}

export function sanitizeInput(input: string): string {
  return input.trim().substring(0, 10000);
}
```

**Step 2: Implement certificate helpers**

Create `packages/shared/src/security/certs.ts`:
```typescript
import { readFileSync, existsSync } from 'fs';

export interface CertificatePaths {
  cert: string;
  key: string;
  ca: string;
}

export function loadCertificates(paths: CertificatePaths): {
  cert: Buffer;
  key: Buffer;
  ca: Buffer;
} {
  if (!existsSync(paths.cert)) {
    throw new Error(`Certificate file not found: ${paths.cert}`);
  }
  if (!existsSync(paths.key)) {
    throw new Error(`Key file not found: ${paths.key}`);
  }
  if (!existsSync(paths.ca)) {
    throw new Error(`CA file not found: ${paths.ca}`);
  }

  return {
    cert: readFileSync(paths.cert),
    key: readFileSync(paths.key),
    ca: readFileSync(paths.ca),
  };
}
```

**Step 3: Build shared package**

Run:
```bash
cd packages/shared
npm run build
```

Expected: Builds successfully

**Step 4: Commit security utilities**

```bash
git add packages/shared/src/security/
git commit -m "feat(shared): add input validation and certificate loading utilities"
```

---

## Task 10: Initialize Memorybank Package

**Files:**
- Create: `packages/memorybank/package.json`
- Create: `packages/memorybank/tsconfig.json`
- Create: `packages/memorybank/vitest.config.ts`

**Step 1: Create memorybank package.json**

Write `packages/memorybank/package.json`:
```json
{
  "name": "@claudecluster/memorybank",
  "version": "1.0.0",
  "main": "dist/server.js",
  "types": "dist/server.d.ts",
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "start": "node dist/server.js",
    "test": "vitest"
  },
  "dependencies": {
    "@claudecluster/shared": "^1.0.0",
    "@modelcontextprotocol/sdk": "^1.26.0",
    "pg": "^8.18.0",
    "winston": "^3.19.0",
    "yaml": "^2.3.4"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "@types/pg": "^8.11.0",
    "typescript": "^5.3.0",
    "vitest": "^1.2.0"
  }
}
```

**Step 2: Create TypeScript config**

Write `packages/memorybank/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "src/__tests__"],
  "references": [
    { "path": "../shared" }
  ]
}
```

**Step 3: Create vitest config**

Write `packages/memorybank/vitest.config.ts`:
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
  },
});
```

**Step 4: Install dependencies**

Run:
```bash
npm install
```

Expected: Dependencies installed, links @claudecluster/shared

**Step 5: Commit**

```bash
git add packages/memorybank/
git commit -m "feat(memorybank): initialize package with dependencies"
```

---

## Task 11: Timeline TypeScript Types

**Files:**
- Create: `packages/memorybank/src/types.ts`

**Step 1: Define timeline entity types**

Create `packages/memorybank/src/types.ts`:
```typescript
export interface Thread {
  id: number;
  name: string;
  description?: string;
  parentThoughtId?: number;
  status: 'active' | 'paused' | 'completed' | 'archived';
  createdAt: Date;
  updatedAt: Date;
  projectId?: number;
}

export interface ThreadWithPosition extends Thread {
  currentThoughtId?: number;
  currentThought?: string;
  thoughtCount: number;
  openTangents?: number;
}

export interface Thought {
  id: number;
  threadId: number;
  content: string;
  thoughtType: 'progress' | 'decision' | 'blocker' | 'discovery' | 'question';
  createdAt: Date;
}

export interface ThreadPosition {
  id: number;
  threadId: number;
  currentThoughtId?: number;
  updatedAt: Date;
}

export interface Context {
  id: number;
  key: string;
  value: any;
  threadId?: number;
  category: 'project' | 'pr' | 'machine' | 'waiting' | 'fact' | 'reminder';
  label?: string;
  pinned: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface Project {
  id: number;
  name: string;
  description?: string;
  employer?: string;
  language?: string;
  location?: string;
  repoUrl?: string;
  status?: string;
  createdAt: Date;
  updatedAt: Date;
}
```

**Step 2: Build to verify types**

Run:
```bash
cd packages/memorybank
npm run build
```

Expected: TypeScript compiles successfully

**Step 3: Commit types**

```bash
git add packages/memorybank/src/types.ts
git commit -m "feat(memorybank): define timeline entity TypeScript types"
```

---

## Task 12: ThreadRepository - Write Tests

**Files:**
- Create: `packages/memorybank/src/__tests__/repositories/ThreadRepository.test.ts`
- Create: `packages/memorybank/src/__tests__/test-utils.ts`

**Step 1: Create test utilities**

Create `packages/memorybank/src/__tests__/test-utils.ts`:
```typescript
import { vi } from 'vitest';

export function createMockDatabase() {
  return {
    query: vi.fn(),
    transaction: vi.fn(),
    close: vi.fn(),
  };
}

export function createMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}
```

**Step 2: Write ThreadRepository tests**

Create `packages/memorybank/src/__tests__/repositories/ThreadRepository.test.ts`:
```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ThreadRepository } from '../../repositories/ThreadRepository';
import { createMockDatabase } from '../test-utils';

describe('ThreadRepository', () => {
  let repo: ThreadRepository;
  let mockDb: any;

  beforeEach(() => {
    mockDb = createMockDatabase();
    repo = new ThreadRepository(mockDb);
  });

  describe('list', () => {
    it('should list all threads without filters', async () => {
      mockDb.query.mockResolvedValue([
        { id: 1, name: 'thread-1', status: 'active', thought_count: 5 },
        { id: 2, name: 'thread-2', status: 'paused', thought_count: 3 },
      ]);

      const threads = await repo.list({});

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT'),
        []
      );
      expect(threads).toHaveLength(2);
      expect(threads[0].name).toBe('thread-1');
    });

    it('should filter by status', async () => {
      mockDb.query.mockResolvedValue([
        { id: 1, name: 'thread-1', status: 'active' },
      ]);

      await repo.list({ status: 'active' });

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('t.status = $1'),
        ['active']
      );
    });

    it('should filter by projectId', async () => {
      mockDb.query.mockResolvedValue([]);

      await repo.list({ projectId: 5 });

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('t.project_id = $1'),
        [5]
      );
    });

    it('should limit results', async () => {
      mockDb.query.mockResolvedValue([]);

      await repo.list({ limit: 10 });

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('LIMIT $1'),
        [10]
      );
    });
  });

  describe('getById', () => {
    it('should get thread by id with thoughts and context', async () => {
      mockDb.query.mockResolvedValueOnce([
        { id: 1, name: 'test-thread', status: 'active' },
      ]).mockResolvedValueOnce([
        { id: 10, content: 'thought 1', thought_type: 'progress' },
      ]).mockResolvedValueOnce([
        { key: 'context-key', value: { data: 'value' } },
      ]);

      const result = await repo.getById(1, true, true);

      expect(result.thread.name).toBe('test-thread');
      expect(result.thoughts).toHaveLength(1);
      expect(result.context).toHaveLength(1);
    });

    it('should get thread without thoughts and context', async () => {
      mockDb.query.mockResolvedValue([
        { id: 1, name: 'test-thread' },
      ]);

      const result = await repo.getById(1, false, false);

      expect(result.thread.name).toBe('test-thread');
      expect(result.thoughts).toBeUndefined();
      expect(result.context).toBeUndefined();
      expect(mockDb.query).toHaveBeenCalledTimes(1);
    });
  });

  describe('create', () => {
    it('should create thread with transaction', async () => {
      const mockClient = {
        query: vi.fn()
          .mockResolvedValueOnce({ rows: [{ id: 1, name: 'new-thread', status: 'active' }] })
          .mockResolvedValueOnce(undefined),
      };

      mockDb.transaction.mockImplementation(async (callback) => {
        return callback(mockClient);
      });

      const thread = await repo.create({
        name: 'new-thread',
        description: 'test description',
      });

      expect(thread.id).toBe(1);
      expect(thread.name).toBe('new-thread');
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO timeline.threads'),
        expect.any(Array)
      );
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO timeline.thread_position'),
        expect.any(Array)
      );
    });
  });

  describe('update', () => {
    it('should update thread status', async () => {
      mockDb.query.mockResolvedValue([
        { id: 1, name: 'thread', status: 'paused' },
      ]);

      const thread = await repo.update(1, { status: 'paused' });

      expect(thread.status).toBe('paused');
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE timeline.threads'),
        expect.arrayContaining(['paused', 1])
      );
    });
  });

  describe('delete', () => {
    it('should delete thread with transaction', async () => {
      const mockClient = {
        query: vi.fn().mockResolvedValue(undefined),
      };

      mockDb.transaction.mockImplementation(async (callback) => {
        return callback(mockClient);
      });

      await repo.delete(1);

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM timeline.context'),
        [1]
      );
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM timeline.thread_position'),
        [1]
      );
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM timeline.thoughts'),
        [1]
      );
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM timeline.threads'),
        [1]
      );
    });
  });
});
```

**Step 3: Run tests to verify they fail**

Run:
```bash
cd packages/memorybank
npm test
```

Expected: FAIL - "Cannot find module '../../repositories/ThreadRepository'"

**Step 4: Commit failing tests**

```bash
git add packages/memorybank/src/__tests__/
git commit -m "test(memorybank): add ThreadRepository tests (failing)"
```

---

## Task 13: ThreadRepository - Implementation

**Files:**
- Create: `packages/memorybank/src/repositories/ThreadRepository.ts`

**Step 1: Implement ThreadRepository**

Create `packages/memorybank/src/repositories/ThreadRepository.ts`:
```typescript
import { DatabaseClient } from '@claudecluster/shared';
import { Thread, ThreadWithPosition, Thought, Context } from '../types';

export interface ThreadFilters {
  status?: string;
  projectId?: number;
  limit?: number;
}

export interface ThreadCreateData {
  name: string;
  description?: string;
  projectId?: number;
  parentThoughtId?: number;
}

export interface ThreadUpdateData {
  status?: string;
  name?: string;
  description?: string;
}

export class ThreadRepository {
  constructor(private db: DatabaseClient) {}

  async list(filters: ThreadFilters): Promise<ThreadWithPosition[]> {
    let sql = `
      SELECT
        t.id, t.name, t.description, t.parent_thought_id, t.status,
        t.created_at, t.updated_at, t.project_id,
        tp.current_thought_id,
        ct.content AS current_thought,
        (SELECT COUNT(*)::int FROM timeline.thoughts th WHERE th.thread_id = t.id) AS thought_count,
        (SELECT COUNT(*)::int FROM timeline.threads child
         WHERE child.parent_thought_id IN (SELECT id FROM timeline.thoughts WHERE thread_id = t.id)
         AND child.status IN ('active', 'paused')) AS open_tangents
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

  async getById(
    threadId: number,
    includeThoughts: boolean = true,
    includeContext: boolean = true
  ): Promise<{
    thread: Thread;
    thoughts?: Thought[];
    context?: Context[];
  }> {
    const [thread] = await this.db.query<Thread>(
      'SELECT * FROM timeline.threads WHERE id = $1',
      [threadId]
    );

    const result: any = { thread };

    if (includeThoughts) {
      result.thoughts = await this.db.query<Thought>(
        'SELECT * FROM timeline.thoughts WHERE thread_id = $1 ORDER BY created_at ASC',
        [threadId]
      );
    }

    if (includeContext) {
      result.context = await this.db.query<Context>(
        'SELECT * FROM timeline.context WHERE thread_id = $1 ORDER BY updated_at DESC',
        [threadId]
      );
    }

    return result;
  }

  async create(data: ThreadCreateData): Promise<Thread> {
    return this.db.transaction(async (client) => {
      const [thread] = await client.query(
        `INSERT INTO timeline.threads (name, description, project_id, parent_thought_id, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'active', NOW(), NOW())
         RETURNING *`,
        [data.name, data.description, data.projectId, data.parentThoughtId]
      );

      await client.query(
        `INSERT INTO timeline.thread_position (thread_id, current_thought_id, updated_at)
         VALUES ($1, NULL, NOW())`,
        [thread.id]
      );

      return thread;
    });
  }

  async update(threadId: number, data: ThreadUpdateData): Promise<Thread> {
    const updates: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (data.status !== undefined) {
      updates.push(`status = $${paramIndex++}`);
      params.push(data.status);
    }

    if (data.name !== undefined) {
      updates.push(`name = $${paramIndex++}`);
      params.push(data.name);
    }

    if (data.description !== undefined) {
      updates.push(`description = $${paramIndex++}`);
      params.push(data.description);
    }

    updates.push(`updated_at = NOW()`);
    params.push(threadId);

    const [thread] = await this.db.query<Thread>(
      `UPDATE timeline.threads SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      params
    );

    return thread;
  }

  async delete(threadId: number): Promise<void> {
    return this.db.transaction(async (client) => {
      await client.query('DELETE FROM timeline.context WHERE thread_id = $1', [threadId]);
      await client.query('DELETE FROM timeline.thread_position WHERE thread_id = $1', [threadId]);
      await client.query('DELETE FROM timeline.thoughts WHERE thread_id = $1', [threadId]);
      await client.query('DELETE FROM timeline.threads WHERE id = $1', [threadId]);
    });
  }
}
```

**Step 2: Run tests to verify they pass**

Run:
```bash
cd packages/memorybank
npm test
```

Expected: PASS - All ThreadRepository tests pass

**Step 3: Build package**

Run:
```bash
npm run build
```

Expected: TypeScript compiles successfully

**Step 4: Commit implementation**

```bash
git add packages/memorybank/src/repositories/ThreadRepository.ts
git commit -m "feat(memorybank): implement ThreadRepository with full CRUD operations"
```

---

## Task 14: ThoughtRepository - Write Tests and Implementation

**Files:**
- Create: `packages/memorybank/src/__tests__/repositories/ThoughtRepository.test.ts`
- Create: `packages/memorybank/src/repositories/ThoughtRepository.ts`

**Step 1: Write ThoughtRepository tests**

Create `packages/memorybank/src/__tests__/repositories/ThoughtRepository.test.ts`:
```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ThoughtRepository } from '../../repositories/ThoughtRepository';
import { createMockDatabase } from '../test-utils';

describe('ThoughtRepository', () => {
  let repo: ThoughtRepository;
  let mockDb: any;

  beforeEach(() => {
    mockDb = createMockDatabase();
    repo = new ThoughtRepository(mockDb);
  });

  it('should create thought and update position', async () => {
    const mockClient = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ id: 10, content: 'test thought' }] })
        .mockResolvedValueOnce(undefined),
    };

    mockDb.transaction.mockImplementation(async (callback) => {
      return callback(mockClient);
    });

    const thought = await repo.create({
      threadId: 1,
      content: 'test thought',
      thoughtType: 'progress',
      updatePosition: true,
    });

    expect(thought.id).toBe(10);
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO timeline.thoughts'),
      expect.any(Array)
    );
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE timeline.thread_position'),
      expect.any(Array)
    );
  });

  it('should get thoughts by thread', async () => {
    mockDb.query.mockResolvedValue([
      { id: 1, content: 'thought 1', thought_type: 'progress' },
      { id: 2, content: 'thought 2', thought_type: 'decision' },
    ]);

    const thoughts = await repo.getByThread(1, { limit: 50 });

    expect(thoughts).toHaveLength(2);
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE thread_id = $1'),
      expect.any(Array)
    );
  });

  it('should delete thought', async () => {
    mockDb.query.mockResolvedValue(undefined);

    await repo.delete(10);

    expect(mockDb.query).toHaveBeenCalledWith(
      'DELETE FROM timeline.thoughts WHERE id = $1',
      [10]
    );
  });
});
```

**Step 2: Run tests to verify they fail**

Run:
```bash
cd packages/memorybank
npm test
```

Expected: FAIL - "Cannot find module '../../repositories/ThoughtRepository'"

**Step 3: Implement ThoughtRepository**

Create `packages/memorybank/src/repositories/ThoughtRepository.ts`:
```typescript
import { DatabaseClient } from '@claudecluster/shared';
import { Thought } from '../types';

export interface ThoughtCreateData {
  threadId: number;
  content: string;
  thoughtType: 'progress' | 'decision' | 'blocker' | 'discovery' | 'question';
  updatePosition?: boolean;
}

export interface ThoughtFilters {
  thoughtType?: string;
  limit?: number;
  offset?: number;
}

export class ThoughtRepository {
  constructor(private db: DatabaseClient) {}

  async create(data: ThoughtCreateData): Promise<Thought> {
    return this.db.transaction(async (client) => {
      const [thought] = await client.query(
        `INSERT INTO timeline.thoughts (thread_id, content, thought_type, created_at)
         VALUES ($1, $2, $3, NOW())
         RETURNING *`,
        [data.threadId, data.content, data.thoughtType]
      );

      if (data.updatePosition !== false) {
        await client.query(
          `UPDATE timeline.thread_position
           SET current_thought_id = $1, updated_at = NOW()
           WHERE thread_id = $2`,
          [thought.id, data.threadId]
        );
      }

      return thought;
    });
  }

  async getByThread(threadId: number, filters: ThoughtFilters = {}): Promise<Thought[]> {
    let sql = `SELECT * FROM timeline.thoughts WHERE thread_id = $1`;
    const params: any[] = [threadId];
    let paramIndex = 2;

    if (filters.thoughtType) {
      sql += ` AND thought_type = $${paramIndex++}`;
      params.push(filters.thoughtType);
    }

    sql += ` ORDER BY created_at ASC`;

    if (filters.limit) {
      sql += ` LIMIT $${paramIndex++}`;
      params.push(filters.limit);
    }

    if (filters.offset) {
      sql += ` OFFSET $${paramIndex++}`;
      params.push(filters.offset);
    }

    return this.db.query(sql, params);
  }

  async delete(thoughtId: number): Promise<void> {
    await this.db.query('DELETE FROM timeline.thoughts WHERE id = $1', [thoughtId]);
  }
}
```

**Step 4: Run tests to verify they pass**

Run:
```bash
cd packages/memorybank
npm test
```

Expected: PASS - All ThoughtRepository tests pass

**Step 5: Commit**

```bash
git add packages/memorybank/src/repositories/ThoughtRepository.ts packages/memorybank/src/__tests__/repositories/ThoughtRepository.test.ts
git commit -m "feat(memorybank): implement ThoughtRepository with create, get, and delete"
```

---

## Task 15: ContextRepository and ProjectRepository - Tests and Implementation

**Files:**
- Create: `packages/memorybank/src/__tests__/repositories/ContextRepository.test.ts`
- Create: `packages/memorybank/src/repositories/ContextRepository.ts`
- Create: `packages/memorybank/src/__tests__/repositories/ProjectRepository.test.ts`
- Create: `packages/memorybank/src/repositories/ProjectRepository.ts`

**Step 1: Write ContextRepository tests**

Create `packages/memorybank/src/__tests__/repositories/ContextRepository.test.ts`:
```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { ContextRepository } from '../../repositories/ContextRepository';
import { createMockDatabase } from '../test-utils';

describe('ContextRepository', () => {
  let repo: ContextRepository;
  let mockDb: any;

  beforeEach(() => {
    mockDb = createMockDatabase();
    repo = new ContextRepository(mockDb);
  });

  it('should get context entries with filters', async () => {
    mockDb.query.mockResolvedValue([
      { key: 'test-key', value: { data: 'value' }, category: 'project' },
    ]);

    const entries = await repo.get({ category: 'project' });

    expect(entries).toHaveLength(1);
    expect(mockDb.query).toHaveBeenCalled();
  });

  it('should upsert context entry', async () => {
    mockDb.query.mockResolvedValue([
      { key: 'test-key', value: { data: 'new' } },
    ]);

    const entry = await repo.set({
      key: 'test-key',
      value: { data: 'new' },
      category: 'project',
    });

    expect(entry.key).toBe('test-key');
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO timeline.context'),
      expect.any(Array)
    );
  });

  it('should delete context entry', async () => {
    mockDb.query.mockResolvedValue(undefined);

    await repo.delete('test-key');

    expect(mockDb.query).toHaveBeenCalledWith(
      'DELETE FROM timeline.context WHERE key = $1',
      ['test-key']
    );
  });
});
```

**Step 2: Implement ContextRepository**

Create `packages/memorybank/src/repositories/ContextRepository.ts`:
```typescript
import { DatabaseClient } from '@claudecluster/shared';
import { Context } from '../types';

export interface ContextFilters {
  threadId?: number;
  category?: string;
  pinned?: boolean;
  key?: string;
}

export interface ContextSetData {
  key: string;
  value: any;
  threadId?: number;
  category: string;
  label?: string;
  pinned?: boolean;
}

export class ContextRepository {
  constructor(private db: DatabaseClient) {}

  async get(filters: ContextFilters = {}): Promise<Context[]> {
    let sql = `SELECT * FROM timeline.context WHERE 1=1`;
    const params: any[] = [];
    let paramIndex = 1;

    if (filters.threadId !== undefined) {
      sql += ` AND thread_id = $${paramIndex++}`;
      params.push(filters.threadId);
    }

    if (filters.category) {
      sql += ` AND category = $${paramIndex++}`;
      params.push(filters.category);
    }

    if (filters.pinned !== undefined) {
      sql += ` AND pinned = $${paramIndex++}`;
      params.push(filters.pinned);
    }

    if (filters.key) {
      sql += ` AND key = $${paramIndex++}`;
      params.push(filters.key);
    }

    sql += ` ORDER BY updated_at DESC`;

    return this.db.query(sql, params);
  }

  async set(data: ContextSetData): Promise<Context> {
    const [entry] = await this.db.query<Context>(
      `INSERT INTO timeline.context (key, value, thread_id, category, label, pinned, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
       ON CONFLICT (key) DO UPDATE SET
         value = EXCLUDED.value,
         thread_id = EXCLUDED.thread_id,
         category = EXCLUDED.category,
         label = EXCLUDED.label,
         pinned = EXCLUDED.pinned,
         updated_at = NOW()
       RETURNING *`,
      [data.key, JSON.stringify(data.value), data.threadId, data.category, data.label, data.pinned || false]
    );

    return entry;
  }

  async delete(key: string): Promise<void> {
    await this.db.query('DELETE FROM timeline.context WHERE key = $1', [key]);
  }
}
```

**Step 3: Write ProjectRepository tests**

Create `packages/memorybank/src/__tests__/repositories/ProjectRepository.test.ts`:
```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { ProjectRepository } from '../../repositories/ProjectRepository';
import { createMockDatabase } from '../test-utils';

describe('ProjectRepository', () => {
  let repo: ProjectRepository;
  let mockDb: any;

  beforeEach(() => {
    mockDb = createMockDatabase();
    repo = new ProjectRepository(mockDb);
  });

  it('should list all projects', async () => {
    mockDb.query.mockResolvedValue([
      { id: 1, name: 'project-1', status: 'active' },
      { id: 2, name: 'project-2', status: 'completed' },
    ]);

    const projects = await repo.list({});

    expect(projects).toHaveLength(2);
  });

  it('should create project', async () => {
    mockDb.query.mockResolvedValue([
      { id: 1, name: 'new-project', description: 'test' },
    ]);

    const project = await repo.create({
      name: 'new-project',
      description: 'test',
    });

    expect(project.name).toBe('new-project');
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO timeline.projects'),
      expect.any(Array)
    );
  });
});
```

**Step 4: Implement ProjectRepository**

Create `packages/memorybank/src/repositories/ProjectRepository.ts`:
```typescript
import { DatabaseClient } from '@claudecluster/shared';
import { Project } from '../types';

export interface ProjectFilters {
  status?: string;
}

export interface ProjectCreateData {
  name: string;
  description?: string;
  employer?: string;
  language?: string;
  location?: string;
  repoUrl?: string;
}

export class ProjectRepository {
  constructor(private db: DatabaseClient) {}

  async list(filters: ProjectFilters = {}): Promise<Project[]> {
    let sql = `SELECT * FROM timeline.projects WHERE 1=1`;
    const params: any[] = [];

    if (filters.status) {
      sql += ` AND status = $1`;
      params.push(filters.status);
    }

    sql += ` ORDER BY updated_at DESC`;

    return this.db.query(sql, params);
  }

  async create(data: ProjectCreateData): Promise<Project> {
    const [project] = await this.db.query<Project>(
      `INSERT INTO timeline.projects (name, description, employer, language, location, repo_url, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
       RETURNING *`,
      [data.name, data.description, data.employer, data.language, data.location, data.repoUrl]
    );

    return project;
  }
}
```

**Step 5: Run tests**

Run:
```bash
cd packages/memorybank
npm test
```

Expected: PASS - All repository tests pass

**Step 6: Commit**

```bash
git add packages/memorybank/src/repositories/ packages/memorybank/src/__tests__/repositories/
git commit -m "feat(memorybank): implement ContextRepository and ProjectRepository"
```

---

## Task 16: MCP Thread Tools - Write Tests

**Files:**
- Create: `packages/memorybank/src/__tests__/tools/threads.test.ts`

**Step 1: Write thread tools tests**

Create `packages/memorybank/src/__tests__/tools/threads.test.ts`:
```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createThreadTools } from '../../tools/threads';
import { ThreadRepository } from '../../repositories/ThreadRepository';
import { createMockLogger } from '../test-utils';

vi.mock('../../repositories/ThreadRepository');

describe('Thread Tools', () => {
  let mockRepo: any;
  let mockLogger: any;
  let tools: any;

  beforeEach(() => {
    mockRepo = {
      list: vi.fn(),
      getById: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    };

    mockLogger = createMockLogger();
    tools = createThreadTools(mockRepo, mockLogger);
  });

  describe('list_threads', () => {
    it('should return tool definition', () => {
      expect(tools.list_threads.schema.description).toBeDefined();
      expect(tools.list_threads.schema.inputSchema).toBeDefined();
    });

    it('should call repository with filters', async () => {
      mockRepo.list.mockResolvedValue([
        { id: 1, name: 'thread-1', status: 'active' },
      ]);

      const result = await tools.list_threads.handler({ status: 'active' });

      expect(mockRepo.list).toHaveBeenCalledWith({ status: 'active' });
      expect(result.threads).toHaveLength(1);
    });
  });

  describe('create_thread', () => {
    it('should create thread', async () => {
      mockRepo.create.mockResolvedValue({
        id: 1,
        name: 'new-thread',
        status: 'active',
      });

      const result = await tools.create_thread.handler({
        name: 'new-thread',
        description: 'test',
      });

      expect(mockRepo.create).toHaveBeenCalledWith({
        name: 'new-thread',
        description: 'test',
      });
      expect(result.thread.id).toBe(1);
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run:
```bash
cd packages/memorybank
npm test
```

Expected: FAIL - "Cannot find module '../../tools/threads'"

**Step 3: Commit failing tests**

```bash
git add packages/memorybank/src/__tests__/tools/
git commit -m "test(memorybank): add thread tools tests (failing)"
```

---

## Task 17: MCP Thread Tools - Implementation

**Files:**
- Create: `packages/memorybank/src/tools/threads.ts`

**Step 1: Implement thread tools**

Create `packages/memorybank/src/tools/threads.ts`:
```typescript
import { ThreadRepository } from '../repositories/ThreadRepository';
import { Logger } from 'winston';

export function createThreadTools(repo: ThreadRepository, logger: Logger) {
  return {
    list_threads: {
      schema: {
        description: 'List threads with optional filters',
        inputSchema: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              enum: ['active', 'paused', 'completed', 'archived'],
              description: 'Filter by thread status',
            },
            projectId: {
              type: 'number',
              description: 'Filter by project ID',
            },
            limit: {
              type: 'number',
              default: 20,
              description: 'Maximum number of threads to return',
            },
          },
        },
      },
      handler: async (args: any) => {
        logger.debug('list_threads called', { args });
        try {
          const threads = await repo.list({
            status: args.status,
            projectId: args.projectId,
            limit: args.limit || 20,
          });
          return { threads };
        } catch (error: any) {
          logger.error('list_threads failed', { error });
          throw new Error(`Failed to list threads: ${error.message}`);
        }
      },
    },

    get_thread: {
      schema: {
        description: 'Get thread with thoughts, position, and context',
        inputSchema: {
          type: 'object',
          properties: {
            threadId: {
              type: 'number',
              description: 'Thread ID',
            },
            includeThoughts: {
              type: 'boolean',
              default: true,
              description: 'Include thought history',
            },
            includeContext: {
              type: 'boolean',
              default: true,
              description: 'Include linked context entries',
            },
          },
          required: ['threadId'],
        },
      },
      handler: async (args: any) => {
        logger.debug('get_thread called', { args });
        try {
          const result = await repo.getById(
            args.threadId,
            args.includeThoughts !== false,
            args.includeContext !== false
          );
          return result;
        } catch (error: any) {
          logger.error('get_thread failed', { error });
          throw new Error(`Failed to get thread: ${error.message}`);
        }
      },
    },

    create_thread: {
      schema: {
        description: 'Create a new thread',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Thread name',
            },
            description: {
              type: 'string',
              description: 'Thread description',
            },
            projectId: {
              type: 'number',
              description: 'Associated project ID',
            },
            parentThoughtId: {
              type: 'number',
              description: 'Parent thought ID for tangent threads',
            },
          },
          required: ['name'],
        },
      },
      handler: async (args: any) => {
        logger.debug('create_thread called', { args });
        try {
          const thread = await repo.create({
            name: args.name,
            description: args.description,
            projectId: args.projectId,
            parentThoughtId: args.parentThoughtId,
          });
          return { thread };
        } catch (error: any) {
          logger.error('create_thread failed', { error });
          throw new Error(`Failed to create thread: ${error.message}`);
        }
      },
    },

    update_thread: {
      schema: {
        description: 'Update thread status, name, or description',
        inputSchema: {
          type: 'object',
          properties: {
            threadId: {
              type: 'number',
              description: 'Thread ID',
            },
            status: {
              type: 'string',
              enum: ['active', 'paused', 'completed', 'archived'],
              description: 'New thread status',
            },
            name: {
              type: 'string',
              description: 'New thread name',
            },
            description: {
              type: 'string',
              description: 'New thread description',
            },
          },
          required: ['threadId'],
        },
      },
      handler: async (args: any) => {
        logger.debug('update_thread called', { args });
        try {
          const thread = await repo.update(args.threadId, {
            status: args.status,
            name: args.name,
            description: args.description,
          });
          return { thread };
        } catch (error: any) {
          logger.error('update_thread failed', { error });
          throw new Error(`Failed to update thread: ${error.message}`);
        }
      },
    },

    delete_thread: {
      schema: {
        description: 'Delete a thread and all its thoughts (WARNING: irreversible)',
        inputSchema: {
          type: 'object',
          properties: {
            threadId: {
              type: 'number',
              description: 'Thread ID',
            },
            confirm: {
              type: 'boolean',
              description: 'Must be true to confirm deletion',
            },
          },
          required: ['threadId', 'confirm'],
        },
      },
      handler: async (args: any) => {
        logger.debug('delete_thread called', { args });
        if (!args.confirm) {
          throw new Error('Deletion not confirmed - set confirm: true');
        }
        try {
          await repo.delete(args.threadId);
          return { success: true, message: 'Thread deleted' };
        } catch (error: any) {
          logger.error('delete_thread failed', { error });
          throw new Error(`Failed to delete thread: ${error.message}`);
        }
      },
    },
  };
}
```

**Step 2: Run tests to verify they pass**

Run:
```bash
cd packages/memorybank
npm test
```

Expected: PASS - All thread tools tests pass

**Step 3: Commit implementation**

```bash
git add packages/memorybank/src/tools/threads.ts
git commit -m "feat(memorybank): implement 5 MCP thread tools"
```

---

## Task 18: MCP Thought, Context, and Project Tools - Implementation

**Files:**
- Create: `packages/memorybank/src/tools/thoughts.ts`
- Create: `packages/memorybank/src/tools/context.ts`
- Create: `packages/memorybank/src/tools/projects.ts`

**Step 1: Implement thought tools**

Create `packages/memorybank/src/tools/thoughts.ts`:
```typescript
import { ThoughtRepository } from '../repositories/ThoughtRepository';
import { Logger } from 'winston';

export function createThoughtTools(repo: ThoughtRepository, logger: Logger) {
  return {
    log_thought: {
      schema: {
        description: 'Add a thought to a thread and update position',
        inputSchema: {
          type: 'object',
          properties: {
            threadId: { type: 'number' },
            content: { type: 'string' },
            thoughtType: {
              type: 'string',
              enum: ['progress', 'decision', 'blocker', 'discovery', 'question'],
              default: 'progress',
            },
            updatePosition: { type: 'boolean', default: true },
          },
          required: ['threadId', 'content'],
        },
      },
      handler: async (args: any) => {
        logger.debug('log_thought called', { args });
        try {
          const thought = await repo.create({
            threadId: args.threadId,
            content: args.content,
            thoughtType: args.thoughtType || 'progress',
            updatePosition: args.updatePosition !== false,
          });
          return { thought };
        } catch (error: any) {
          logger.error('log_thought failed', { error });
          throw new Error(`Failed to log thought: ${error.message}`);
        }
      },
    },

    get_thoughts: {
      schema: {
        description: 'Get thoughts for a thread with optional filters',
        inputSchema: {
          type: 'object',
          properties: {
            threadId: { type: 'number' },
            thoughtType: { type: 'string' },
            limit: { type: 'number', default: 50 },
            offset: { type: 'number', default: 0 },
          },
          required: ['threadId'],
        },
      },
      handler: async (args: any) => {
        logger.debug('get_thoughts called', { args });
        try {
          const thoughts = await repo.getByThread(args.threadId, {
            thoughtType: args.thoughtType,
            limit: args.limit || 50,
            offset: args.offset || 0,
          });
          return { thoughts };
        } catch (error: any) {
          logger.error('get_thoughts failed', { error });
          throw new Error(`Failed to get thoughts: ${error.message}`);
        }
      },
    },

    delete_thought: {
      schema: {
        description: 'Delete a thought (WARNING: may break thread history)',
        inputSchema: {
          type: 'object',
          properties: {
            thoughtId: { type: 'number' },
            confirm: { type: 'boolean' },
          },
          required: ['thoughtId', 'confirm'],
        },
      },
      handler: async (args: any) => {
        logger.debug('delete_thought called', { args });
        if (!args.confirm) {
          throw new Error('Deletion not confirmed - set confirm: true');
        }
        try {
          await repo.delete(args.thoughtId);
          return { success: true, message: 'Thought deleted' };
        } catch (error: any) {
          logger.error('delete_thought failed', { error });
          throw new Error(`Failed to delete thought: ${error.message}`);
        }
      },
    },
  };
}
```

**Step 2: Implement context tools**

Create `packages/memorybank/src/tools/context.ts`:
```typescript
import { ContextRepository } from '../repositories/ContextRepository';
import { Logger } from 'winston';

export function createContextTools(repo: ContextRepository, logger: Logger) {
  return {
    get_context: {
      schema: {
        description: 'Get context entries with filters',
        inputSchema: {
          type: 'object',
          properties: {
            threadId: { type: 'number' },
            category: {
              type: 'string',
              enum: ['project', 'pr', 'machine', 'waiting', 'fact', 'reminder'],
            },
            pinned: { type: 'boolean' },
            key: { type: 'string' },
          },
        },
      },
      handler: async (args: any) => {
        logger.debug('get_context called', { args });
        try {
          const entries = await repo.get({
            threadId: args.threadId,
            category: args.category,
            pinned: args.pinned,
            key: args.key,
          });
          return { context: entries };
        } catch (error: any) {
          logger.error('get_context failed', { error });
          throw new Error(`Failed to get context: ${error.message}`);
        }
      },
    },

    set_context: {
      schema: {
        description: 'Set a context entry (upsert by key)',
        inputSchema: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            value: { type: 'object' },
            threadId: { type: 'number' },
            category: { type: 'string' },
            label: { type: 'string' },
            pinned: { type: 'boolean', default: false },
          },
          required: ['key', 'value', 'category'],
        },
      },
      handler: async (args: any) => {
        logger.debug('set_context called', { args });
        try {
          const entry = await repo.set({
            key: args.key,
            value: args.value,
            threadId: args.threadId,
            category: args.category,
            label: args.label,
            pinned: args.pinned || false,
          });
          return { context: entry };
        } catch (error: any) {
          logger.error('set_context failed', { error });
          throw new Error(`Failed to set context: ${error.message}`);
        }
      },
    },

    delete_context: {
      schema: {
        description: 'Delete a context entry by key',
        inputSchema: {
          type: 'object',
          properties: {
            key: { type: 'string' },
          },
          required: ['key'],
        },
      },
      handler: async (args: any) => {
        logger.debug('delete_context called', { args });
        try {
          await repo.delete(args.key);
          return { success: true, message: 'Context deleted' };
        } catch (error: any) {
          logger.error('delete_context failed', { error });
          throw new Error(`Failed to delete context: ${error.message}`);
        }
      },
    },
  };
}
```

**Step 3: Implement project tools**

Create `packages/memorybank/src/tools/projects.ts`:
```typescript
import { ProjectRepository } from '../repositories/ProjectRepository';
import { Logger } from 'winston';

export function createProjectTools(repo: ProjectRepository, logger: Logger) {
  return {
    list_projects: {
      schema: {
        description: 'List all projects with optional status filter',
        inputSchema: {
          type: 'object',
          properties: {
            status: { type: 'string' },
          },
        },
      },
      handler: async (args: any) => {
        logger.debug('list_projects called', { args });
        try {
          const projects = await repo.list({
            status: args.status,
          });
          return { projects };
        } catch (error: any) {
          logger.error('list_projects failed', { error });
          throw new Error(`Failed to list projects: ${error.message}`);
        }
      },
    },

    create_project: {
      schema: {
        description: 'Create a new project',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            employer: { type: 'string' },
            language: { type: 'string' },
            location: { type: 'string' },
            repoUrl: { type: 'string' },
          },
          required: ['name'],
        },
      },
      handler: async (args: any) => {
        logger.debug('create_project called', { args });
        try {
          const project = await repo.create({
            name: args.name,
            description: args.description,
            employer: args.employer,
            language: args.language,
            location: args.location,
            repoUrl: args.repoUrl,
          });
          return { project };
        } catch (error: any) {
          logger.error('create_project failed', { error });
          throw new Error(`Failed to create project: ${error.message}`);
        }
      },
    },
  };
}
```

**Step 4: Build package**

Run:
```bash
cd packages/memorybank
npm run build
```

Expected: TypeScript compiles successfully

**Step 5: Commit**

```bash
git add packages/memorybank/src/tools/
git commit -m "feat(memorybank): implement thought, context, and project MCP tools (9 additional tools)"
```

---

## Task 19: MCP Server Entry Point - Implementation

**Files:**
- Create: `packages/memorybank/src/server.ts`
- Create: `packages/memorybank/src/config.ts`

**Step 1: Implement config loader**

Create `packages/memorybank/src/config.ts`:
```typescript
import { readFileSync } from 'fs';
import { parse } from 'yaml';

export interface ServerConfig {
  server: {
    host: string;
    port: number;
    tls: {
      enabled: boolean;
      certPath: string;
      keyPath: string;
      caPath: string;
    };
  };
  database: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    maxConnections?: number;
  };
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';
    file?: string;
  };
}

export function loadConfig(path: string): ServerConfig {
  const content = readFileSync(path, 'utf-8');
  return parse(content);
}
```

**Step 2: Implement server**

Create `packages/memorybank/src/server.ts`:
```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { DatabaseClient, MCPTransport, createMCPLogger } from '@claudecluster/shared';
import { createServer } from 'http';
import { loadConfig } from './config';
import { ThreadRepository } from './repositories/ThreadRepository';
import { ThoughtRepository } from './repositories/ThoughtRepository';
import { ContextRepository } from './repositories/ContextRepository';
import { ProjectRepository } from './repositories/ProjectRepository';
import { createThreadTools } from './tools/threads';
import { createThoughtTools } from './tools/thoughts';
import { createContextTools } from './tools/context';
import { createProjectTools } from './tools/projects';

async function main() {
  const args = process.argv.slice(2);
  const configPath = args.includes('--config')
    ? args[args.indexOf('--config') + 1]
    : process.env.HOME + '/.claudecluster/memorybank.yaml';

  const config = loadConfig(configPath);
  const logger = createMCPLogger({
    level: config.logging.level,
    logFile: config.logging.file,
  });

  logger.info('Starting Memorybank MCP server', { config: configPath });

  // Initialize database
  const db = new DatabaseClient(config.database, logger);

  // Initialize repositories
  const threadRepo = new ThreadRepository(db);
  const thoughtRepo = new ThoughtRepository(db);
  const contextRepo = new ContextRepository(db);
  const projectRepo = new ProjectRepository(db);

  // Create MCP server
  const mcpServer = new Server(
    {
      name: 'memorybank',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Register all tools
  const allTools = {
    ...createThreadTools(threadRepo, logger),
    ...createThoughtTools(thoughtRepo, logger),
    ...createContextTools(contextRepo, logger),
    ...createProjectTools(projectRepo, logger),
  };

  for (const [name, tool] of Object.entries(allTools)) {
    mcpServer.setRequestHandler({ method: 'tools/list' }, async () => ({
      tools: Object.entries(allTools).map(([toolName, t]) => ({
        name: toolName,
        ...t.schema,
      })),
    }));

    mcpServer.setRequestHandler({ method: 'tools/call', params: { name } }, async (request) => {
      return tool.handler(request.params.arguments);
    });
  }

  // Set up mTLS transport
  const transport = new MCPTransport(
    {
      certPath: config.server.tls.certPath,
      keyPath: config.server.tls.keyPath,
      caPath: config.server.tls.caPath,
      host: config.server.host,
      port: config.server.port,
    },
    mcpServer,
    logger
  );

  // Health check endpoint (no mTLS)
  const healthServer = createServer((req, res) => {
    if (req.url === '/health') {
      db.query('SELECT 1')
        .then(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: 'healthy',
            uptime: process.uptime(),
            timestamp: new Date().toISOString(),
          }));
        })
        .catch((err) => {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: 'unhealthy',
            error: err.message
          }));
        });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  healthServer.listen(config.server.port + 1, config.server.host);
  logger.info('Health check endpoint listening', {
    host: config.server.host,
    port: config.server.port + 1,
  });

  // Graceful shutdown
  process.on('SIGINT', async () => {
    logger.info('Shutting down...');
    transport.close();
    healthServer.close();
    await db.close();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
```

**Step 3: Build server**

Run:
```bash
cd packages/memorybank
npm run build
```

Expected: TypeScript compiles successfully, `dist/server.js` created

**Step 4: Commit**

```bash
git add packages/memorybank/src/server.ts packages/memorybank/src/config.ts
git commit -m "feat(memorybank): implement MCP server entry point with 14 tools"
```

---

## Task 20: Certificate Generation Script

**Files:**
- Create: `scripts/generate-certs.sh`

**Step 1: Write certificate generation script**

Create `scripts/generate-certs.sh`:
```bash
#!/bin/bash
# Generate CA, server cert, and client certs for memorybank mTLS

set -e

CERT_DIR="$HOME/.claudecluster/certs"
mkdir -p "$CERT_DIR"/{ca,server,clients}

echo "Generating CA (Certificate Authority)..."
openssl genrsa -out "$CERT_DIR/ca/ca.key" 4096
openssl req -new -x509 -days 3650 -key "$CERT_DIR/ca/ca.key" \
  -out "$CERT_DIR/ca/ca.crt" \
  -subj "/C=US/ST=State/L=City/O=Claudecluster/CN=Claudecluster CA"

echo "Generating server certificate (memorybank on anvil)..."
openssl genrsa -out "$CERT_DIR/server/memorybank.key" 2048
openssl req -new -key "$CERT_DIR/server/memorybank.key" \
  -out "$CERT_DIR/server/memorybank.csr" \
  -subj "/C=US/ST=State/L=City/O=Claudecluster/CN=anvil"

openssl x509 -req -in "$CERT_DIR/server/memorybank.csr" \
  -CA "$CERT_DIR/ca/ca.crt" -CAkey "$CERT_DIR/ca/ca.key" \
  -CAcreateserial -out "$CERT_DIR/server/memorybank.crt" \
  -days 365 -sha256

echo "Generating client certificates..."
for client in terminus rog2; do
  echo "  - $client"
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
rm "$CERT_DIR"/server/*.csr "$CERT_DIR"/clients/*.csr 2>/dev/null || true

echo ""
echo "✅ Certificates generated in $CERT_DIR"
echo ""
echo "Next steps:"
echo "1. Copy server certs to anvil:"
echo "   scp -r $CERT_DIR/server $CERT_DIR/ca paschal@192.168.1.138:~/.claudecluster/certs/"
echo ""
echo "2. Client certificates are ready at:"
echo "   - terminus: $CERT_DIR/clients/terminus.{crt,key}"
echo "   - rog2: $CERT_DIR/clients/rog2.{crt,key}"
echo ""
echo "3. Create memorybank.yaml config on anvil"
```

**Step 2: Make executable**

Run:
```bash
chmod +x scripts/generate-certs.sh
```

**Step 3: Commit**

```bash
git add scripts/generate-certs.sh
git commit -m "feat: add certificate generation script for mTLS"
```

---

## Task 21: Deployment Files and Documentation

**Files:**
- Create: `packages/memorybank/memorybank.service`
- Create: `packages/memorybank/memorybank.yaml.example`
- Create: `packages/memorybank/README.md`

**Step 1: Create systemd service file**

Create `packages/memorybank/memorybank.service`:
```ini
[Unit]
Description=Memorybank MCP Server - Timeline access for Claude Code
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=paschal
Group=paschal
WorkingDirectory=/home/paschal/claudecluster/packages/memorybank
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

**Step 2: Create example config**

Create `packages/memorybank/memorybank.yaml.example`:
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

**Step 3: Create README**

Create `packages/memorybank/README.md`:
```markdown
# Memorybank MCP Server

MCP server providing typed, structured access to the Cerebrus timeline database.

## Features

- **14 MCP tools** for full CRUD on timeline schema (threads, thoughts, context, projects)
- **mTLS security** with client certificate authentication
- **Transaction support** for atomic multi-step operations
- **Health check endpoint** for monitoring
- **Localhost binding** requiring SSH tunnel for network access

## Installation

### On Anvil (Server)

1. **Generate certificates** (run on terminus):
   ```bash
   cd ~/claudecluster
   ./scripts/generate-certs.sh
   ```

2. **Copy certs to anvil**:
   ```bash
   scp -r ~/.claudecluster/certs/server ~/.claudecluster/certs/ca paschal@192.168.1.138:~/.claudecluster/certs/
   ```

3. **Create config file**:
   ```bash
   cp packages/memorybank/memorybank.yaml.example ~/.claudecluster/memorybank.yaml
   # Edit with actual paths if needed
   ```

4. **Deploy and start service**:
   ```bash
   cd ~/claudecluster
   npm run build
   sudo cp packages/memorybank/memorybank.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable memorybank
   sudo systemctl start memorybank
   ```

5. **Verify**:
   ```bash
   systemctl status memorybank
   curl http://localhost:5556/health
   ```

### On Client (Terminus, Rog2)

1. **Client certificates** are already generated in `~/.claudecluster/certs/clients/`

2. **Add to Claude Code settings** (`~/.claude/settings.json`):
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

## Tools

### Thread Management (5 tools)
- `list_threads` - Query threads with filters
- `get_thread` - Get full thread details
- `create_thread` - Start new thread
- `update_thread` - Modify thread metadata
- `delete_thread` - Remove thread

### Thought Management (3 tools)
- `log_thought` - Add thought to thread
- `get_thoughts` - Query thoughts for thread
- `delete_thought` - Remove thought

### Context Management (3 tools)
- `get_context` - Query context entries
- `set_context` - Add/update context
- `delete_context` - Remove context

### Project Management (2 tools)
- `list_projects` - Get all projects
- `create_project` - Add new project

## Monitoring

```bash
# Service status
systemctl status memorybank

# Recent logs
journalctl -u memorybank --since "1 hour ago"

# Health check
curl http://localhost:5556/health
```

## Development

```bash
# Build
npm run build

# Watch mode
npm run dev

# Tests
npm test
```
```

**Step 4: Commit**

```bash
git add packages/memorybank/memorybank.service packages/memorybank/memorybank.yaml.example packages/memorybank/README.md
git commit -m "docs(memorybank): add deployment files and README"
```

---

## Task 22: Build and Deploy to Anvil

**Note:** This task should be executed manually, not via automated test

**Step 1: Build all packages**

Run:
```bash
cd ~/claudecluster
npm install
npm run build
```

Expected: All packages build successfully

**Step 2: Generate certificates**

Run:
```bash
./scripts/generate-certs.sh
```

Expected: Certificates created in `~/.claudecluster/certs/`

**Step 3: Copy to anvil**

Run:
```bash
# Copy server certs
scp -r ~/.claudecluster/certs/server ~/.claudecluster/certs/ca paschal@192.168.1.138:~/.claudecluster/certs/

# Deploy code
rsync -av --exclude node_modules packages/ paschal@192.168.1.138:~/claudecluster/packages/
rsync -av package.json package-lock.json paschal@192.168.1.138:~/claudecluster/
```

Expected: Files copied successfully

**Step 4: Install and start service on anvil**

Run:
```bash
ssh paschal@192.168.1.138 << 'EOF'
  cd ~/claudecluster
  npm install --production

  # Create config
  cp packages/memorybank/memorybank.yaml.example ~/.claudecluster/memorybank.yaml

  # Install systemd service
  sudo cp packages/memorybank/memorybank.service /etc/systemd/system/
  sudo systemctl daemon-reload
  sudo systemctl enable memorybank
  sudo systemctl start memorybank

  # Check status
  systemctl status memorybank
  curl http://localhost:5556/health
EOF
```

Expected: Service running, health check returns `{"status":"healthy"}`

**Step 5: Verify logs**

Run:
```bash
ssh paschal@192.168.1.138 'journalctl -u memorybank -n 50'
```

Expected: Server started successfully, no errors

**Step 6: Commit deployment notes**

```bash
git add .
git commit -m "deploy: memorybank MCP server deployed to anvil"
```

---

## Task 23: Integration Testing from Client

**Note:** This task requires the server to be running on anvil

**Files:**
- Create: `scripts/smoke-test.ts`

**Step 1: Write smoke test script**

Create `scripts/smoke-test.ts`:
```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { homedir } from 'os';

async function smokeTest() {
  const certDir = `${homedir()}/.claudecluster/certs`;
  const hostname = require('os').hostname().split('.')[0];

  console.log(`Running smoke test from ${hostname}...`);

  const client = new Client(
    {
      name: 'smoke-test',
      version: '1.0.0',
    },
    {
      capabilities: {},
    }
  );

  try {
    console.log('Connecting to memorybank server...');
    await client.connect({
      url: 'tls://localhost:5555',
      tls: {
        cert: `${certDir}/clients/${hostname}.crt`,
        key: `${certDir}/clients/${hostname}.key`,
        ca: `${certDir}/ca/ca.crt`,
      },
    });
    console.log('✓ Connected');

    console.log('\nTesting list_threads...');
    const threads = await client.request({
      method: 'tools/call',
      params: {
        name: 'list_threads',
        arguments: { status: 'active', limit: 5 },
      },
    });
    console.log(`✓ Listed ${threads.result.threads.length} active threads`);

    console.log('\nTesting create_thread...');
    const newThread = await client.request({
      method: 'tools/call',
      params: {
        name: 'create_thread',
        arguments: {
          name: `smoke-test-${Date.now()}`,
          description: 'Automated smoke test',
        },
      },
    });
    console.log(`✓ Created thread ${newThread.result.thread.id}`);

    console.log('\nTesting log_thought...');
    await client.request({
      method: 'tools/call',
      params: {
        name: 'log_thought',
        arguments: {
          threadId: newThread.result.thread.id,
          content: 'Smoke test thought',
          thoughtType: 'progress',
        },
      },
    });
    console.log('✓ Logged thought');

    console.log('\nTesting get_context...');
    const context = await client.request({
      method: 'tools/call',
      params: {
        name: 'get_context',
        arguments: { pinned: true },
      },
    });
    console.log(`✓ Retrieved ${context.result.context.length} pinned context entries`);

    console.log('\n✅ All smoke tests passed!');
  } catch (error: any) {
    console.error('\n❌ Smoke test failed:', error.message);
    process.exit(1);
  } finally {
    await client.close();
  }
}

smokeTest();
```

**Step 2: Add to package.json scripts**

Modify root `package.json`, add to scripts:
```json
"smoke-test": "npx tsx scripts/smoke-test.ts"
```

**Step 3: Install tsx**

Run:
```bash
npm install --save-dev tsx
```

**Step 4: Run smoke test** (requires SSH tunnel to anvil)

Run:
```bash
# Start SSH tunnel in background
ssh -L 5555:localhost:5555 paschal@192.168.1.138 -N -f

# Run smoke test
npm run smoke-test
```

Expected: All tests pass

**Step 5: Commit**

```bash
git add scripts/smoke-test.ts package.json
git commit -m "test: add smoke test script for MCP server integration"
```

---

## Execution Handoff

Plan complete and saved to `docs/plans/2026-02-15-memorybank-implementation-plan.md`.

Two execution options:

**1. Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

**Which approach?**
