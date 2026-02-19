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
