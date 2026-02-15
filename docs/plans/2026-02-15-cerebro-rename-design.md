# Cerebro Rename + Anvil Ubuntu Migration

**Date:** 2026-02-15
**Status:** Approved
**Thread:** #7 (cross-session-memory), #15 (sentinel)

## Summary

Rename all references to "cerebrus" to "cerebro" (Spanish for brain) across the entire environment, combined with migrating anvil from NixOS to Ubuntu Server 24.04 LTS. The OS migration eliminates the need to update NixOS configs that would immediately be discarded.

## Approach

Big Bang — one session, one machine at a time in dependency order. Anvil gets backed up via Borg to forge ZFS, wiped, reinstalled as Ubuntu Server LTS, and the database is restored under the new name. Then forge and terminus configs are updated, and the GitHub repo is renamed last.

## Decisions

- **Password:** Generate a strong random password for the new `cerebro` role (stored in KeePass)
- **SSH key:** Regenerate forge's SSH keypair with comment `forge@cerebro`
- **Downtime:** Unlimited — home lab, no SLA
- **GKE/scripts on forge:** Historical artifacts, bulk find-and-replace
- **Borg target:** Forge ZFS pool at `/work/backups/anvil-borg`

## Blast Radius

~55+ files across 4 machines + 1 GitHub repo + DB content.

### Anvil (192.168.1.138)

| Location | What Changes |
|----------|-------------|
| PostgreSQL database | `cerebrus` → `cerebro` |
| PostgreSQL role | `cerebrus` → `cerebro`, new password |
| `/etc/nixos/configuration.nix` | Replaced by Ubuntu — no update needed |
| `~/memorybank/dist/index.js` | `CEREBRUS_*` env vars → `CEREBRO_*`, fallback values |

### Forge (10.0.10.11)

| Location | What Changes |
|----------|-------------|
| `~/.ssh/id_ed25519*` | Regenerated with `forge@cerebro` comment |
| `/etc/systemd/system/mnt-ramdisk.mount` | Description text |
| `/work/ai/CLAUDE.md` | DB credentials, connection info |
| `/work/ai/docs/CLAUDE.md` | DB credentials |
| `/work/ai/Lincoln/CLAUDE.md` | DB credentials |
| `/work/ai/helpers/config.sh` | cerebrus references |
| `/work/ai/helpers/deploy-pxe.sh` | cerebrus references |
| `/work/ai/scripts/restore-gke-from-backup.sh` | cerebrus references |
| `/work/ai/scripts/backup-gke-to-storage.sh` | cerebrus references |
| `/work/ai/api-nexus/internal/handlers/handlers.go` | Connection string |
| `/work/ai/sentinel/docs/plans/2026-02-13-sentinel-design.md` | DB reference |
| `/work/ai/gke-migration/manifests/*` (5 files) | cerebrus references |
| `/work/ai/infrastructure/gke-migration/manifests/*` (5 files) | cerebrus references |
| `/work/ai/.claude/commands/cerebrus.md` | Rename file → `cerebro.md` |
| `/work/ai/.claude/commands/*.md` (5 files) | cerebrus references |
| `/work/ai/.claude/settings.local.json` | cerebrus reference |
| `/work/ai/docs/TrackerDB.md` | cerebrus DB docs |
| `/work/ai/docs/session-notes.md` | cerebrus references |
| `/work/ai/TrackerDB.md` | cerebrus DB docs |
| `/work/ai/session-notes.md` | cerebrus references |

### Terminus (Workstation)

| Location | What Changes |
|----------|-------------|
| `~/.claude/CLAUDE.md` | Bootstrap queries, credentials, section header |
| `~/.claude/projects/-home-paschal/memory/MEMORY.md` | Project references, section header |
| `~/.claude/projects/-home-paschal-mnt-forge-ai-Lincoln/memory/MEMORY.md` | Credentials, restore notes |
| `~/.claude/projects/-home-paschal-mnt-forge-ai/memory/MEMORY.md` | Credentials, timeline usage |
| `~/claudecluster/src/mcp/timeline-db.ts` | Connection string fallback |
| `~/claudecluster/src/mcp/context-db.ts` | Connection string fallback |
| `~/claudecluster/src/mcp/network-db.ts` | Connection string fallback |
| `~/claudecluster/dist/mcp/*.js` (3 files) | Rebuilt from source |
| `~/claudecluster/docs/plans/*.md` (6 files) | cerebrus references in docs |
| `~/claudecluster/.worktrees/memorybank/src/mcp/*.ts` (3 files) | Connection strings |
| `~/claudecluster/.worktrees/memorybank/packages/memorybank/src/index.ts` | `CEREBRUS_*` env vars |
| `~/claudecluster/.worktrees/memorybank/dist/**/*.js` | Rebuilt from source |

### GitHub

| Location | What Changes |
|----------|-------------|
| `dpaschal/cerebrus` | Rename repo → `dpaschal/cerebro` |

### Memorybank DB Content

| Location | What Changes |
|----------|-------------|
| `timeline.context` entries | Update references to "cerebrus" |
| `timeline.projects` | Update project descriptions if needed |

---

## Phase 1: Prepare & Back Up Anvil

### Step 1: Generate new cerebro password

Generate a strong random password. Store in KeePass under `Infrastructure/Anvil/Cerebro DB`.

### Step 2: PostgreSQL logical dump

Run `pg_dumpall` on anvil to capture all databases (cerebrus + sentinel), roles, schemas, and data. This is the authoritative backup for DB restoration. Save output to a known location for Borg to pick up.

### Step 3: Borg backup of anvil

- Install Borg on anvil if not present
- Install Borg on forge if not present
- Initialize Borg repo on forge: `/work/backups/anvil-borg`
- Back up from anvil:
  - `/home/paschal` (memorybank, configs, pg_dumpall output)
  - `/etc/nixos` (historical reference)
  - `/etc/ssh/ssh_host_*` (host keys — preserves known_hosts across reinstall)
  - `/var/lib/syncthing` config (or just Syncthing config dir)
  - Tailscale state (`/var/lib/tailscale`)
- Verify: `borg list`, `borg check`

### Step 4: Document current anvil services

Inventory everything running on anvil so nothing is forgotten during Ubuntu setup:
- PostgreSQL 17 (cerebrus DB, sentinel DB)
- memorybank MCP server (`~/memorybank/`)
- Syncthing (vault + file sync)
- Tailscale (100.69.42.106, `anvil-1`)
- Any systemd services, cron jobs, NixOS-specific configs

---

## Phase 2: Install Ubuntu Server LTS on Anvil

### Step 5: Install Ubuntu Server 24.04 LTS

- Boot from USB/PXE (forge PXE server available)
- Fresh install, same network identity:
  - Hostname: `anvil`
  - IP: 192.168.1.138 (static or DHCP reservation)
  - User: `paschal`
- Restore SSH host keys from Borg backup so terminus/forge known_hosts don't break

### Step 6: Install core services

- PostgreSQL 17 (from Ubuntu repos or PGDG)
- Node.js 22 LTS (for memorybank MCP server)
- Syncthing (restore config from backup)
- Tailscale (re-auth with same node name)
- Borg (for ongoing backups to forge)
- KeePassXC CLI (for credential access)

---

## Phase 3: Restore DB as Cerebro

### Step 7: Create cerebro role + database, restore data

- Create role `cerebro` with the new strong password
- Create database `cerebro` owned by `cerebro`
- Process the pg_dumpall output:
  - `sed` to remap `cerebrus` → `cerebro` in role/database names
  - Restore into the new database
- Restore `sentinel` database separately (no rename needed — sentinel has its own DB on forge now, but if anvil had a copy, restore as-is)
- Verify: `psql -U cerebro -d cerebro -c "SELECT COUNT(*) FROM timeline.threads;"`

### Step 8: Redeploy memorybank MCP server

- Restore `~/memorybank/` from Borg backup
- Update source: `CEREBRUS_*` → `CEREBRO_*` env vars, fallback values
- Rebuild or patch `dist/index.js`
- Start MCP server, verify tools respond via Claude Code

---

## Phase 4: Rename on Forge

### Step 9: Regenerate forge SSH key

- Generate new keypair: `ssh-keygen -t ed25519 -C "forge@cerebro"`
- Remove old key from GitHub account
- Add new key to GitHub account
- Update `authorized_keys` on:
  - Forge (if it has its own key in authorized_keys)
  - Anvil (new Ubuntu install — add during setup)
  - Any other machines that had the old forge key

### Step 10: Bulk rename forge files

- Find-and-replace `cerebrus` → `cerebro` across `/work/ai/`:
  - CLAUDE.md files (3)
  - Helper scripts (config.sh, deploy-pxe.sh)
  - Backup scripts (2)
  - GKE migration manifests (10 files across 2 dirs)
  - api-nexus Go source
  - Sentinel design doc
  - Claude commands (6 files)
  - Claude settings
  - TrackerDB docs, session notes
- Rename file: `.claude/commands/cerebrus.md` → `cerebro.md`
- Update systemd ramdisk unit description
- Commit changes in affected repos

---

## Phase 5: Rename on Terminus

### Step 11: Update Claude configs + memory

- `~/.claude/CLAUDE.md`:
  - Bootstrap SSH commands: `cerebrus` → `cerebro` (user, DB name)
  - Password: old → new
  - Section header: "Cerebrus Database" → "Cerebro Database"
- Memory files (3):
  - `MEMORY.md`: project references, section header
  - Lincoln memory: credentials
  - Forge memory: credentials

### Step 12: Update claudecluster source

- Main branch `src/mcp/*.ts` (3 files): connection string fallbacks
- Worktree `packages/memorybank/src/index.ts`: `CEREBRUS_*` → `CEREBRO_*` env vars + fallbacks
- Worktree `src/mcp/*.ts` (3 files): connection string fallbacks
- `npm run build` in both locations to regenerate `dist/`
- Deploy updated memorybank to anvil (replaces Phase 3 temporary patch)
- Commit on main branch and memorybank worktree

---

## Phase 6: GitHub + Memorybank Cleanup

### Step 13: Rename GitHub repo

- `gh repo rename cerebro --repo dpaschal/cerebrus`
- Update git remotes on forge (`/work/ai/` repos that reference cerebrus)
- Update git remotes on terminus (if any)

### Step 14: Update memorybank context entries

- Query `timeline.context` for any values containing "cerebrus"
- Update entries to reference "cerebro"
- Update `timeline.projects` descriptions if needed
- Delete the `rename:cerebrus-to-cerebro` waiting context (task complete)

### Step 15: Final verification

- [ ] `psql -U cerebro -d cerebro` works from anvil
- [ ] memorybank MCP tools all respond (`mb_whereami`, `mb_log_thought`, etc.)
- [ ] Claude Code bootstrap queries in CLAUDE.md work
- [ ] All machines can SSH to anvil (host keys restored)
- [ ] Tailscale node `anvil-1` back online
- [ ] Syncthing syncing across all nodes
- [ ] Git push from forge to GitHub works with new SSH key
- [ ] Sentinel on forge unaffected (uses its own local DB)
- [ ] No remaining references to "cerebrus" on any machine
- [ ] KeePass updated with new credentials

---

## Rollback Plan

If anything goes wrong mid-migration:
- Borg backup on forge (`/work/backups/anvil-borg`) contains full anvil state
- pg_dumpall contains complete database backup
- Can reinstall NixOS and restore from Borg if Ubuntu install fails
- Git history preserves all pre-rename file states
