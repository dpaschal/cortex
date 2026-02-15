# Cerebro Rename + Anvil Ubuntu Migration — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rename all "cerebrus" references to "cerebro" across 4 machines + GitHub, combined with migrating anvil from NixOS to Ubuntu Server 24.04 LTS.

**Architecture:** Big Bang approach — back up anvil via Borg, wipe and reinstall as Ubuntu, restore DB under new name, then cascade rename across forge, terminus, and GitHub.

**Tech Stack:** PostgreSQL 17, Borg Backup, Ubuntu Server 24.04 LTS, Node.js 22, Syncthing, Tailscale, KeePassXC CLI

**Design doc:** `docs/plans/2026-02-15-cerebro-rename-design.md`

---

## Pre-Flight: Current State

### Anvil (192.168.1.138) — NixOS, to be replaced

**Running services:**
- PostgreSQL 17 (databases: cerebrus, sentinel, runbooks)
- Sentinel Security Suite (imported via sentinel.nix)
- Syncthing (vault + file sync, config at `~/.config/syncthing`)
- Tailscale (100.69.42.106, node name `anvil-1`)
- Avahi/mDNS
- SSH (key auth for terminus, password auth via Tailscale)
- NixOS auto-upgrade (daily at 04:00)

**Firewall rules to preserve:**
- TCP: 22 (SSH), 8384 (Syncthing GUI), 22000 (Syncthing), 50051
- UDP: 5353 (mDNS), 21027 (Syncthing), 50052
- Tailscale interface trusted

**Kernel hardening (sysctl) to preserve:**
- rp_filter, syncookies, rfc1337, ptrace_scope=2, kptr_restrict=2, dmesg_restrict=1, etc.

### Forge — Borg repo exists

- `/work/backups/anvil-borg` — existing Borg repo (passphrase-protected)
- Key file: `/work/backups/anvil-borg-key.txt`
- Borg already installed at `/usr/bin/borg`

### Databases on Anvil

| Database | Owner | Needs Rename |
|----------|-------|-------------|
| cerebrus | cerebrus | YES → cerebro |
| sentinel | sentinel | NO (sentinel has own DB on forge now) |
| runbooks | cerebrus | YES — owner changes to cerebro |

---

## Phase 1: Prepare & Back Up Anvil

### Task 1: Generate cerebro password and store in KeePass

**Step 1: Generate a 32-character random password**

```bash
ssh paschal@192.168.1.138 "openssl rand -base64 32 | tr -d '/+=' | head -c 32"
```

Save the output — this is the new cerebro password.

**Step 2: Store in KeePass**

```bash
ssh paschal@192.168.1.138 'printf "anvil2026\n" | keepassxc-cli mkdir /home/paschal/Passwords/Passwords.kdbx "Infrastructure/Anvil"'
ssh paschal@192.168.1.138 'printf "anvil2026\n<NEW_PASSWORD>\n" | keepassxc-cli add /home/paschal/Passwords/Passwords.kdbx "Infrastructure/Anvil/Cerebro DB" -u cerebro --password-prompt'
```

**Step 3: Verify**

```bash
ssh paschal@192.168.1.138 'printf "anvil2026\n" | keepassxc-cli show /home/paschal/Passwords/Passwords.kdbx "Infrastructure/Anvil/Cerebro DB" -s'
```

Expected: Shows username `cerebro` and the generated password.

---

### Task 2: PostgreSQL logical dump

**Step 1: Run pg_dumpall on anvil**

```bash
ssh paschal@192.168.1.138 "sudo -u postgres pg_dumpall > /home/paschal/pg_dumpall_$(date +%Y%m%d_%H%M%S).sql"
```

**Step 2: Also dump individual databases for granular restore**

```bash
ssh paschal@192.168.1.138 "sudo -u postgres pg_dump cerebrus > /home/paschal/cerebrus_dump.sql"
ssh paschal@192.168.1.138 "sudo -u postgres pg_dump sentinel > /home/paschal/sentinel_dump.sql"
ssh paschal@192.168.1.138 "sudo -u postgres pg_dump runbooks > /home/paschal/runbooks_dump.sql"
```

**Step 3: Verify dumps are non-empty**

```bash
ssh paschal@192.168.1.138 "ls -lh /home/paschal/*dump*.sql"
```

Expected: Files with reasonable sizes (cerebrus should be the largest with timeline data).

**Step 4: Create the cerebro-ready dump (sed rename)**

```bash
ssh paschal@192.168.1.138 "sed 's/cerebrus/cerebro/g' /home/paschal/pg_dumpall_*.sql > /home/paschal/pg_dumpall_cerebro.sql"
```

**Note:** This renames the role AND database. Verify the sed didn't corrupt anything:

```bash
ssh paschal@192.168.1.138 "grep -c 'cerebro' /home/paschal/pg_dumpall_cerebro.sql"
ssh paschal@192.168.1.138 "grep -c 'cerebrus' /home/paschal/pg_dumpall_cerebro.sql"
```

Expected: First count > 0, second count = 0.

---

### Task 3: Borg backup anvil to forge

**Step 1: Install Borg on anvil (if not present)**

```bash
ssh paschal@192.168.1.138 "which borg 2>/dev/null || nix-env -iA nixos.borgbackup"
```

**Step 2: Get the Borg passphrase**

The existing repo at `/work/backups/anvil-borg` is passphrase-protected. Check the key file:

```bash
ssh paschal@10.0.10.11 "cat /work/backups/anvil-borg-key.txt"
```

Use this passphrase for all Borg operations below.

**Step 3: Create a fresh backup archive from anvil → forge**

Run on anvil (Borg can push to a remote repo via SSH):

```bash
ssh paschal@192.168.1.138 "BORG_PASSPHRASE='<passphrase>' borg create \
  --stats --progress \
  ssh://paschal@10.0.10.11/work/backups/anvil-borg::pre-ubuntu-$(date +%Y%m%d) \
  /home/paschal \
  /etc/nixos \
  /etc/ssh/ssh_host_* \
  /var/lib/tailscale \
  --exclude '/home/paschal/.cache' \
  --exclude '/home/paschal/.local/share/Trash'"
```

If anvil can't SSH to forge, run from forge instead (pull mode):

```bash
ssh paschal@10.0.10.11 "BORG_PASSPHRASE='<passphrase>' borg create \
  --stats --progress \
  /work/backups/anvil-borg::pre-ubuntu-$(date +%Y%m%d) \
  --rsh 'ssh -o StrictHostKeyChecking=no' \
  ssh://paschal@192.168.1.138/home/paschal \
  ssh://paschal@192.168.1.138/etc/nixos \
  ssh://paschal@192.168.1.138/etc/ssh"
```

**Note:** Borg doesn't natively support pulling remote paths into a local repo via `ssh://` source paths in `borg create`. If push mode from anvil fails due to missing SSH key, use this alternative approach:

```bash
# On anvil: create a local tarball of critical files
ssh paschal@192.168.1.138 "sudo tar czf /home/paschal/anvil-backup.tar.gz \
  /home/paschal \
  /etc/nixos \
  /etc/ssh/ssh_host_ed25519_key /etc/ssh/ssh_host_ed25519_key.pub \
  /etc/ssh/ssh_host_rsa_key /etc/ssh/ssh_host_rsa_key.pub \
  --exclude='/home/paschal/.cache' 2>/dev/null"

# Copy to forge
ssh paschal@192.168.1.138 "scp /home/paschal/anvil-backup.tar.gz paschal@10.0.10.11:/work/backups/"

# On forge: add to Borg repo
ssh paschal@10.0.10.11 "cd /tmp && tar xzf /work/backups/anvil-backup.tar.gz && \
  BORG_PASSPHRASE='<passphrase>' borg create \
  --stats /work/backups/anvil-borg::pre-ubuntu-$(date +%Y%m%d) \
  home/ etc/"
```

**Step 4: Verify backup**

```bash
ssh paschal@10.0.10.11 "BORG_PASSPHRASE='<passphrase>' borg list /work/backups/anvil-borg"
ssh paschal@10.0.10.11 "BORG_PASSPHRASE='<passphrase>' borg info /work/backups/anvil-borg::pre-ubuntu-*"
```

Expected: Archive listed with reasonable size, no errors.

**Step 5: Test extracting SSH host keys (critical for known_hosts preservation)**

```bash
ssh paschal@10.0.10.11 "cd /tmp && BORG_PASSPHRASE='<passphrase>' borg extract \
  /work/backups/anvil-borg::pre-ubuntu-* \
  etc/ssh/ssh_host_ed25519_key.pub --stdout 2>/dev/null | head -1"
```

Expected: A public key line starting with `ssh-ed25519`.

---

### Task 4: Document anvil services inventory

**Step 1: Capture full service state**

```bash
ssh paschal@192.168.1.138 "systemctl list-units --type=service --state=running --no-pager"
ssh paschal@192.168.1.138 "systemctl list-timers --no-pager"
ssh paschal@192.168.1.138 "sudo -u postgres psql -c '\l'"
ssh paschal@192.168.1.138 "sudo -u postgres psql -c '\du'"
ssh paschal@192.168.1.138 "cat /etc/nixos/configuration.nix"
ssh paschal@192.168.1.138 "tailscale status"
ssh paschal@192.168.1.138 "syncthing --version 2>/dev/null || echo 'system syncthing'"
```

**Step 2: Save to a reference file on forge**

```bash
ssh paschal@10.0.10.11 "cat > /work/backups/anvil-service-inventory.txt << 'INVENTORY'
# Anvil Service Inventory — Pre-Ubuntu Migration
# Date: $(date)

## PostgreSQL 17
- Databases: cerebrus (→cerebro), sentinel, runbooks
- Roles: cerebrus (→cerebro), sentinel, postgres
- Auth: local=trust, tailscale-subnet=md5
- Port: 5432

## Syncthing
- Config: ~/.config/syncthing
- GUI: 0.0.0.0:8384
- User: paschal

## Tailscale
- IP: 100.69.42.106
- Node: anvil-1
- State: /var/lib/tailscale

## SSH
- Authorized keys (NixOS-managed): terminus only
- Additional: chisel in ~/.ssh/authorized_keys
- Password auth: enabled (should disable on Ubuntu)

## Sentinel
- Imported via sentinel.nix
- Has its own DB (sentinel/sentinel)

## Avahi/mDNS
- Publishing addresses + workstation

## Firewall
- TCP: 22, 8384, 22000, 50051
- UDP: 5353, 21027, 50052
- Tailscale0 trusted

## Kernel Hardening (sysctl)
- rp_filter=1, syncookies=1, rfc1337=1
- ptrace_scope=2, kptr_restrict=2, dmesg_restrict=1
- unprivileged_bpf_disabled=1, bpf_jit_harden=2

## Memorybank MCP Server
- Location: ~/memorybank/dist/index.js
- Node.js process, stdio transport
- Connects to cerebrus DB locally
INVENTORY"
```

**Step 3: Verify**

```bash
ssh paschal@10.0.10.11 "cat /work/backups/anvil-service-inventory.txt"
```

---

## Phase 2: Install Ubuntu Server LTS on Anvil

### Task 5: Install Ubuntu Server 24.04 LTS

**This is a manual/interactive task.** The implementer needs physical or IPMI access to anvil.

**Step 1: Download Ubuntu Server 24.04.x LTS ISO**

Options:
- PXE boot from forge (if PXE is configured for Ubuntu)
- USB boot from ISO downloaded to forge: `wget` the ISO to `/work/` and write to USB

**Step 2: Boot anvil from installer**

Install with these settings:
- Hostname: `anvil`
- Username: `paschal`
- Static IP: `192.168.1.138/24`, gateway `192.168.1.1`, DNS `192.168.1.1`
- Disk: use entire disk (it's a single SSD)
- Enable OpenSSH server during install
- Minimal server install (no snaps, no GUI)

**Step 3: Verify SSH access**

```bash
ssh paschal@192.168.1.138 "uname -a"
```

Expected: Ubuntu 24.04 kernel output.

**Note:** known_hosts on terminus/forge will warn about host key change. We'll restore the old host keys in the next task.

---

### Task 6: Restore SSH host keys and base system setup

**Step 1: Extract old SSH host keys from Borg and copy to anvil**

From forge:
```bash
# Extract host keys from Borg
cd /tmp && BORG_PASSPHRASE='<passphrase>' borg extract \
  /work/backups/anvil-borg::pre-ubuntu-* \
  etc/ssh/

# Copy to anvil
scp -o StrictHostKeyChecking=no /tmp/etc/ssh/ssh_host_* paschal@192.168.1.138:/tmp/
```

On anvil:
```bash
ssh paschal@192.168.1.138 "sudo cp /tmp/ssh_host_* /etc/ssh/ && sudo chmod 600 /etc/ssh/ssh_host_*_key && sudo chmod 644 /etc/ssh/ssh_host_*.pub && sudo systemctl restart sshd"
```

**Step 2: Verify host key matches (from terminus)**

```bash
ssh-keygen -R 192.168.1.138
ssh -o StrictHostKeyChecking=no paschal@192.168.1.138 "echo 'Host keys restored'"
```

**Step 3: Set up passwordless sudo**

```bash
ssh paschal@192.168.1.138 "echo 'paschal ALL=(ALL) NOPASSWD:ALL' | sudo tee /etc/sudoers.d/paschal"
```

**Step 4: Add SSH authorized keys**

```bash
ssh paschal@192.168.1.138 "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys << 'KEYS'
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOYC1UmgHSZ+SVFidb8e4VOn3Bb3miYOpzWkdrKci4F0 paschal@terminus
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFVyqWpw8cjHKv+cta3R38S0/Kx4BGpxtHzaEMXkstzG paschal@chisel
KEYS"
```

**Note:** Forge's key will be added after Task 10 (key regeneration).

**Step 5: Apply kernel hardening (matching NixOS sysctl)**

```bash
ssh paschal@192.168.1.138 "sudo tee /etc/sysctl.d/99-hardening.conf << 'SYSCTL'
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1
net.ipv4.icmp_echo_ignore_broadcasts = 1
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv4.conf.all.secure_redirects = 0
net.ipv4.conf.default.secure_redirects = 0
net.ipv6.conf.all.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.send_redirects = 0
net.ipv4.tcp_syncookies = 1
net.ipv4.tcp_rfc1337 = 1
kernel.kptr_restrict = 2
kernel.dmesg_restrict = 1
kernel.perf_event_paranoid = 3
kernel.yama.ptrace_scope = 2
kernel.unprivileged_bpf_disabled = 1
net.core.bpf_jit_harden = 2
SYSCTL
sudo sysctl --system"
```

**Step 6: Configure firewall (ufw)**

```bash
ssh paschal@192.168.1.138 "sudo apt install -y ufw && \
  sudo ufw default deny incoming && \
  sudo ufw default allow outgoing && \
  sudo ufw allow 22/tcp && \
  sudo ufw allow 8384/tcp && \
  sudo ufw allow 22000/tcp && \
  sudo ufw allow 50051/tcp && \
  sudo ufw allow 5353/udp && \
  sudo ufw allow 21027/udp && \
  sudo ufw allow 50052/udp && \
  sudo ufw allow in on tailscale0 && \
  sudo ufw --force enable"
```

**Step 7: Disable password SSH auth (hardening)**

```bash
ssh paschal@192.168.1.138 "sudo sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config && \
  sudo sed -i 's/^#*KbdInteractiveAuthentication.*/KbdInteractiveAuthentication no/' /etc/ssh/sshd_config && \
  sudo systemctl restart sshd"
```

**Step 8: Verify hardening**

```bash
ssh paschal@192.168.1.138 "sudo ufw status verbose && sysctl kernel.kptr_restrict kernel.dmesg_restrict"
```

Expected: UFW active, sysctl values = 2 and 1 respectively.

---

### Task 7: Install PostgreSQL 17 and restore as cerebro

**Step 1: Install PostgreSQL 17 from PGDG repo**

```bash
ssh paschal@192.168.1.138 "sudo apt install -y postgresql-common && \
  sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y && \
  sudo apt install -y postgresql-17"
```

**Step 2: Create cerebro role with new password**

Retrieve the password from KeePass first:
```bash
ssh paschal@192.168.1.138 'printf "anvil2026\n" | keepassxc-cli show /home/paschal/Passwords/Passwords.kdbx "Infrastructure/Anvil/Cerebro DB" -sa password'
```

Then create the role:
```bash
ssh paschal@192.168.1.138 "sudo -u postgres psql -c \"CREATE ROLE cerebro WITH LOGIN PASSWORD '<password>' CREATEDB;\""
```

**Step 3: Create cerebro database**

```bash
ssh paschal@192.168.1.138 "sudo -u postgres createdb -O cerebro cerebro"
```

**Step 4: Restore timeline schema and data from the individual dump**

Using the original cerebrus dump (more precise than pg_dumpall sed):

```bash
# Copy the dump from forge backup to anvil
ssh paschal@10.0.10.11 "BORG_PASSPHRASE='<passphrase>' borg extract \
  /work/backups/anvil-borg::pre-ubuntu-* \
  home/paschal/cerebrus_dump.sql --stdout" | \
  ssh paschal@192.168.1.138 "cat > /tmp/cerebrus_dump.sql"

# Restore into cerebro database (schema objects are owned by cerebrus in the dump,
# but we're restoring as postgres and will reassign)
ssh paschal@192.168.1.138 "sudo -u postgres psql -d cerebro < /tmp/cerebrus_dump.sql"

# Reassign ownership from cerebrus (if referenced in dump) to cerebro
ssh paschal@192.168.1.138 "sudo -u postgres psql -d cerebro -c 'REASSIGN OWNED BY cerebrus TO cerebro;' 2>/dev/null; echo 'done'"
```

**Step 5: Restore sentinel database**

```bash
ssh paschal@10.0.10.11 "BORG_PASSPHRASE='<passphrase>' borg extract \
  /work/backups/anvil-borg::pre-ubuntu-* \
  home/paschal/sentinel_dump.sql --stdout" | \
  ssh paschal@192.168.1.138 "cat > /tmp/sentinel_dump.sql"

ssh paschal@192.168.1.138 "sudo -u postgres psql -c \"CREATE ROLE sentinel WITH LOGIN PASSWORD 'sentinel123';\" 2>/dev/null"
ssh paschal@192.168.1.138 "sudo -u postgres createdb -O sentinel sentinel"
ssh paschal@192.168.1.138 "sudo -u postgres psql -d sentinel < /tmp/sentinel_dump.sql"
```

**Step 6: Restore runbooks database (owned by cerebro now)**

```bash
ssh paschal@10.0.10.11 "BORG_PASSPHRASE='<passphrase>' borg extract \
  /work/backups/anvil-borg::pre-ubuntu-* \
  home/paschal/runbooks_dump.sql --stdout" | \
  ssh paschal@192.168.1.138 "cat > /tmp/runbooks_dump.sql"

ssh paschal@192.168.1.138 "sudo -u postgres createdb -O cerebro runbooks"
ssh paschal@192.168.1.138 "sudo -u postgres psql -d runbooks < /tmp/runbooks_dump.sql"
ssh paschal@192.168.1.138 "sudo -u postgres psql -d runbooks -c 'REASSIGN OWNED BY cerebrus TO cerebro;' 2>/dev/null; echo 'done'"
```

**Step 7: Configure pg_hba.conf for Tailscale access**

```bash
ssh paschal@192.168.1.138 "echo 'host all all 100.64.0.0/10 scram-sha-256' | sudo tee -a /etc/postgresql/17/main/pg_hba.conf"
ssh paschal@192.168.1.138 "echo \"listen_addresses = '*'\" | sudo tee -a /etc/postgresql/17/main/conf.d/listen.conf"
ssh paschal@192.168.1.138 "sudo systemctl restart postgresql"
```

**Step 8: Verify database restoration**

```bash
ssh paschal@192.168.1.138 "sudo -u postgres psql -c '\l'"
ssh paschal@192.168.1.138 "sudo -u postgres psql -d cerebro -c 'SELECT COUNT(*) FROM timeline.threads;'"
ssh paschal@192.168.1.138 "sudo -u postgres psql -d cerebro -c 'SELECT COUNT(*) FROM timeline.thoughts;'"
ssh paschal@192.168.1.138 "sudo -u postgres psql -d cerebro -c 'SELECT COUNT(*) FROM timeline.context;'"
```

Expected: cerebro database listed, thread/thought/context counts match pre-migration values.

---

### Task 8: Install remaining services on anvil

**Step 1: Install Node.js 22 LTS**

```bash
ssh paschal@192.168.1.138 "curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs"
ssh paschal@192.168.1.138 "node --version"
```

Expected: v22.x.x

**Step 2: Install and configure Tailscale**

```bash
ssh paschal@192.168.1.138 "curl -fsSL https://tailscale.com/install.sh | sh"
ssh paschal@192.168.1.138 "sudo tailscale up"
```

Re-authenticate in the Tailscale admin console to preserve the same node name (`anvil-1`) and IP (`100.69.42.106`).

```bash
ssh paschal@192.168.1.138 "tailscale status"
```

Expected: Connected, IP 100.69.42.106.

**Step 3: Install and configure Syncthing**

```bash
ssh paschal@192.168.1.138 "sudo apt install -y syncthing"
```

Restore Syncthing config from Borg:
```bash
ssh paschal@10.0.10.11 "BORG_PASSPHRASE='<passphrase>' borg extract \
  /work/backups/anvil-borg::pre-ubuntu-* \
  home/paschal/.config/syncthing"

# scp the extracted config to anvil
scp -r /tmp/home/paschal/.config/syncthing paschal@192.168.1.138:~/.config/
```

Create and enable Syncthing user service:
```bash
ssh paschal@192.168.1.138 "sudo systemctl enable --now syncthing@paschal"
```

Verify: `http://192.168.1.138:8384` shows Syncthing GUI.

**Step 4: Install Borg for ongoing backups**

```bash
ssh paschal@192.168.1.138 "sudo apt install -y borgbackup"
```

**Step 5: Install KeePassXC CLI**

```bash
ssh paschal@192.168.1.138 "sudo apt install -y keepassxc"
ssh paschal@192.168.1.138 "keepassxc-cli --version"
```

**Step 6: Install Avahi for mDNS**

```bash
ssh paschal@192.168.1.138 "sudo apt install -y avahi-daemon && sudo systemctl enable --now avahi-daemon"
```

**Step 7: Install basic tools**

```bash
ssh paschal@192.168.1.138 "sudo apt install -y git curl wget htop vim btop ncdu socat python3"
```

---

### Task 9: Redeploy memorybank MCP server on anvil

**Step 1: Restore memorybank from Borg backup**

```bash
# Extract from Borg on forge
ssh paschal@10.0.10.11 "cd /tmp && BORG_PASSPHRASE='<passphrase>' borg extract \
  /work/backups/anvil-borg::pre-ubuntu-* \
  home/paschal/memorybank"

# Copy to anvil
scp -r /tmp/home/paschal/memorybank paschal@192.168.1.138:~/
```

**Step 2: Patch env var names in the deployed code**

```bash
ssh paschal@192.168.1.138 "sed -i 's/CEREBRUS_HOST/CEREBRO_HOST/g; s/CEREBRUS_PORT/CEREBRO_PORT/g; s/CEREBRUS_DB/CEREBRO_DB/g; s/CEREBRUS_USER/CEREBRO_USER/g; s/CEREBRUS_PASSWORD/CEREBRO_PASSWORD/g; s/cerebrus2025/<NEW_PASSWORD>/g; s/cerebrus/cerebro/g' ~/memorybank/dist/index.js"
```

**Note:** Replace `<NEW_PASSWORD>` with the actual generated password from Task 1.

**Step 3: Verify the patched file**

```bash
ssh paschal@192.168.1.138 "grep -i 'cerebr' ~/memorybank/dist/index.js"
```

Expected: Only `cerebro` references, zero `cerebrus` references.

**Step 4: Test memorybank connects to cerebro**

```bash
ssh paschal@192.168.1.138 "cd ~/memorybank && node dist/index.js &"
# Should see: [INFO] Connecting to database {"host":"localhost","port":5432,"database":"cerebro"}
# Kill with Ctrl+C after verifying
```

**Step 5: Update Claude Code MCP config on terminus**

The MCP config in `~/.claude.json` or `~/.config/claude/mcp_config.json` on terminus points to anvil's memorybank. Verify it still works by running:

```bash
# On terminus — this tests the MCP connection end-to-end
```

Use `mb_whereami` from Claude Code to verify. If it fails, check the MCP config for any hardcoded cerebrus references.

---

## Phase 4: Rename on Forge

### Task 10: Regenerate forge SSH key

**Step 1: Generate new keypair on forge**

```bash
ssh paschal@10.0.10.11 "ssh-keygen -t ed25519 -C 'forge@cerebro' -f ~/.ssh/id_ed25519 -N ''"
```

This will prompt to overwrite — confirm yes.

**Step 2: Get the new public key**

```bash
ssh paschal@10.0.10.11 "cat ~/.ssh/id_ed25519.pub"
```

**Step 3: Remove old key from GitHub, add new one**

From terminus (where `gh` is authenticated):

```bash
# Find and remove old forge key
gh ssh-key list
# Note the ID for "forge (10.0.10.11)", then:
gh api -X DELETE /user/keys/<KEY_ID>

# Add new key
gh ssh-key add - --title "forge (10.0.10.11)" <<< "<NEW_PUBLIC_KEY>"
```

**Step 4: Verify GitHub authentication**

```bash
ssh paschal@10.0.10.11 "ssh -T git@github.com 2>&1"
```

Expected: `Hi dpaschal! You've successfully authenticated`

**Step 5: Add new forge key to anvil authorized_keys**

```bash
ssh paschal@192.168.1.138 "echo '<NEW_PUBLIC_KEY>' >> ~/.ssh/authorized_keys"
```

**Step 6: Verify forge → anvil SSH**

```bash
ssh paschal@10.0.10.11 "ssh -o StrictHostKeyChecking=no paschal@192.168.1.138 'echo forge-to-anvil OK'"
```

---

### Task 11: Bulk rename forge files

**Step 1: Run find-and-replace across all files on forge**

```bash
ssh paschal@10.0.10.11 "cd /work/ai && grep -rl 'cerebrus' --include='*.go' --include='*.yaml' --include='*.yml' --include='*.json' --include='*.toml' --include='*.env' --include='*.md' --include='*.sh' --include='*.service' . | xargs sed -i 's/cerebrus/cerebro/g'"
```

**Step 2: Also handle case-sensitive variants (Cerebrus → Cerebro)**

```bash
ssh paschal@10.0.10.11 "cd /work/ai && grep -rl 'Cerebrus' --include='*.go' --include='*.yaml' --include='*.yml' --include='*.json' --include='*.toml' --include='*.env' --include='*.md' --include='*.sh' --include='*.service' . | xargs sed -i 's/Cerebrus/Cerebro/g'"
```

**Step 3: Rename the cerebrus.md command file**

```bash
ssh paschal@10.0.10.11 "mv /work/ai/.claude/commands/cerebrus.md /work/ai/.claude/commands/cerebro.md"
```

**Step 4: Update the systemd ramdisk unit**

```bash
ssh paschal@10.0.10.11 "sudo sed -i 's/CEREBRUS/CEREBRO/g' /etc/systemd/system/mnt-ramdisk.mount && sudo systemctl daemon-reload"
```

**Step 5: Verify no remaining references**

```bash
ssh paschal@10.0.10.11 "grep -ri 'cerebrus' /work/ai/ --include='*.go' --include='*.yaml' --include='*.yml' --include='*.json' --include='*.toml' --include='*.env' --include='*.md' --include='*.sh' --include='*.service' -l 2>/dev/null"
```

Expected: No output (zero files).

**Step 6: Commit changes in git repos on forge**

For each repo with changes:
```bash
ssh paschal@10.0.10.11 "cd /work/ai/sentinel && git add -A && git commit -m 'chore: rename cerebrus → cerebro' 2>/dev/null; echo done"
ssh paschal@10.0.10.11 "cd /work/ai/api-nexus && git add -A && git commit -m 'chore: rename cerebrus → cerebro' 2>/dev/null; echo done"
```

---

## Phase 5: Rename on Terminus

### Task 12: Update Claude configs and memory files on terminus

**Files to modify:**

1. `~/.claude/CLAUDE.md`
2. `~/.claude/projects/-home-paschal/memory/MEMORY.md`
3. `~/.claude/projects/-home-paschal-mnt-forge-ai-Lincoln/memory/MEMORY.md`
4. `~/.claude/projects/-home-paschal-mnt-forge-ai/memory/MEMORY.md`

**Step 1: Update CLAUDE.md**

Replace all instances:
- `cerebrus` → `cerebro` (DB name, user, references)
- `cerebrus2025` → `<NEW_PASSWORD>` (the generated password)
- `Cerebrus` → `Cerebro` (section headers)

```bash
sed -i 's/cerebrus2025/<NEW_PASSWORD>/g; s/cerebrus/cerebro/g; s/Cerebrus/Cerebro/g' ~/.claude/CLAUDE.md
```

**Step 2: Update memory files**

```bash
sed -i 's/cerebrus/cerebro/g; s/Cerebrus/Cerebro/g' \
  ~/.claude/projects/-home-paschal/memory/MEMORY.md \
  ~/.claude/projects/-home-paschal-mnt-forge-ai-Lincoln/memory/MEMORY.md \
  ~/.claude/projects/-home-paschal-mnt-forge-ai/memory/MEMORY.md
```

**Step 3: Verify no remaining references**

```bash
grep -ri 'cerebrus' ~/.claude/CLAUDE.md ~/.claude/projects/*/memory/MEMORY.md 2>/dev/null
```

Expected: No output.

---

### Task 13: Update claudecluster source code

**Step 1: Update main branch source files**

```bash
cd ~/claudecluster

# Connection string fallbacks in MCP source
sed -i 's/cerebrus:cerebrus2025/cerebro:<NEW_PASSWORD>/g; s/cerebrus/cerebro/g' \
  src/mcp/timeline-db.ts \
  src/mcp/context-db.ts \
  src/mcp/network-db.ts

# Verify
grep -r 'cerebrus' src/mcp/*.ts
```

Expected: No output.

**Step 2: Update memorybank worktree source**

```bash
cd ~/claudecluster/.worktrees/memorybank

# MCP source files
sed -i 's/cerebrus:cerebrus2025/cerebro:<NEW_PASSWORD>/g; s/cerebrus/cerebro/g' \
  src/mcp/timeline-db.ts \
  src/mcp/context-db.ts \
  src/mcp/network-db.ts

# Memorybank package — env vars and fallbacks
sed -i 's/CEREBRUS_HOST/CEREBRO_HOST/g; s/CEREBRUS_PORT/CEREBRO_PORT/g; s/CEREBRUS_DB/CEREBRO_DB/g; s/CEREBRUS_USER/CEREBRO_USER/g; s/CEREBRUS_PASSWORD/CEREBRO_PASSWORD/g; s/cerebrus2025/<NEW_PASSWORD>/g; s/cerebrus/cerebro/g' \
  packages/memorybank/src/index.ts

# Verify
grep -r 'cerebrus' src/mcp/*.ts packages/memorybank/src/index.ts
```

Expected: No output.

**Step 3: Update docs (bulk rename)**

```bash
cd ~/claudecluster
grep -rl 'cerebrus' docs/plans/*.md | xargs sed -i 's/cerebrus/cerebro/g; s/Cerebrus/Cerebro/g'
```

**Step 4: Rebuild dist**

```bash
# Main branch
cd ~/claudecluster && npm run build

# Memorybank worktree
cd ~/claudecluster/.worktrees/memorybank && npm run build
```

**Step 5: Verify builds succeed**

```bash
cd ~/claudecluster && npm test 2>&1 | tail -5
cd ~/claudecluster/.worktrees/memorybank && npm test 2>&1 | tail -5
```

**Step 6: Deploy updated memorybank to anvil**

```bash
scp -r ~/claudecluster/.worktrees/memorybank/packages/memorybank/dist/* paschal@192.168.1.138:~/memorybank/dist/
```

This replaces the temporary patch from Task 9 with the properly built version.

**Step 7: Verify MCP server works with updated code**

Use Claude Code's `mb_whereami` tool. Expected: returns active threads and context.

**Step 8: Commit**

```bash
# Main branch
cd ~/claudecluster && git add -A && git commit -m "chore: rename cerebrus → cerebro across all sources and docs

Renames database references, connection strings, env var names, and
documentation from cerebrus to cerebro as part of the environment-wide
rename.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"

# Memorybank worktree
cd ~/claudecluster/.worktrees/memorybank && git add -A && git commit -m "chore: rename cerebrus → cerebro across all sources and docs

Renames database references, connection strings, env var names, and
documentation from cerebrus to cerebro as part of the environment-wide
rename.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Phase 6: GitHub + Memorybank Cleanup

### Task 14: Rename GitHub repo and update remotes

**Step 1: Rename the repo on GitHub**

```bash
gh repo rename cerebro --repo dpaschal/cerebrus --yes
```

**Step 2: Update git remote on forge**

```bash
ssh paschal@10.0.10.11 "cd /work/ai && for d in \$(find . -name .git -type d -maxdepth 3); do dir=\$(dirname \$d); (cd \$dir && git remote -v 2>/dev/null | grep cerebrus && git remote set-url origin \$(git remote get-url origin | sed 's/cerebrus/cerebro/g') && echo \"Updated: \$dir\"); done 2>/dev/null"
```

**Step 3: Update git remote on terminus (if any)**

```bash
cd ~/claudecluster && git remote -v | grep cerebrus && git remote set-url origin $(git remote get-url origin | sed 's/cerebrus/cerebro/g')
```

**Step 4: Verify push works**

```bash
ssh paschal@10.0.10.11 "cd /work/ai/sentinel && git push origin master"
```

---

### Task 15: Update memorybank database content

**Step 1: Find and update context entries referencing cerebrus**

```bash
ssh paschal@192.168.1.138 "sudo -u postgres psql -d cerebro -c \"SELECT key, value FROM timeline.context WHERE value::text ILIKE '%cerebrus%';\""
```

For each entry found, update:
```bash
ssh paschal@192.168.1.138 "sudo -u postgres psql -d cerebro -c \"UPDATE timeline.context SET value = REPLACE(value::text, 'cerebrus', 'cerebro')::jsonb WHERE value::text ILIKE '%cerebrus%';\""
```

**Step 2: Update project descriptions**

```bash
ssh paschal@192.168.1.138 "sudo -u postgres psql -d cerebro -c \"SELECT id, name, description FROM timeline.projects WHERE description ILIKE '%cerebrus%';\""
ssh paschal@192.168.1.138 "sudo -u postgres psql -d cerebro -c \"UPDATE timeline.projects SET description = REPLACE(description, 'cerebrus', 'cerebro') WHERE description ILIKE '%cerebrus%';\""
```

**Step 3: Update thought content (optional — historical references are fine to leave)**

Only update if there are thoughts that serve as active documentation:
```bash
ssh paschal@192.168.1.138 "sudo -u postgres psql -d cerebro -c \"SELECT COUNT(*) FROM timeline.thoughts WHERE content ILIKE '%cerebrus%';\""
```

If count is manageable, update; if it's many historical entries, leave them as-is.

**Step 4: Delete the rename tracking context**

```bash
# Via memorybank MCP tool:
mb_delete_context key="rename:cerebrus-to-cerebro"
```

**Step 5: Verify**

```bash
ssh paschal@192.168.1.138 "sudo -u postgres psql -d cerebro -c \"SELECT key FROM timeline.context WHERE value::text ILIKE '%cerebrus%';\""
```

Expected: No rows (or only historical entries that are acceptable).

---

### Task 16: Final verification checklist

Run each of these and confirm expected output:

**Database:**
```bash
ssh paschal@192.168.1.138 "sudo -u postgres psql -d cerebro -c 'SELECT COUNT(*) FROM timeline.threads;'"
# Expected: matches pre-migration count
```

**Memorybank MCP:**
```bash
# In Claude Code session, run: mb_whereami
# Expected: returns threads, context, reminders
```

**SSH from all machines:**
```bash
# Terminus → Anvil
ssh paschal@192.168.1.138 "hostname"
# Expected: anvil

# Forge → Anvil
ssh paschal@10.0.10.11 "ssh paschal@192.168.1.138 'hostname'"
# Expected: anvil

# Forge → GitHub
ssh paschal@10.0.10.11 "ssh -T git@github.com 2>&1"
# Expected: Hi dpaschal!
```

**Tailscale:**
```bash
ssh paschal@192.168.1.138 "tailscale status | head -5"
# Expected: Connected, 100.69.42.106
```

**Syncthing:**
```bash
curl -s http://192.168.1.138:8384/rest/system/status | python3 -c "import sys,json; print(json.load(sys.stdin).get('myID','FAIL')[:8])"
# Expected: 8-char device ID (not FAIL)
```

**Sentinel on forge (unaffected):**
```bash
ssh paschal@10.0.10.11 "sudo systemctl status sentinel | head -5"
# Expected: active (running)
```

**No remaining cerebrus references:**
```bash
grep -ri 'cerebrus' ~/.claude/CLAUDE.md 2>/dev/null
ssh paschal@10.0.10.11 "grep -ri 'cerebrus' /work/ai/ --include='*.go' --include='*.yaml' --include='*.yml' --include='*.json' --include='*.md' --include='*.sh' -l 2>/dev/null"
ssh paschal@192.168.1.138 "sudo -u postgres psql -c '\l' | grep cerebrus"
# Expected: all empty / no output
```

**KeePass has new credentials:**
```bash
ssh paschal@192.168.1.138 'printf "anvil2026\n" | keepassxc-cli show /home/paschal/Passwords/Passwords.kdbx "Infrastructure/Anvil/Cerebro DB" -s'
# Expected: shows cerebro username and new password
```

---

## Summary

| Task | Phase | Description | Depends On |
|------|-------|-------------|------------|
| 1 | Prepare | Generate cerebro password → KeePass | — |
| 2 | Prepare | pg_dumpall on anvil | — |
| 3 | Prepare | Borg backup anvil → forge | 2 |
| 4 | Prepare | Document anvil services | — |
| 5 | Ubuntu | Install Ubuntu Server 24.04 LTS | 3 |
| 6 | Ubuntu | Restore SSH host keys + base setup | 5 |
| 7 | Ubuntu | Install PostgreSQL 17, restore as cerebro | 1, 6 |
| 8 | Ubuntu | Install Node.js, Tailscale, Syncthing, etc. | 6 |
| 9 | Restore | Redeploy memorybank MCP server | 7, 8 |
| 10 | Forge | Regenerate forge SSH key | 6 |
| 11 | Forge | Bulk rename forge files | — |
| 12 | Terminus | Update Claude configs + memory | 1 |
| 13 | Terminus | Update claudecluster source, rebuild, deploy | 9, 12 |
| 14 | GitHub | Rename repo + update remotes | 10, 11, 13 |
| 15 | Cleanup | Update memorybank DB content | 9 |
| 16 | Verify | Final verification checklist | ALL |
