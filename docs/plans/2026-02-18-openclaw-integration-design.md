# OpenClaw Integration into claudecluster

**Date:** 2026-02-18
**Status:** Approved
**Approach:** Fork-and-Absorb (Approach C)

## Context

OpenClaw is a personal AI agent CLI tool installed on terminus that provides:
- Multi-channel messaging gateway (Discord @DALEK, Telegram @Cipher1112222Bot)
- Persistent inbox/workspace for async inter-agent communication
- Model-agnostic LLM provider routing with fallback chains
- SKILL.md skill system (YAML frontmatter + natural language)
- Named agent identity ("Cipher")

OpenClaw was acquired by OpenAI. The user wants to absorb all OpenClaw features
into claudecluster (the existing P2P compute mesh), then uninstall OpenClaw.

Additionally, the `agent-mcp` bridge on forge (`/work/ai/agent-mcp/`) provides
MCP tools for Claude Code to communicate with OpenClaw. These tools will be
absorbed natively into claudecluster's MCP server.

## Decision Record

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Approach | Fork-and-Absorb | Fastest path to feature parity |
| Bot identity | Keep existing | Reuse @DALEK and @Cipher1112222Bot tokens |
| Gateway location | Every node (Raft leader runs it) | Automatic failover |
| LLM providers | Multi-provider with fallback | User wants provider independence |
| Skills | Support both MCP tools and SKILL.md | Preserve OpenClaw skill compatibility |
| Uninstall timing | After migration verified | Features must work before removal |

## Section 1: Fork Strategy & Source Integration

### Steps

1. Fix SSH access from gauntlet to terminus (add ed25519 key to authorized_keys)
2. Copy OpenClaw source from terminus (`/home/paschal/openclaw/`) into claudecluster
3. Check license file — if restrictive, pivot to rewrite (Approach A)
4. Strip to essentials:
   - **Keep:** Channel adapters, inbox/workspace ops, SKILL.md loader, provider routing, agent config
   - **Remove:** OpenClaw's own daemon management, clustering, CLI (claudecluster handles these)
5. Absorb agent-mcp bridge tools into claudecluster's MCP server

### Directory Structure

```
~/claudecluster/
  src/
    openclaw/                    # Forked OpenClaw core
      channels/                  # Discord, Telegram adapters
      inbox/                     # Inbox/outbox filesystem ops
      skills/                    # SKILL.md loader
      providers/                 # Multi-LLM provider routing
      config.ts                  # OpenClaw config parser
    messaging/
      gateway.ts                 # Raft-aware gateway controller
      bridge.ts                  # Absorbed from agent-mcp
    mcp/
      tools.ts                   # Extended with messaging tools
      messaging-tools.ts         # send_message, check_messages, etc.
```

## Section 2: Messaging Gateway & Raft Integration

### Constraint

Discord/Telegram bot tokens can only have ONE active connection at a time.
Two nodes connecting the same bot simultaneously causes disconnection.
Solution: Only the Raft leader runs the messaging gateway.

### Gateway Lifecycle

```
Node starts claudecluster
  → Raft election happens
  → If THIS node becomes leader:
      → Start MessagingGateway (connect Discord, Telegram bots)
      → Register gateway as a cluster session ("Cipher")
  → If THIS node loses leadership:
      → Gracefully disconnect bots
      → New leader picks up gateway within seconds
```

### Failover

Leader goes down → Raft election (~5-10s) → New leader starts gateway → Bots reconnect.

### Message Flow

```
Discord user sends message to @DALEK
  → MessagingGateway receives it (on leader node)
  → Routes to agent executor (Cipher agent identity)
  → Agent processes with configured LLM provider
  → Response sent back to Discord channel
  → Message logged to inbox (replicated to all nodes via gRPC context store)
```

### Config

```yaml
messaging:
  enabled: true
  agent: "Cipher"
  channels:
    discord:
      enabled: true
      token: ${DISCORD_BOT_TOKEN}
      guild: "1282092123948191804"
    telegram:
      enabled: true
      token: ${TELEGRAM_BOT_TOKEN}
  inbox:
    replicateToCluster: true
    archiveAfterDays: 30
```

## Section 3: Multi-Provider LLM Routing

### Provider Interface

```typescript
interface LLMProvider {
  chat(messages: Message[], options?: ChatOptions): Promise<ChatResponse>;
  stream(messages: Message[], options?: ChatOptions): AsyncIterable<StreamChunk>;
  models(): Promise<string[]>;
}
```

### Implementations

| Provider | SDK | Use Case |
|----------|-----|----------|
| Anthropic | `@anthropic-ai/sdk` | Primary (existing subagent logic) |
| OpenAI | `openai` | Fallback |
| Google | `@google/generative-ai` | Fallback |
| Ollama | HTTP client | Local fallback (no API key needed) |

### Router Logic

1. Try primary provider
2. On failure (rate limit, downtime), exponential backoff to next in chain
3. Per-channel override supported (e.g., Discord always uses Claude)

### Config

```yaml
providers:
  primary: anthropic
  fallback:
    - openai
    - ollama
  anthropic:
    model: claude-sonnet-4-6
    apiKey: ${ANTHROPIC_API_KEY}
  openai:
    model: gpt-4o
    apiKey: ${OPENAI_API_KEY}
  ollama:
    model: llama3
    baseUrl: http://localhost:11434
```

### Impact on Existing Code

The existing `subagent-executor.ts` gets refactored to use the provider interface
instead of directly importing `@anthropic-ai/sdk`. All existing MCP subagent tools
continue working through the router.

## Section 4: SKILL.md Support & MCP Tool Expansion

### SKILL.md Loader

- Reads SKILL.md files from configurable directories
- Hot-reloads on file change (fs.watch)
- Each skill exposed as an MCP tool
- Skills invocable by the messaging gateway agent (Cipher)

### New MCP Tools

| Tool | Source | Description |
|------|--------|-------------|
| `send_message` | agent-mcp | Send message to a channel |
| `check_messages` | agent-mcp | Check inbox for new messages |
| `list_conversations` | agent-mcp | List conversation IDs |
| `get_conversation` | agent-mcp | Read a specific conversation |
| `gateway_status` | New | Messaging gateway status |
| `list_skills` | New | List loaded SKILL.md skills |
| `invoke_skill` | New | Execute a skill by name |

### Config

```yaml
skills:
  directories:
    - ~/.openclaw/skills/
    - ~/claudecluster/skills/
  hotReload: true
```

## Section 5: Migration Plan

### Phase 1 — Prep

1. Fix SSH from gauntlet → terminus
2. Copy OpenClaw source to claudecluster repo
3. Check license file
4. Copy bot tokens from OpenClaw config to KeePass vault
5. Copy existing SKILL.md files and inbox data

### Phase 2 — Build

1. Integrate forked OpenClaw channel adapters
2. Build Raft-aware messaging gateway
3. Add multi-provider routing
4. Absorb agent-mcp MCP tools
5. Add SKILL.md loader

### Phase 3 — Verify

1. Deploy updated claudecluster to gauntlet (test node)
2. Test Discord bot connects and responds
3. Test Telegram bot connects and responds
4. Test Raft failover (stop leader, verify bot reconnects)
5. Test inbox sync across nodes
6. Test multi-provider fallback

### Phase 4 — Cutover

1. Stop OpenClaw gateway on terminus: `systemctl --user stop openclaw-gateway`
2. Deploy updated claudecluster to all nodes
3. Verify messaging works from forge/gauntlet
4. Uninstall OpenClaw from terminus
5. Remove agent-mcp bridge from forge
6. Update cerebrus context entries

## Risks

| Risk | Mitigation |
|------|------------|
| Restrictive OpenClaw license | Check license first; pivot to Approach A (rewrite) if needed |
| OpenClaw source is opaque/messy | Strip aggressively; only keep channel adapters and core features |
| Bot token management | Store in KeePass vault; inject via env vars at runtime |
| Raft not fully tested | Test leader election and failover before enabling messaging gateway |
| terminus SSH access | Fix key auth as Phase 1, step 1 |
