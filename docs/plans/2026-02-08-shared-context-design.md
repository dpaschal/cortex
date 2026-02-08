# Shared Context Store Design

**Date:** 2026-02-08
**Status:** Draft
**Author:** Claude + paschal

## Problem

When Claude generates output on one machine (SSH keys, commands, project context), there's no easy way to access it from another machine. Today's pain point: generated an SSH key on chisel, needed to add it to anvil via terminus—ended up using a USB stick.

Beyond ephemeral data, Claude sessions lack persistent memory of project context:
- "Waiting on PR #1777 from Yeraze"
- "meshcore-monitor is my repo, meshmonitor is his"
- "chisel's SSH fingerprint is SHA256:jgoxosq..."

## Solution

A shared context store in cerebrus DB that Claude sessions can read/write via MCP tools. Integrates with the existing timeline system (`/whereami`, `/wherewasi`).

## Data Model

### New Table: `timeline.context`

```sql
CREATE TABLE timeline.context (
    key TEXT PRIMARY KEY,                              -- namespaced: 'pr:Yeraze/meshmonitor:1777'
    value JSONB NOT NULL,                              -- structured data
    thread_id INT REFERENCES timeline.threads(id),    -- optional link to active work
    category TEXT NOT NULL,                            -- 'project', 'pr', 'machine', 'waiting', 'fact'
    label TEXT,                                        -- human-readable: "MeshCore PR #1777"
    source TEXT,                                       -- which machine wrote this: 'chisel', 'terminus'
    pinned BOOLEAN DEFAULT FALSE,                      -- always show in /whereami
    expires_at TIMESTAMPTZ,                            -- auto-cleanup for temporary items
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_context_category ON timeline.context(category);
CREATE INDEX idx_context_thread ON timeline.context(thread_id);
CREATE INDEX idx_context_pinned ON timeline.context(pinned) WHERE pinned = TRUE;
CREATE INDEX idx_context_expires ON timeline.context(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX idx_context_updated ON timeline.context(updated_at DESC);
```

### Key Naming Convention

| Prefix | Example | Purpose |
|--------|---------|---------|
| `project:<name>` | `project:meshcore-monitor` | Project metadata |
| `pr:<repo>:<number>` | `pr:Yeraze/meshmonitor:1777` | PR status and notes |
| `machine:<hostname>` | `machine:chisel` | Machine facts (IP, SSH fingerprint) |
| `waiting:<id>` | `waiting:yeraze-review` | Things blocked on external response |
| `fact:<topic>` | `fact:synology-nas` | General persistent facts |

### Example Entries

```json
{
  "key": "pr:Yeraze/meshmonitor:1777",
  "value": {"status": "waiting", "title": "MeshCore support", "submitted": "2026-02-03"},
  "category": "pr",
  "label": "MeshCore PR #1777",
  "source": "chisel",
  "pinned": true
}

{
  "key": "project:meshcore-monitor",
  "value": {"repo": "dpaschal/meshcore-monitor", "their_repo": "Yeraze/meshmonitor"},
  "category": "project",
  "label": "MeshCore Monitor",
  "source": "terminus"
}

{
  "key": "machine:chisel",
  "value": {"ssh_fingerprint": "SHA256:jgoxosq...", "ip": "192.168.1.x"},
  "category": "machine",
  "label": "chisel",
  "source": "chisel"
}
```

## MCP Tools

### New Files

- `src/mcp/context-db.ts` — Database access layer
- `src/mcp/context-tools.ts` — MCP tool definitions

### Tool Definitions

#### `context_set`

Create or update a context entry.

```typescript
{
  key: string,          // required: "pr:Yeraze/meshmonitor:1777"
  value: object,        // required: {status: "waiting", ...}
  category: string,     // required: "pr" | "project" | "machine" | "waiting" | "fact"
  label?: string,       // optional: "MeshCore PR #1777"
  thread_id?: number,   // optional: link to active thread
  pinned?: boolean,     // optional: always show in /whereami
  expires_at?: string,  // optional: ISO timestamp for auto-cleanup
}
```

#### `context_get`

Retrieve a single entry by key.

```typescript
{
  key: string,          // required: "pr:Yeraze/meshmonitor:1777"
}
```

#### `context_list`

List entries with optional filters.

```typescript
{
  category?: string,    // filter by category
  thread_id?: number,   // filter by thread
  pinned_only?: boolean,// only pinned items
  since_days?: number,  // updated within N days (default: 7)
  limit?: number,       // max results (default: 50)
}
```

#### `context_delete`

Remove an entry.

```typescript
{
  key: string,          // required
}
```

## Skill Integration

### `/whereami` (updated)

Shows active threads + pinned context + recent context.

```
## Active Work
- Thread: "UDM Pro device tracking" (3 thoughts)
  Last: "Working on API credentials"

## Pinned Context
- [machine] chisel: SSH fingerprint SHA256:jgoxosq...
- [project] meshcore-monitor: My MeshCore monitoring tool

## Waiting On
- [pr] Yeraze/meshmonitor #1777: "MeshCore support" — no response since Feb 5
```

### `/wherewasi` (updated)

Shows paused threads + their linked context.

```
## Paused Work
- Thread: "UDM Pro device tracking" (paused 9 hours ago)
  Last: "Tabled. Need correct API credentials."
  Context:
    - [fact] htnas03 is the only Synology
```

### `/remember` (new skill)

Quick way to add context from conversation.

```
User: /remember waiting on PR #1777 from Yeraze

Claude: [calls context_set]
  key: "waiting:pr-1777"
  value: {description: "PR #1777 from Yeraze"}
  category: "waiting"
  label: "Waiting on PR #1777"
  pinned: true

Result: Saved. Will show in /whereami.
```

## Implementation Plan

### Phase 1: Database

1. Create migration for `timeline.context` table
2. Run on anvil/cerebrus

### Phase 2: MCP Tools

1. Create `src/mcp/context-db.ts`
2. Create `src/mcp/context-tools.ts`
3. Register tools in `src/mcp/server.ts`
4. Add tests

### Phase 3: Skills

1. Update `/whereami` skill to query context
2. Update `/wherewasi` skill to show thread-linked context
3. Create `/remember` skill for quick entry

### Phase 4: Cleanup

1. Add cron/scheduled job to delete expired context entries
2. Document usage in CLAUDE.md

## Open Questions

1. **Conflict resolution:** If two machines set the same key simultaneously, last-write-wins is fine?
2. **Expiry default:** Should clipboard-style entries default to 24h expiry?
3. **Size limits:** Cap `value` JSONB at 64KB?

## Success Criteria

- [ ] Claude on chisel can `/remember` something
- [ ] Claude on terminus can see it in `/whereami`
- [ ] PR status persists across sessions
- [ ] USB stick no longer needed for cross-machine data
