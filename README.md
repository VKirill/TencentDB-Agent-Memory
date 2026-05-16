<div align="center">

<img src="https://github.com/VKirill/codex-starter-kit/raw/main/assets/avatar-round.png" width="120" alt="VKirill — author avatar" />

# TencentDB Memory for Claude Code

**Persistent per-project memory for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) via an MCP server (4 tools) + 4-layer L0 / L1 / L2 / L3 extraction pipeline.**
**English-localized coder-focused fork** of [Tencent/TencentDB-Agent-Memory](https://github.com/Tencent/TencentDB-Agent-Memory) — vector recall (Voyage embeddings), SessionStart auto-injection, PM2 scheduler, orchestrator sync.

by **[@VKirill](https://github.com/VKirill)** · 📢 [Telegram channel: @pomogay_marketing](https://t.me/pomogay_marketing)

🌐 **English** · [Русский](./README.ru.md)

[![npm](https://img.shields.io/badge/npm-v0.4.2-blue)](https://github.com/VKirill/TencentDB-Memory-Claude-Code/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.16-brightgreen)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-server-orange)](https://modelcontextprotocol.io)
[![Tests](https://img.shields.io/badge/tests-91%20passing-success)](#status)

**Keywords**: claude code memory, claude code mcp server, claude code persistent context, mcp memory server, ai agent memory, persona, vector search, voyage embeddings, openrouter, sqlite-vec, l0 l1 l2 l3 extraction

</div>

---

## What this does

Claude Code is great at the task in front of it, but it has no memory between
sessions. Every new conversation starts blank: you re-explain your stack, your
infra, your conventions, what you decided last week.

This package fixes that. While you work, it:

1. **Records** every conversation turn to a local JSONL file (L0)
2. **Extracts** durable facts ("Kirill uses Node 22, deploys via PM2") with an LLM (L1)
3. **Groups** related facts into thematic scene files (`scene_blocks/server-infrastructure.md`) (L2)
4. **Distills** an actionable coder profile (`persona.md`) — your stack, infra,
   workflow conventions, hard rules, active projects (L3)

On every new Claude Code session, the SessionStart hook prepends your persona
and the scene index to Claude's system context. The MCP server exposes 4 tools
(`memory_search`, `conversation_search`, `recall_persona`, `recall_scenes`)
so Claude can look up specifics on demand.

The result: Claude in a fresh session already knows you, your stack, and your
recent work — without you having to re-explain it.

---

## Quick start (5 commands)

Prerequisites: **Node ≥ 22.16**, Claude Code installed, an OpenRouter API key
and a Voyage AI API key. See [INSTALL.md](./INSTALL.md) for full details.

```bash
# 1. Install
npm i -g github:VKirill/TencentDB-Memory-Claude-Code#v0.4.2

# 2. Put your keys in ~/.claude/claude-mem.env
cat > ~/.claude/claude-mem.env <<'EOF'
OPENROUTER_API_KEY=sk-or-v1-...
VOYAGE_API_KEY=pa-...
EOF
chmod 600 ~/.claude/claude-mem.env

# 3. Wire Claude Code hooks + MCP server (idempotent — safe to re-run)
bash $(npm root -g)/@vkirill/tencentdb-memory-claude-code/claude-code-integration/install.sh

# 4. (Optional) Pre-register projects to the allowlist
#    Starting Claude Code in any project auto-adds it on SessionStart (v0.4.1+).
#    Skip unless you want to populate the allowlist before first session.
# echo "$HOME/your-project" >> ~/.claude/claude-mem-projects.txt

# 5. (Optional) Start the PM2 daemon that runs `extract` every 30 minutes
pm2 start ~/.claude/hooks/claude-mem/scheduler.cjs --name claude-mem-scheduler
pm2 save
```

Verify:

```bash
claude-mem --version    # → 0.4.2
claude-mem stats        # → memory state for the current project
```

Then start a new Claude Code session in any project from the allowlist. Within
a few minutes / extractions, you'll see `<persona-context>` + `<scene-index>`
in the session-start context, and Claude will be able to call the MCP tools.

---

## Architecture

```
                       ┌──────────────────────────────────────┐
                       │  Claude Code session                 │
                       │                                       │
                       │  ┌──────────┐    ┌────────────────┐  │
   you talk ───────►   │  │ User     │    │ MCP tools      │  │
   to Claude           │  │ prompt   │    │ (4 callable    │◄─┼──── memory_search
                       │  └──────────┘    │  on demand)    │  │     conversation_search
                       │       │          └────────────────┘  │     recall_persona
                       │       ▼                              │     recall_scenes
                       │  ┌──────────┐                        │
                       │  │ Assistant│                        │
                       │  │ response │                        │
                       │  └──────────┘                        │
                       └──────────┼───────────────────────────┘
                                  │
                                  ▼
                       Stop hook → claude-mem capture
                                  │
                                  ▼
    ┌──────────────────────────────────────────────────────────────────┐
    │  <project>/.claude/memory/                                       │
    │                                                                  │
    │  conversations/YYYY-MM-DD.jsonl   ← L0 raw turns                 │
    │  vectors.db                       ← L1 facts (SQLite + vec)      │
    │  scene_blocks/*.md                ← L2 thematic scenes           │
    │  persona.md                       ← L3 coder profile             │
    │  .metadata/recall_checkpoint.json ← cursors + state              │
    └─────────────────▲────────────────────────────────────────────────┘
                      │
                      │  PM2 scheduler (every 30 min) OR manual:
                      │      claude-mem extract
                      │
                      └─────────  L0 → L1 → L2 → L3 pipeline
```

### Layer-by-layer

| Layer | What it stores | When it runs | LLM cost |
|---|---|---|---|
| **L0** | Raw `{user, assistant}` turns from every conversation | After every assistant response (Stop hook) | $0 |
| **L1** | Structured facts ("Kirill uses TS strict mode", "deploys via PM2") with type (`persona`/`episodic`/`instruction`) and priority | PM2 scheduler tick if new L0 turns exist; or `claude-mem extract` manually | ~$0.01-0.05 / tick (Hy3) or ~$0.10-0.30 (Sonnet 4.6) |
| **L2** | Thematic scene Markdown files (e.g. `server-infrastructure-and-deployment.md`), capacity-capped at 15, auto-merged when full | Same `extract` run, after L1 produces new facts | ~$0.01-0.02 / tick |
| **L3** | `persona.md` — 8-section coder profile (Stack / Infrastructure / Workflow conventions / Hard rules / Active projects / Communication / Decision patterns / Open) | When `PersonaTrigger` fires (cold start, every N memories, recovery, explicit request) | ~$0.05-0.15 / regeneration |

Total **typical day budget**: ~$0.50-2 of LLM tokens on active days; near-zero on quiet ones.

### Per-project isolation

Every project has its own `.claude/memory/` directory. The persona for
`~/apps/your-api/` is independent of `~/apps/your-frontend/`. Same identity
facts (your name, server IP, communication style) will be re-derived in each
project — by design, to keep contexts cleanly separated.

---

## MCP tools (v0.4.2)

Once the install script registers the MCP server in `~/.claude/settings.json`,
Claude Code can call these tools mid-conversation:

| Tool | What it does |
|---|---|
| `mcp__tencentdb-memory__memory_search` | Search L1 facts by semantic similarity (Voyage vector) or keyword fallback. Returns top-K matches. |
| `mcp__tencentdb-memory__conversation_search` | Keyword search over raw L0 turns. Use to find verbatim past exchanges. |
| `mcp__tencentdb-memory__recall_persona` | Return the full current persona.md content. |
| `mcp__tencentdb-memory__recall_scenes` | List all scene blocks with filenames + summaries. |

The `MEMORY_TOOLS_GUIDE` (injected into Claude's system context on every
session) instructs the agent to call these tools at most 3 times per turn,
and only when the prepended context lacks the answer.

---

## Configuration

Each project's `.claude/memory/config.json` controls behavior:

```json
{
  "extraction": {
    "enabled": true,
    "model": "tencent/hy3-preview"
  },
  "persona": {
    "triggerEveryN": 50,
    "maxScenes": 20,
    "model": "tencent/hy3-preview"
  },
  "embedding": {
    "model": "voyage-3-lite",
    "recallTimeoutMs": 1500
  },
  "recall": {
    "topK": 5,
    "scoreThreshold": 0.3
  }
}
```

### Switching the LLM provider

Default model is `tencent/hy3-preview` via OpenRouter (cheap, fast). If you
observe thin extraction (L1 produces 0 facts on full conversations), switch
to Sonnet 4.6 for the extraction stage:

```json
"extraction": { "model": "anthropic/claude-sonnet-4.6" }
```

The `persona.model` can be set independently for L3 if you want a different
model for L1 vs L3 work.

### Disabling auto-capture

If you want to record conversations only manually:

```json
"capture": { "enabled": false }
```

---

## Manual commands

```bash
claude-mem init                       # bootstrap .claude/memory/ in cwd
claude-mem capture                    # read {user, assistant} JSON on stdin, write to L0
claude-mem recall --query "rate limit" --limit 5
                                       # output persona + scene index + L1/L0 matches
claude-mem recall --no-persona --no-scenes --query "..."
                                       # match-only output (v0.3.4 shape)
claude-mem extract                    # run L1 → L2 → L3 pipeline once
claude-mem extract --dry-run          # enumerate sessions without LLM calls
claude-mem extract --max-sessions 1   # process at most N sessions this run
claude-mem stats                      # database statistics
claude-mem mcp serve                  # MCP server on stdio (Claude Code calls this)
```

---

## Orchestrator integration (optional)

If you use a task tracker that supports `task update <id> --status done`,
set the env var:

```bash
export CLAUDE_MEM_TASK_CAPTURE=1
```

After each completed task, the orchestrator will spawn `claude-mem capture`
with a synthetic turn describing what was done. Future sessions can then
recall `TASK-NNN` and see the completion summary.

---

## What was kept / changed from upstream Tencent

### Kept
- Four-layer architecture (L0 raw / L1 facts / L2 scenes / L3 persona)
- SQLite + sqlite-vec for embeddings + FTS5
- jieba CJK tokenizer (for Chinese-language search)
- Prompt-injection sanitizer
- Per-session checkpoint state
- Scene capacity management with `[DELETED]` soft-delete

### Changed for this fork
- **All LLM prompts translated to English** (was Chinese in upstream)
- **L3 persona rewritten as coder profile** (Stack / Infra / Workflow / Hard rules — was Archetype / Texture of Life / Anthropological)
- **CLI added** (upstream was OpenClaw plugin-only); subcommands: `init`, `capture`, `recall`, `extract`, `stats`, `mcp serve`
- **MCP server added** (4 tools)
- **PM2 scheduler added** for batch extract
- **SessionStart hook auto-injection** (`<persona-context>` / `<scene-index>`)
- **CheckpointManager L2 cursor persistence** (upstream re-scanned every run)

### Not ported (out of scope)
- Tencent Vector DB cloud sync — this fork is local-first
- OpenClaw plugin runtime — replaced by standalone CLI

---

## Troubleshooting

**`claude-mem extract` says "OPENROUTER_API_KEY not set"**

Source the env file in your shell, or check `~/.claude/claude-mem.env` exists
with mode 600 and contains the key. The CLI auto-loads `~/.claude/claude-mem.env`
in addition to your shell env.

**Persona.md never updates**

Check the trigger threshold: `cat .claude/memory/.metadata/recall_checkpoint.json | grep memories_since_last_persona`.
If it's below `cfg.persona.triggerEveryN` (default 50), L3 won't fire yet.
Force regeneration by deleting `persona.md` and re-running extract.

**MCP tools not visible in Claude Code**

Check `~/.claude/settings.json` contains `mcpServers.claude-mem` with the
right command path. Re-run `install.sh` to repair, then restart Claude Code.

**PM2 scheduler doesn't run extract on any project**

Verify `~/.claude/claude-mem-projects.txt` contains absolute paths to your
projects (one per line). Empty file = nothing to do.

**Extract takes very long / times out**

Check the PM2 kill timer in `scheduler.cjs` (`DEFAULT_EXTRACT_TIMEOUT_MS`,
currently 15 minutes). Lower it if extract is fast; raise it if a single
project has 50+ sessions and L3 needs more time.

---

## Status

| | |
|---|---|
| Version | 0.4.0 |
| Tests | 91 passing |
| Stack | Node 22 · TypeScript · SQLite · Voyage embeddings · OpenRouter |
| License | MIT (see [LICENSE](./LICENSE) and [NOTICE.md](./NOTICE.md) for upstream attribution) |
| Maintainer | [@VKirill](https://github.com/VKirill) |
| Upstream | [Tencent/TencentDB-Agent-Memory](https://github.com/Tencent/TencentDB-Agent-Memory) |

---

## Detailed install

See **[INSTALL.md](./INSTALL.md)** for full step-by-step setup including
prerequisites, API key acquisition, PM2 daemon setup, and verification.

## Changelog

See **[CHANGELOG.md](./CHANGELOG.md)** for the full release history.

## Contributing

Bug reports + PRs welcome at https://github.com/VKirill/TencentDB-Memory-Claude-Code.
Bigger architectural changes — please open an issue first to discuss.
