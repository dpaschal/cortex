# Cipher Telegram Bot — OpenClaw Feature Parity

**Date:** 2026-02-23
**Status:** Approved
**Thread:** cortex (#22)

## Problem

The Cortex Telegram bot (Cipher) was built as a minimal adapter (~78 lines) using `node-telegram-bot-api`. OpenClaw's Telegram functionality was archived into `src/openclaw/telegram/` but never wired into Cortex. The result: Cipher lacks slash commands, media handling, rich formatting, inline buttons, typing indicators, and session persistence — all features OpenClaw had.

## Scope

Port OpenClaw's key Telegram features into Cortex's native architecture. DM-only (no group chat), Claude-only (no multi-model), polling mode (no webhooks).

## Approach

**Replace** `node-telegram-bot-api` with **grammY** (already a dependency). Write Cortex-native handlers that replicate OpenClaw behaviors, using Cortex's tool system and shared memory instead of OpenClaw's internal config/routing/agent systems.

**Why not shim OpenClaw directly:** The OpenClaw telegram code imports from 15+ internal modules (`../config/config.js`, `../agents/agent-scope.js`, `../auto-reply/`, `../routing/`, `../pairing/`, etc.) that don't exist in Cortex. Shimming these would be fragile and create maintenance debt.

## Architecture

### Bot Lifecycle

```
MessagingPlugin.start()
  └─ Creates grammY Bot with:
     ├─ apiThrottler() middleware (rate limiting)
     ├─ sequentialize() middleware (per-chat ordering)
     ├─ bot.catch() error handler
     ├─ Slash command handlers (bot.command())
     ├─ Callback query handler (bot.on('callback_query'))
     ├─ Message handler (bot.on('message'))
     └─ bot.start() with long polling
```

### Message Flow

```
User Message (text/media/command)
    ↓
grammY middleware chain
    ↓
Command? → Direct tool execution (no LLM roundtrip)
Media?   → Download via ctx.getFile(), add to context
Text?    → Pass to ConversationHandler
    ↓
ConversationHandler.handleMessage()
    ├─ Load history from CSM (shared memory)
    ├─ Append user message
    ├─ Send typing indicator
    ├─ Call LLM with history + tools
    └─ Tool loop (up to 5 iterations)
    ↓
Format response (Markdown → Telegram HTML)
    ↓
Smart chunk (paragraph boundaries, 4096 limit)
    ↓
Send via grammY (with HTML parse_mode, fallback to plain text)
    ↓
Save updated history to CSM
```

## Features

### 1. Slash Commands

Registered via `bot.api.setMyCommands()` on startup. Each command maps directly to a Cortex tool — no LLM roundtrip needed.

| Command | Tool | Description |
|---------|------|-------------|
| `/status` | `cluster_status` | Cluster overview |
| `/health` | `cluster_health` | Detailed health report |
| `/nodes` | `list_nodes` | List cluster nodes |
| `/tasks` | `list_tasks` | List running tasks |
| `/sessions` | `list_sessions` | Active Claude sessions |
| `/new` | (internal) | Clear conversation history |
| `/help` | (internal) | List available commands |
| `/squelch` | `squelch_alerts` | Suppress alerts for N minutes |
| `/whereami` | `memory_whereami` | Timeline state |

Commands format their output as readable text, not raw JSON.

### 2. Rich Message Delivery

**Markdown → Telegram HTML:** Self-contained converter supporting:
- `**bold**` → `<b>bold</b>`
- `*italic*` → `<i>italic</i>`
- `` `code` `` → `<code>code</code>`
- `~~~code blocks~~~` → `<pre><code>...</code></pre>`
- `[links](url)` → `<a href="url">links</a>`
- `~~strikethrough~~` → `<s>strikethrough</s>`
- HTML entity escaping (`&`, `<`, `>`)

**Smart chunking:** Split long messages at paragraph boundaries (`\n\n`), then line boundaries (`\n`), then hard split at 4096.

**HTML parse error fallback:** If Telegram rejects the HTML, retry as plain text (pattern from OpenClaw `delivery.ts`).

**Typing indicator:** `sendChatAction('typing')` before LLM call, refreshed every 4 seconds during processing.

### 3. Media Handling

**Inbound (user → bot):**
- Photos: download largest resolution via `ctx.getFile()`
- Documents: download with original filename
- Voice/audio: download OGG/MP3
- Video: download MP4
- Store in temp dir (`/tmp/cortex-media/`), auto-cleanup after processing
- Pass file path + content type to LLM as context metadata

**Outbound (bot → user):**
- `sendPhoto()` for images
- `sendDocument()` for files
- `sendVoice()` for audio responses
- Caption support with 1024-char limit (overflow to follow-up message)

### 4. Inline Buttons

Support `InlineKeyboardMarkup` for:
- Command confirmations ("Are you sure you want to squelch alerts?")
- Tool result actions (e.g., "View details" button after `/tasks`)
- Callback query handler dispatches button presses

### 5. Session Persistence via CSM

New table in shared memory:

```sql
CREATE TABLE bot_conversations (
  chat_id TEXT PRIMARY KEY,
  history TEXT NOT NULL,        -- JSON array of ChatMessage[]
  updated_at TEXT DEFAULT (datetime('now'))
);
```

- **Load:** On each message, load history from CSM
- **Save:** After LLM response, save updated history back
- **Trim:** Keep last 20 messages, ensure no orphaned tool_result blocks
- **Clear:** `/new` command deletes the row
- **Failover:** History survives leader changes (Raft-replicated)

### 6. Error Handling

- grammY `bot.catch()` catches all middleware errors
- Polling errors logged but don't crash the bot
- Tool execution failures return error text to user (not stack traces)
- HTML formatting failures fall back to plain text
- Media download failures send text-only response with error note

## Files

| File | Action | Description |
|------|--------|-------------|
| `src/messaging/channels/telegram.ts` | Rewrite | grammY bot with middleware, commands, media, callbacks |
| `src/messaging/types.ts` | Extend | Add media fields to ChannelMessage |
| `src/messaging/conversation.ts` | Extend | CSM persistence, typing indicator support |
| `src/messaging/format.ts` | New | Markdown → Telegram HTML converter |
| `src/plugins/messaging/index.ts` | Extend | Pass CSM db, register commands, wire callbacks |
| `src/messaging/channels/__tests__/telegram.test.ts` | Rewrite | Tests for grammY adapter |
| `src/messaging/__tests__/format.test.ts` | New | Tests for Markdown→HTML converter |
| `src/messaging/__tests__/conversation.test.ts` | Extend | Tests for CSM persistence |
| `package.json` | Verify | Ensure grammy deps in dependencies (not just devDeps) |

## What We Don't Port

- Multi-provider/multi-model selection (Claude only)
- Group chat / topic / forum support (DM only)
- Sender pairing and authorization (single user)
- Cron / scheduled jobs
- Webhook mode (polling sufficient)
- Edit-in-place streaming (future enhancement)
- OpenClaw's markdown IR library (self-contained converter instead)
- Media group buffering / text fragment assembly (DM simplicity)
- Reaction tracking (future enhancement)

## Dependencies

Already in package.json from OpenClaw import:
- `grammy` ^4.x
- `@grammyjs/runner` ^4.x
- `@grammyjs/transformer-throttler` ^4.x

To remove:
- `node-telegram-bot-api` (replaced by grammY)
- `@types/node-telegram-bot-api`

## Testing Strategy

- Unit tests for Markdown→HTML converter (edge cases: nested formatting, code blocks, links)
- Unit tests for smart chunking (boundary detection, max length enforcement)
- Unit tests for command dispatch (each command returns expected format)
- Integration tests for ConversationHandler with CSM persistence (mock LLM provider)
- grammY adapter tests using grammY's test utilities
