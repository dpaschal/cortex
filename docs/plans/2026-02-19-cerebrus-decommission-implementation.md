# Cerebrus Decommission Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove all cerebrus PostgreSQL dependencies from the session bootstrap. Add a `generateWhereami()` method to SharedMemoryDB that writes `~/.cortex/whereami.md` on every timeline/context write, providing a fallback when cortex MCP is unavailable.

**Architecture:** Hook into `SharedMemoryDB.run()` and `runInTransaction()` to detect writes to timeline/context tables. After each such write, regenerate a static markdown snapshot at `~/.cortex/whereami.md`. Update `~/.claude/CLAUDE.md` to use a two-path bootstrap: cortex MCP primary, `whereami.md` fallback. Remove all psql/cerebrus references.

**Tech Stack:** TypeScript, better-sqlite3, vitest

---

### Task 1: Add `generateWhereami()` to SharedMemoryDB

**Files:**
- Modify: `src/memory/shared-memory-db.ts:3,26,290-302`
- Test: `tests/shared-memory-db.test.ts`

**Step 1: Write the failing test**

Add to `tests/shared-memory-db.test.ts`:

```typescript
describe('generateWhereami', () => {
  it('generates whereami.md with active threads', () => {
    // Seed data
    db.run('INSERT INTO timeline_projects (name) VALUES (?)', ['TestProject']);
    db.run('INSERT INTO timeline_threads (name, status, project_id) VALUES (?, ?, ?)', ['Thread A', 'active', 1]);
    db.run('INSERT INTO timeline_thoughts (thread_id, content, thought_type) VALUES (?, ?, ?)', [1, 'Did something important', 'progress']);
    db.run('INSERT INTO timeline_thread_position (thread_id, current_thought_id) VALUES (?, ?)', [1, 1]);
    db.run(`INSERT INTO timeline_context (key, value, category, pinned) VALUES (?, ?, ?, ?)`, ['project:test', '"test value"', 'project', 1]);

    db.generateWhereami();

    const mdPath = path.join(tmpDir, 'whereami.md');
    expect(fs.existsSync(mdPath)).toBe(true);

    const content = fs.readFileSync(mdPath, 'utf-8');
    expect(content).toContain('# Cortex State');
    expect(content).toContain('Thread A');
    expect(content).toContain('Did something important');
    expect(content).toContain('project:test');
  });

  it('includes recent thoughts section', () => {
    db.run('INSERT INTO timeline_threads (name, status) VALUES (?, ?)', ['Thread B', 'active']);
    db.run('INSERT INTO timeline_thoughts (thread_id, content, thought_type) VALUES (?, ?, ?)', [1, 'First thought', 'progress']);
    db.run('INSERT INTO timeline_thoughts (thread_id, content, thought_type) VALUES (?, ?, ?)', [1, 'Second thought', 'decision']);

    db.generateWhereami();

    const content = fs.readFileSync(path.join(tmpDir, 'whereami.md'), 'utf-8');
    expect(content).toContain('## Recent Thoughts');
    expect(content).toContain('Second thought');
  });

  it('handles empty database gracefully', () => {
    db.generateWhereami();

    const content = fs.readFileSync(path.join(tmpDir, 'whereami.md'), 'utf-8');
    expect(content).toContain('# Cortex State');
    expect(content).toContain('No active threads');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test:run -- tests/shared-memory-db.test.ts`
Expected: FAIL — `db.generateWhereami is not a function`

**Step 3: Implement `generateWhereami()`**

In `src/memory/shared-memory-db.ts`, add a `private dataDir: string;` property (line ~26) and save `config.dataDir` in the constructor. Then add the method:

```typescript
  // ================================================================
  // Whereami Snapshot
  // ================================================================

  generateWhereami(): void {
    const now = new Date().toISOString();
    const lines: string[] = [`# Cortex State — ${now}`, ''];

    // Active threads with positions
    const threads = this.db.prepare(`
      SELECT
        t.id, t.name, t.status,
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
    `).all() as Array<{
      id: number; name: string; status: string;
      current_thought_id: number | null;
      current_thought_content: string | null;
      thought_type: string | null;
      last_updated: string | null;
      project_name: string | null;
      thought_count: number;
    }>;

    lines.push('## Active Threads');
    if (threads.length === 0) {
      lines.push('No active threads.', '');
    } else {
      for (const t of threads) {
        const project = t.project_name ? ` (project: ${t.project_name})` : '';
        const status = t.status === 'paused' ? ' [PAUSED]' : '';
        lines.push(`- **#${t.id} ${t.name}**${project}${status} — ${t.thought_count} thoughts`);
        if (t.current_thought_content) {
          const truncated = t.current_thought_content.length > 200
            ? t.current_thought_content.slice(0, 200) + '...'
            : t.current_thought_content;
          lines.push(`  Position: thought #${t.current_thought_id} — "${truncated}"`);
        }
      }
      lines.push('');
    }

    // Pinned context
    const context = this.db.prepare(`
      SELECT key, category, label, value FROM timeline_context
      WHERE pinned = 1
      ORDER BY updated_at DESC
    `).all() as Array<{ key: string; category: string; label: string | null; value: string }>;

    lines.push('## Pinned Context');
    if (context.length === 0) {
      lines.push('No pinned context.', '');
    } else {
      for (const c of context) {
        const label = c.label ? ` (${c.label})` : '';
        const value = c.value.length > 150 ? c.value.slice(0, 150) + '...' : c.value;
        lines.push(`- \`${c.key}\`${label}: ${value}`);
      }
      lines.push('');
    }

    // Recent thoughts (last 5 across all threads)
    const recent = this.db.prepare(`
      SELECT t.id, t.thread_id, t.content, t.thought_type, t.created_at,
             th.name AS thread_name
      FROM timeline_thoughts t
      JOIN timeline_threads th ON th.id = t.thread_id
      ORDER BY t.id DESC
      LIMIT 5
    `).all() as Array<{
      id: number; thread_id: number; content: string;
      thought_type: string; created_at: string; thread_name: string;
    }>;

    lines.push('## Recent Thoughts');
    if (recent.length === 0) {
      lines.push('No thoughts yet.', '');
    } else {
      for (const r of recent) {
        const truncated = r.content.length > 200
          ? r.content.slice(0, 200) + '...'
          : r.content;
        lines.push(`${r.id}. #${r.id} (${r.thought_type}, thread #${r.thread_id} ${r.thread_name}): ${truncated}`);
      }
      lines.push('');
    }

    const mdPath = path.join(this.dataDir, 'whereami.md');
    fs.writeFileSync(mdPath, lines.join('\n'));
  }
```

**Step 4: Run test to verify it passes**

Run: `npm run test:run -- tests/shared-memory-db.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/memory/shared-memory-db.ts tests/shared-memory-db.test.ts
git commit -m "feat(memory): add generateWhereami() for static markdown snapshot"
```

---

### Task 2: Hook `run()` and `runInTransaction()` to auto-generate snapshot

**Files:**
- Modify: `src/memory/shared-memory-db.ts:290-302`
- Test: `tests/shared-memory-db.test.ts`

**Step 1: Write the failing test**

Add to `tests/shared-memory-db.test.ts`:

```typescript
describe('auto-snapshot on write', () => {
  it('regenerates whereami.md on timeline write', () => {
    db.run('INSERT INTO timeline_threads (name, status) VALUES (?, ?)', ['Auto Thread', 'active']);

    const mdPath = path.join(tmpDir, 'whereami.md');
    expect(fs.existsSync(mdPath)).toBe(true);
    const content = fs.readFileSync(mdPath, 'utf-8');
    expect(content).toContain('Auto Thread');
  });

  it('regenerates whereami.md on context write', () => {
    db.run(`INSERT INTO timeline_context (key, value, category, pinned) VALUES (?, ?, ?, ?)`,
      ['test:key', '"hello"', 'fact', 1]);

    const content = fs.readFileSync(path.join(tmpDir, 'whereami.md'), 'utf-8');
    expect(content).toContain('test:key');
  });

  it('does NOT regenerate on non-timeline write', () => {
    // Write to network table — should not trigger snapshot
    db.run('INSERT INTO network_clients (hostname, ip_address) VALUES (?, ?)', ['testhost', '10.0.0.1']);

    const mdPath = path.join(tmpDir, 'whereami.md');
    // File may or may not exist (from other tests), but if it does,
    // it should NOT contain 'testhost' since network_clients isn't a trigger
    if (fs.existsSync(mdPath)) {
      const content = fs.readFileSync(mdPath, 'utf-8');
      expect(content).not.toContain('testhost');
    }
  });

  it('regenerates on runInTransaction with timeline statements', () => {
    db.runInTransaction([
      { sql: 'INSERT INTO timeline_threads (name, status) VALUES (?, ?)', params: ['TX Thread', 'active'] },
      { sql: 'INSERT INTO timeline_thoughts (thread_id, content, thought_type) VALUES (?, ?, ?)', params: [1, 'TX thought', 'progress'] },
    ]);

    const content = fs.readFileSync(path.join(tmpDir, 'whereami.md'), 'utf-8');
    expect(content).toContain('TX Thread');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test:run -- tests/shared-memory-db.test.ts`
Expected: FAIL — whereami.md not created by `run()`

**Step 3: Add post-write hook to `run()` and `runInTransaction()`**

Modify `run()` in `src/memory/shared-memory-db.ts`:

```typescript
  private shouldSnapshot(sql: string): boolean {
    const lower = sql.toLowerCase();
    return lower.includes('timeline_') || lower.includes('_context');
  }

  run(sql: string, params: unknown[] = []): { changes: number; lastInsertRowid: number | bigint } {
    const result = this.db.prepare(sql).run(...params);
    if (this.shouldSnapshot(sql)) {
      try { this.generateWhereami(); } catch (e) {
        this.logger.warn('Failed to generate whereami snapshot', { error: e });
      }
    }
    return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
  }

  runInTransaction(statements: { sql: string; params: unknown[] }[]): void {
    const transaction = this.db.transaction(() => {
      for (const { sql, params } of statements) {
        this.db.prepare(sql).run(...params);
      }
    });
    transaction();
    if (statements.some(s => this.shouldSnapshot(s.sql))) {
      try { this.generateWhereami(); } catch (e) {
        this.logger.warn('Failed to generate whereami snapshot', { error: e });
      }
    }
  }
```

**Step 4: Run test to verify it passes**

Run: `npm run test:run -- tests/shared-memory-db.test.ts`
Expected: PASS

**Step 5: Run full test suite**

Run: `npm run test:run`
Expected: All 414+ tests pass

**Step 6: Commit**

```bash
git add src/memory/shared-memory-db.ts tests/shared-memory-db.test.ts
git commit -m "feat(memory): auto-regenerate whereami.md on timeline/context writes"
```

---

### Task 3: Update CLAUDE.md — remove cerebrus, add dual-path bootstrap

**Files:**
- Modify: `~/.claude/CLAUDE.md`

**CRITICAL: Do NOT delete the KeePass vault section or the infra health check section.**

**Step 1: Rewrite the bootstrap section**

Replace the entire "Session Bootstrap" section with:

```markdown
## Session Bootstrap — RUN ON EVERY NEW SESSION

### Step 1: Cortex Shared Memory
Use cortex MCP tools if available — they read from local SQLite instantly:
1. `memory_whereami` — returns active threads, current positions, pinned context, and recent thoughts
2. `memory_get_context` — for specific context lookups (e.g., category='waiting' or pinned items)
3. `memory_list_threads` — detailed thread listing if needed

If cortex MCP is unavailable (service not running, MCP not configured), read the static snapshot:
```
Read ~/.cortex/whereami.md
```
This file is auto-generated on every timeline/context write and contains active threads, pinned context, and recent thoughts.

### Step 2: During Session — Writing
Use `memory_write` or shortcut tools to log thoughts and update context:
- `memory_log_thought` — log progress, decisions, blockers, discoveries
- `memory_set_context` — set/update pinned context entries
- `memory_handoff` — end-of-session structured summary

### Step 3: KeePass Vault (credentials)
```

**Step 2: Remove the "Cerebrus Database (LEGACY)" section**

Delete lines 75-79 entirely (the "Cerebrus Database (LEGACY — being phased out)" section with the psql command).

**Step 3: Remove PostgreSQL credential from Anvil section**

In the Anvil server section, remove:
- `- **PostgreSQL 17:** user cerebrus, password cerebrus2025 (legacy — prefer cortex shared memory)`
- `- psql is NOT installed locally — always SSH to anvil for DB operations`
- `- Collation version mismatch warning (2.42 vs 2.40) is expected and harmless`

Keep the Local IP, Tailscale, and SSH lines.

**Step 4: Verify KeePass section is intact**

Confirm the KeePass vault section (lines ~35-44) with `keepassxc-cli` commands is still present and unchanged. **Do NOT delete this section.**

**Step 5: Verify infra health check section is intact**

Confirm the infrastructure health check section (lines ~47-57) with SSH commands to forge/anvil/terminus is still present and unchanged. **Do NOT delete this section.**

**Step 6: Commit**

```bash
git add ~/.claude/CLAUDE.md
git commit -m "refactor: remove cerebrus from CLAUDE.md bootstrap, add whereami.md fallback"
```

Note: `~/.claude/CLAUDE.md` is outside the git repo — this commit is for tracking purposes. The file change is applied directly.

---

### Task 4: Build, test, deploy

**Step 1: Build**

```bash
npm run build
```

Expected: Clean compile.

**Step 2: Run full test suite**

```bash
npm run test:run
```

Expected: All tests pass (414 + new tests from Tasks 1-2).

**Step 3: Commit and push**

```bash
git push
```

**Step 4: Deploy to all 6 nodes**

For each node (forge, hammer, htnas02, anvil, terminus, gauntlet):
```bash
cd ~/claudecluster && git pull --rebase && npm run build && sudo systemctl restart claudecluster
```

**Step 5: Verify whereami.md is generated on forge**

After restarting, trigger a write (e.g., via MCP or by running the migration script) and check:
```bash
cat ~/.cortex/whereami.md
```

Expected: Structured markdown with active threads, pinned context, recent thoughts.

**Step 6: Commit**

```bash
git add src/ tests/
git commit -m "chore: final cerebrus decommission — dual-path bootstrap complete"
```

---

## Verification

After all tasks:

```bash
npm run build                    # Clean compile
npm run test:run                 # All tests pass
cat ~/.cortex/whereami.md        # Snapshot exists and is readable
grep -c 'psql' ~/.claude/CLAUDE.md  # Should return 0
grep -c 'cerebrus' ~/.claude/CLAUDE.md  # Should return 0
```

Acceptable remaining cerebrus references:
- `docs/plans/*.md` — historical design documents
- `scripts/migrate-to-shared-memory.ts` — recovery tool (reads from cerebrus)
- `config/default.yaml` — if any legacy comments exist
