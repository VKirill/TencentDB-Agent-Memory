# @vkirill/tencentdb-agent-memory

> Four-layer local memory (L0 → L1 → L2 → L3) for Claude Code and other agents.
> Fork of [Tencent/TencentDB-Agent-Memory](https://github.com/Tencent/TencentDB-Agent-Memory) decoupled from the OpenClaw / Hermes runtime.
> SQLite vector search + OpenAI-compatible LLM/embedding providers.

**Status:** v0.1 — standalone CLI (no Claude Code hooks yet). v0.2 adds hook templates + install.sh. v0.3 adds migration + npm publish.

## Install

```bash
# v0.1: install from GitHub URL (no npm publish yet)
npm i -g github:VKirill/TencentDB-Agent-Memory
```

Requires Node ≥ 22.16.

## Quickstart

```bash
cd <your-project>
claude-mem init                           # creates .claude/memory/ + config.json
echo '{"user":"hi","assistant":"hello"}' | claude-mem capture
claude-mem recall --query "hi" --limit 5
claude-mem stats
```

State lives in `<project>/.claude/memory/`. Add this path to `.gitignore` (the `init` command does this for you).

## Configuration

`init` writes `.claude/memory/config.json`. API keys come from env, never from the file:

```bash
export OPENROUTER_API_KEY=sk-or-v1-...
export VOYAGE_API_KEY=pa-...
```

Defaults:
- LLM: OpenRouter `tencent/hy3-preview`
- Embeddings: Voyage AI `voyage-3-lite` (512-d)
- Vector store: SQLite + `sqlite-vec`

## CLI commands

| Command | What it does |
|---|---|
| `claude-mem init` | Bootstrap `.claude/memory/` and write default config |
| `claude-mem capture` | Read `{user, assistant}` JSON on stdin, write L0 turn |
| `claude-mem recall --query <q> --limit <N>` | Vector + FTS search over memory; prints results to stdout |
| `claude-mem stats` | DB row counts, last pipeline run, embedding usage |

All commands exit `0` even on backend failure (hook-friendly). Errors append to `.claude/memory/memory.log`.

## Architecture

```
┌─────────────────┐
│ CLI (Commander) │  init / capture / recall / stats
└────────┬────────┘
         │
┌────────▼─────────────────────────┐
│ StandaloneHostAdapter            │  Wraps TdaiCore for any host
│ + StandaloneLLMRunner            │
└────────┬─────────────────────────┘
         │
┌────────▼─────────────────────────┐
│ TdaiCore (host-neutral)          │
│ - L0: turn capture               │
│ - L1: structured memory extract  │  via Hy3
│ - L2: scene block extraction     │  via Hy3
│ - L3: persona generation         │  via Hy3
│ - Recall: hybrid vector + FTS    │
└────────┬─────────────────────────┘
         │
┌────────▼──────────────────────────┐
│ SQLite (better-sqlite3 + vec)     │
│ + Voyage embeddings (OAI-compat)  │
└───────────────────────────────────┘
```

## License & attribution

MIT. Forked from `Tencent/TencentDB-Agent-Memory@v0.3.4`. See [NOTICE.md](./NOTICE.md) for upstream credit.

## Roadmap

- **v0.2** — Claude Code hooks (`SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`) + `install.sh`
- **v0.3** — migration from `claude-mem v12.7.5`, MCP server, npm publish

## Contributing

This is a personal fork. Issues + PRs welcome but no SLA.
