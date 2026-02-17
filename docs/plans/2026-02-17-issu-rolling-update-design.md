# ISSU Rolling Update Design

**Date:** 2026-02-17
**Status:** Approved
**Goal:** Leader-orchestrated rolling update with commit/rollback, inspired by Cisco ISSU, Brocade dual-partition, and NetApp NDU stabilization.

---

## Overview

Build locally, rsync `dist/` to followers one at a time, restart each maintaining Raft quorum, leader restarts last. Each node has a commit/rollback window — if the new code fails health checks, the node reverts to the previous `dist/` automatically.

**v1 approach:** Use existing `AgentClient.executeTask()` with shell commands for rsync and restart. No new proto RPCs needed.

---

## Phase 0: Pre-flight

Before touching any node:

1. **Quorum check** — enumerate active voting nodes via `raft.getPeers()`, compute quorum size (`Math.floor((votingCount + 1) / 2) + 1`). Verify we can lose 1 node. Refuse if not.
2. **Version check** — read local `dist/version.json`. Compare `gitCommit` against running nodes (future: `GetNodeVersion` RPC; v1: just log local version). Refuse if already at target.
3. **Health gate** — all nodes must be `active` in membership with `lastSeen` within 2x heartbeat interval. Refuse if any node is `offline` or `draining`.

---

## Phase 1: Add (per follower, sequential)

For each follower node:

1. **Backup** — `executeTask()` on follower: `mv dist dist.bak`
2. **Rsync** — `executeTask()` on follower: `rsync -az leader_ip:/home/paschal/claudecluster/dist/ /home/paschal/claudecluster/dist/`
3. **Verify** — `executeTask()` on follower: `cat dist/version.json` — confirm matches intended build

---

## Phase 2: Activate (per follower, sequential)

4. **Restart** — `executeTask()`: `systemctl restart claudecluster`
5. **Expect connection drop** — catch gRPC stream error, treat as "restart in progress"
6. **Close stale connection** — `clientPool.closeConnection(address)` to force fresh TCP
7. **Poll health** — `healthCheck()` every 2s, timeout 60s. Wait for `healthy: true`
8. **Stabilization** — after healthCheck passes, wait for:
   - Node appears as `active` in membership
   - Node has sent 3 consecutive successful heartbeats (~15s at 5s interval)

---

## Phase 3: Commit or Rollback (per follower)

9. **If stabilization passes** — `executeTask()`: `rm -rf dist.bak` (commit, discard old version)
10. **If healthCheck times out OR stabilization fails** — rollback:
    - `executeTask()`: `rm -rf dist && mv dist.bak dist && systemctl restart claudecluster`
    - **Abort the entire rolling update** after rollback

---

## Phase 4: Leader Self-Update (last)

After all followers committed:

11. `mv dist dist.bak` locally
12. New build is already in place (built locally)
13. `child_process.exec('systemctl restart claudecluster')` — leader restarts itself
14. Raft election happens automatically (followers have quorum)
15. Leader rejoins as follower, may win re-election

No automated rollback for leader. If restart fails, cluster continues with a new leader; admin manually restores `dist.bak`.

---

## Components

### `src/cluster/updater.ts` — RollingUpdater

Orchestrator class. Methods:

- `execute(options: { dryRun?: boolean })` — runs Phases 0-4
- `preflight()` — Phase 0 checks, returns pass/fail with reasons
- `upgradeFollower(node: NodeInfo)` — Phases 1-3 for one node
- `upgradeLeader()` — Phase 4
- `rollbackNode(node: NodeInfo)` — restore dist.bak, restart
- `waitForStabilization(node: NodeInfo, timeoutMs: number)` — poll membership + heartbeat count

Constructor takes: `membership`, `raft`, `clientPool`, `logger`, `selfNodeId`.

### `scripts/write-version.js` — Version Stamping

Run at build time. Generates `dist/version.json`:
```json
{
  "buildHash": "<sha256 of dist/ contents>",
  "builtAt": "2026-02-17T14:30:00Z",
  "gitCommit": "387b231"
}
```

### MCP Tool: `initiate_rolling_update`

```
Input:  { dryRun?: boolean }
Output: streaming progress messages per step per node
```

`dryRun: true` runs Phase 0 only — reports quorum math, version diff, node health.

---

## Error Handling

| Failure | Action |
|---------|--------|
| Pre-flight quorum insufficient | Refuse, log reason |
| Pre-flight node unhealthy | Refuse, name the node |
| Rsync fails | Restore dist.bak on that node, abort |
| Restart healthCheck times out (60s) | Rollback that node, abort entire update |
| Stabilization fails (node doesn't rejoin Raft) | Rollback that node, abort |
| Leader self-restart fails | Cluster elects new leader; manual recovery |

---

## Files Changed

| File | Action |
|------|--------|
| `src/cluster/updater.ts` | New — RollingUpdater class |
| `scripts/write-version.js` | New — build-time version stamping |
| `src/mcp/tools.ts` | Modify — add `initiate_rolling_update` tool |
| `package.json` | Modify — add version stamp to build chain |

---

## Enterprise Patterns Incorporated

- **Cisco ISSU Add → Activate → Commit**: each node goes through backup → restart → verify → commit, with rollback if verify fails
- **Brocade dual-partition**: `dist.bak/` preserves known-good code for instant rollback
- **NetApp NDU stabilization timer**: don't just check gRPC reachability — wait for Raft membership + sustained heartbeats before proceeding
- **Pre-flight health gate**: refuse upgrade if cluster isn't healthy (all three vendors do this)

---

## References

- [Cisco NX-OS ISSU](https://www.cisco.com/c/en/us/td/docs/switches/datacenter/sw/5_x/nx-os/high_availability/configuration/guide/ha_issu.html)
- [Brocade FOS firmwaredownload](https://techdocs.broadcom.com/us/en/fibre-channel-networking/fabric-os/fabric-os-commands/9-2-x/Fabric-OS-Commands/firmwareDownload_922.html)
- [NetApp ONTAP NDU](https://docs.netapp.com/us-en/ontap/upgrade/task_upgrade_nondisruptive_manual_cli.html)
