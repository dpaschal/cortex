# cortex.shared.memory Design

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:writing-plans to create an implementation plan from this design.

**Goal:** Replace all external databases (cerebrus PostgreSQL, meshdb, meshmonitor SQLite) with a single Raft-replicated SQLite database embedded in every Cortex node, backed up to Google Cloud Storage.

**Architecture:** Writes go through the Raft leader and replicate to all followers via log entries. Reads are instant from local SQLite. A data classification system prevents sensitive data from reaching the cloud backup.

**Tech Stack:** SQLite (better-sqlite3), Raft (existing), gRPC (existing), Litestream (GCS backup), MCP SDK

---

## Architecture

```
+---------------------------------------------+
|  cortex node (forge, anvil, terminus, etc.)  |
|                                              |
|  +--------------------------------------+    |
|  |  cortex.shared.memory               |    |
|  |                                      |    |
|  |  +------------+  +---------------+   |    |
|  |  | SQLite DB  |  | MCP Tools     |   |    |
|  |  | (local)    |  | (hybrid CRUD  |   |    |
|  |  |            |  |  + shortcuts) |   |    |
|  |  +-----+------+  +-------+-------+   |    |
|  |        |                 |            |    |
|  |  +-----+-----------------+--------+   |    |
|  |  |  Raft Replication Layer        |   |    |
|  |  |  - Writes -> leader -> log     |   |    |
|  |  |  - Reads -> local SQLite       |   |    |
|  |  +--------------------------------+   |    |
|  +--------------------------------------+    |
|                                              |
|  +--------------+                            |
|  | Litestream   |-> gs://paschal-homelab-    |
|  | (leader only)|     backups/cortex/        |
|  +--------------+                            |
+----------------------------------------------+
```

### Write Path

1. MCP tool or internal API receives a write
2. If this node is the leader: create Raft log entry `{ type: 'sql_write', sql: '...', params: [...], checksum: '<sha256>' }`
3. Raft replicates to followers via existing AppendEntries RPC
4. Once committed (majority ack), leader applies SQL to local SQLite and returns success
5. Followers receive committed entry, verify SHA-256 checksum, apply to their local SQLite

### Read Path

Reads go directly to local SQLite. No network hop. Followers may be slightly stale (one heartbeat interval, 2-5 seconds max). Acceptable for a knowledge store.

### Write Forwarding

If a non-leader node receives a write, it forwards to the leader via a new `ForwardWrite` gRPC call. The leader handles replication and returns the result.

---

## Database Schema

Single file at `~/.cortex/shared-memory.db`. Tables namespaced by domain prefix.

### Table Domains

| Prefix | Source | Key Tables |
|--------|--------|------------|
| `timeline_` | cerebrus timeline schema | threads, thoughts, thread_position, projects, context |
| `network_` | cerebrus public schema | network_clients, networks, unifi_devices |
| `infra_` | cerebrus public schema | builds, configs, environments, secrets, events, sessions, documents, document_versions, wiki_pages, kernel_configs, test_results |
| `task_` | cerebrus public schema | agent_tasks, task_alerts, task_coordination_log |
| `htnas02_` | cerebrus htnas02 schema | All 21 tables (work_sessions, docker_containers, k8s_resources, disk_snapshots, tasks, etc.) |
| `mesh_` | meshdb.db (terminus) | my_nodes, channels, config |
| `meshmonitor_` | meshmonitor.db (terminus) | nodes, messages, channels, telemetry, traceroutes, sessions, audit_log, etc. (30+ tables) |

### Schema Migration

- Export each source table's DDL
- Translate PostgreSQL types to SQLite: `jsonb` -> `TEXT`, `timestamptz` -> `TEXT` (ISO8601), `serial` -> `INTEGER PRIMARY KEY`
- Prefix table names with domain
- Export data as INSERT statements
- Project-local databases (project.db, trackerdb markdown) stay with their projects

---

## Data Classification

Three-tier system to control what leaves the local network.

| Tier | Label | Replicates to nodes? | Backs up to GCS? | Examples |
|------|-------|---------------------|-------------------|----------|
| 1 | `public` | Yes | Yes | Timeline thoughts, network devices, mesh nodes, htnas02 tracking |
| 2 | `internal` | Yes | No | Context entries with credentials, secrets table, API keys |
| 3 | `local` | No | No | Node-specific state that shouldn't leave the machine |

### Implementation

- Each table has a default classification set in schema metadata (a `_table_classification` config table)
- `local` entries never enter the Raft log
- Litestream backs up a **filtered replica** — a second SQLite file excluding `internal` and `local` tables. Only the filtered copy streams to GCS
- `memory_write` accepts an optional `classification` override per-row
- `memory_schema` shows table classifications for discoverability

### Auto-Detection

When writing via `memory_set_context`, if the value matches credential patterns (API keys, passwords, tokens, connection strings), the system warns and defaults to `internal` classification unless explicitly overridden.

### Default Classifications

| Tables | Classification |
|--------|---------------|
| `timeline_threads`, `timeline_thoughts`, `timeline_projects`, `timeline_thread_position` | public |
| `timeline_context` | internal (may contain credentials) |
| `network_*`, `mesh_*`, `meshmonitor_*`, `htnas02_*` | public |
| `infra_secrets` | internal |
| `infra_builds`, `infra_configs`, `infra_events`, `infra_sessions`, etc. | public |
| `task_*` | public |

---

## Integrity & Checksums

### Per-Entry Checksum

Each Raft log entry includes a SHA-256 hash of `sql + JSON.stringify(params)`. Followers verify the checksum before applying. Mismatch = reject entry + request snapshot.

### Periodic Full-DB Checksum

- Leader periodically computes a hash of the SQLite database content (deterministic query over all tables, not file hash since WAL state may differ)
- Followers compute the same hash and report during heartbeat
- Mismatch triggers a full snapshot resync for the drifted follower
- Frequency: every 5 minutes or configurable

---

## Log Compaction & Snapshots

The Raft log cannot grow forever.

- **Snapshot:** Periodically, the leader creates a snapshot (the SQLite `.db` file itself)
- **Log truncation:** After snapshot, old log entries are discarded
- **New node join:** Gets the full SQLite snapshot via existing `PushDistBundle` streaming RPC, then starts receiving incremental log entries
- **Fell-behind node:** If within log window, replays missed entries. If too far behind, gets a fresh snapshot

---

## Cloud Backup

**Litestream** on the leader node streams WAL to GCS:

```bash
litestream replicate ~/.cortex/shared-memory-public.db gs://paschal-homelab-backups/cortex/shared-memory/
```

- **Continuous:** Changes replicated to GCS within seconds
- **Point-in-time recovery:** Litestream keeps WAL generations
- **Leader-only:** Avoids duplicate backups. Leadership change = new leader starts streaming
- **Filtered replica only:** The `shared-memory-public.db` file excludes `internal` and `local` tables

### Recovery Scenarios

| Scenario | Recovery |
|----------|----------|
| Single node lost | Raft snapshot from leader rebuilds it |
| All nodes lost | `litestream restore` from GCS |
| Accidental deletion | Point-in-time restore from GCS |

---

## MCP Tools

12 tools total (replaces 49 across cortex + memorybank).

### Generic Base (4 tools)

| Tool | Purpose |
|------|---------|
| `memory_query` | Read-only SQL query against local SQLite |
| `memory_write` | Write SQL (INSERT/UPDATE/DELETE). Routed through Raft leader |
| `memory_schema` | List tables or describe columns. Shows classification |
| `memory_stats` | Replication status, DB size, last backup time, row counts per domain, classification tier counts |

### Smart Shortcuts (8 tools)

| Tool | Replaces | Purpose |
|------|----------|---------|
| `memory_log_thought` | `mb_log_thought`, `timeline_add_thought` | Log thought to thread (auto-chains, updates position) |
| `memory_whereami` | `mb_whereami`, `timeline_where_am_i` | Session-start: active threads + pinned context |
| `memory_handoff` | `timeline_handoff` | End-of-session structured summary |
| `memory_set_context` | `mb_set_context`, `context_set` | Upsert context entry by key (with credential auto-detection) |
| `memory_get_context` | `mb_get_context`, `context_get` | Get context entries (key, category, pinned, recent) |
| `memory_search` | `mb_search_thoughts` | Full-text search across thought content |
| `memory_network_lookup` | `network_lookup` | Search device by hostname/IP/MAC |
| `memory_list_threads` | `mb_list_threads`, `timeline_list_threads` | List threads with position and thought count |

---

## What Gets Retired

| Component | Action |
|-----------|--------|
| Standalone memorybank MCP server (anvil) | Retired |
| `src/mcp/timeline-tools.ts` | Deleted |
| `src/mcp/timeline-db.ts` | Deleted |
| `src/mcp/context-tools.ts` | Deleted |
| `src/mcp/context-db.ts` | Deleted |
| `src/mcp/network-tools.ts` | Deleted |
| `src/mcp/network-db.ts` | Deleted |
| cerebrus PostgreSQL on anvil | Retired after migration |
| meshdb.db on terminus | Migrated, original kept as archive |
| meshmonitor.db on terminus | Migrated, original kept as archive |
| `memorybank` entry in `~/.claude.json` | Removed |

---

## Migration Plan (High Level)

1. Build the `cortex.shared.memory` module with SQLite + Raft replication
2. Create schema migration scripts (PostgreSQL DDL -> SQLite DDL with prefixes)
3. Export data from cerebrus PostgreSQL (all 3 schemas)
4. Export data from meshdb.db and meshmonitor.db
5. Import into shared-memory.db
6. Build MCP tools (4 generic + 8 shortcuts)
7. Wire into Cortex main class and MCP server
8. Set up Litestream backup to GCS
9. Deploy to all nodes, verify replication
10. Retire memorybank server, remove old MCP tool files
11. Update CLAUDE.md bootstrap queries to use memory_* tools instead of SSH+psql
12. Stop cerebrus PostgreSQL on anvil

---

## GCP Details

- **Project:** `paschal-homelab`
- **Account:** `drew@paschal.ai` / `dpaschal@gmail.com`
- **Bucket:** `gs://paschal-homelab-backups/cortex/shared-memory/`
- **Billing:** Account `01A262-171A3C-AC784A`
- **gcloud CLI:** Available on terminus (100.120.202.76)
