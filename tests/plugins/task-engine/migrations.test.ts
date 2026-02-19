import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../src/plugins/task-engine/migrations.js';

describe('Task Engine Migrations', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('creates all required tables', () => {
    runMigrations(db);

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all().map((r: any) => r.name);

    expect(tables).toContain('te_tasks');
    expect(tables).toContain('te_workflows');
    expect(tables).toContain('te_task_dependencies');
    expect(tables).toContain('te_task_events');
  });

  it('creates tasks table with all columns', () => {
    runMigrations(db);

    const cols = db.prepare("PRAGMA table_info(te_tasks)").all().map((c: any) => c.name);
    expect(cols).toEqual(expect.arrayContaining([
      'id', 'workflow_id', 'task_key', 'type', 'state', 'priority',
      'spec', 'constraints', 'retry_policy', 'assigned_node', 'attempt',
      'result', 'error', 'scheduled_after', 'created_at', 'assigned_at',
      'started_at', 'completed_at', 'dead_lettered_at',
    ]));
  });

  it('creates indexes for common queries', () => {
    runMigrations(db);

    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_te_%'"
    ).all().map((r: any) => r.name);

    expect(indexes.length).toBeGreaterThanOrEqual(3);
  });

  it('is idempotent', () => {
    runMigrations(db);
    runMigrations(db);
    const count = db.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name LIKE 'te_%'").get() as any;
    expect(count.c).toBe(4);
  });
});
