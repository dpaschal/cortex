import Database from 'better-sqlite3';

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS te_tasks (
      id TEXT PRIMARY KEY,
      workflow_id TEXT,
      task_key TEXT,
      type TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued',
      priority INTEGER NOT NULL DEFAULT 0,
      spec TEXT NOT NULL,
      constraints TEXT,
      retry_policy TEXT,
      assigned_node TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      result TEXT,
      error TEXT,
      scheduled_after TEXT,
      created_at TEXT NOT NULL,
      assigned_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      dead_lettered_at TEXT
    );

    CREATE TABLE IF NOT EXISTS te_workflows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      definition TEXT NOT NULL,
      context TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS te_task_dependencies (
      workflow_id TEXT NOT NULL,
      task_key TEXT NOT NULL,
      depends_on_key TEXT NOT NULL,
      condition TEXT,
      PRIMARY KEY (workflow_id, task_key, depends_on_key)
    );

    CREATE TABLE IF NOT EXISTS te_task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      node_id TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_te_tasks_state ON te_tasks(state);
    CREATE INDEX IF NOT EXISTS idx_te_tasks_workflow ON te_tasks(workflow_id);
    CREATE INDEX IF NOT EXISTS idx_te_tasks_assigned ON te_tasks(assigned_node, state);
    CREATE INDEX IF NOT EXISTS idx_te_events_task ON te_task_events(task_id);
    CREATE INDEX IF NOT EXISTS idx_te_deps_workflow ON te_task_dependencies(workflow_id);
  `);
}
