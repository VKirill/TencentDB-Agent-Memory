# Claude Code Integration

This directory ships everything needed to wire `@vkirill/tencentdb-agent-memory`
into [Claude Code](https://docs.claude.com/claude-code) so memory accumulates
automatically per-project.

## What you get

After installing once globally, every Claude Code session in any project will:

1. **`SessionStart`** — recall relevant prior turns from the project's memory
   and inject them into the system context.
2. **`UserPromptSubmit`** — search memory for context related to your current
   prompt and prepend it.
3. **`PostToolUse(Edit|Write|MultiEdit)`** — capture each code edit as a
   turn in the project's memory.
4. **`Stop`** — capture a session-end summary turn.

Memory lives at `<your-project>/.claude/memory/` (project-local, gitignorable).
Each project gets its own memory store; nothing crosses project boundaries.

## Install (one-time, machine-wide)

```bash
# 1. Install the bin globally (requires Node >= 22.16, jq, npm/pnpm)
npm i -g github:VKirill/TencentDB-Agent-Memory

# 2. Run the global installer
bash "$(npm root -g)/@vkirill/tencentdb-agent-memory/claude-code-integration/install.sh"

# That's it. Start a new Claude Code session in any project and hooks fire.
```

What `install.sh` does:
- Captures the absolute path of `claude-mem` (so hooks find it even when
  Claude Code spawns a non-interactive shell)
- Copies three wrapper scripts to `~/.claude/hooks/claude-mem/`
- Merges 4 hook entries into `~/.claude/settings.json` (deep-merge via `jq`;
  preserves any unrelated keys you already have)
- Idempotent: re-run after `npm update -g` to refresh paths

## Per-project memory (zero setup)

You **do not** need to run anything in each project. The hooks auto-init the
memory directory on first use:

```bash
cd ~/some-fresh-project
claude
# In session 1: hooks fire → .claude/memory/{config.json,.gitignore} created.
# In session 2+: memory accumulates; recall finds prior turns by keyword.
```

If you want to inspect or seed memory manually:

```bash
cd ~/some-project
claude-mem init                                       # explicit init (idempotent)
echo '{"user":"hi","assistant":"hello"}' | claude-mem capture
claude-mem recall --query hi --limit 5
claude-mem stats
```

## Required env vars (for v0.3 vector recall — optional in v0.2)

```bash
export OPENROUTER_API_KEY=sk-or-v1-...
export VOYAGE_API_KEY=pa-...
```

In v0.2, recall is **keyword-only** — no API keys needed. v0.3 will add vector
recall via `TdaiCore.handleBeforeRecall` which calls OpenRouter (Hy3) for L1
extraction and Voyage for embeddings.

## Verify the install

```bash
cd ~/any-project
claude-mem stats
# Should print: L0 turns: 0 (or N after some sessions), file paths, etc.

# After a Claude Code session:
cat ~/.claude/memory/.../memory.log   # internal log
ls .claude/memory/conversations/      # date-bucketed JSONL files
```

## Disable / uninstall

```bash
bash "$(npm root -g)/@vkirill/tencentdb-agent-memory/claude-code-integration/uninstall.sh"
```

Uninstall removes:
- Hook entries from `~/.claude/settings.json` (matched by `/claude-mem/` in
  command string)
- Wrapper scripts from `~/.claude/hooks/claude-mem/`
- The `_claude_mem_installed` marker

Uninstall does **NOT** remove:
- Per-project `.claude/memory/` directories (your data — wipe manually if
  desired with `rm -rf <project>/.claude/memory`)
- The `claude-mem` bin itself (use `npm uninstall -g @vkirill/tencentdb-agent-memory`)

## Coexistence with claude-mem v12.7.5

If `install.sh` detects existing `"claude-mem"` references in your settings
without the `_claude_mem_installed` marker, it exits 1 with a warning. To
force both to run in parallel:

```bash
bash install.sh --allow-coexist
```

The two systems use different state dirs (`<project>/.claude/memory/` vs
`~/.claude-mem/`) so they don't collide on disk.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Nothing happens during a session | hooks not installed or wrong path | `bash install.sh` again; check `cat ~/.claude/settings.json \| jq .hooks` |
| `claude-mem: command not found` in hooks | `claude-mem` not on Claude Code's PATH | `install.sh` bakes the absolute path; re-run to refresh |
| Tests show captures in tmp dir but not in Claude Code | hooks point at wrong `claude-mem` after `npm update -g` | re-run `install.sh` |
| `jq: command not found` | jq missing | `sudo apt install jq` or `brew install jq` |
| Memory file exists but `recall` returns nothing | recall is keyword-only in v0.2; query must match | try a substring of an exact phrase from your session |

For deeper debugging:

```bash
cat <project>/.claude/memory/memory.log  # contains every hook invocation
claude --debug                            # Claude Code dumps hook stdout/stderr
```

## v0.2 known limitations

- **Keyword recall only** — no semantic/vector search yet (v0.3).
- **No background pipeline** — L1/L2/L3 LLM extraction does not run until you
  manually trigger it or v0.3 wires the scheduler.
- **No Hy3 smoke-test gate** — deferred to v0.3 (v0.2 CLI never invokes LLM,
  so the smoke is moot until vector recall lands).

See [docs/plans/v0.2-claude-code-integration/SPEC.md](../docs/plans/v0.2-claude-code-integration/SPEC.md)
for the full design.
