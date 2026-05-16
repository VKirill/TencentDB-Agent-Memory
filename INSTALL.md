# Install — TencentDB Memory for Claude Code

Step-by-step install for any user adding persistent memory to their Claude Code setup.
Read [README.md](./README.md) first if you want the conceptual overview; this doc
is operational: run these commands, get a working install.

---

## Prerequisites

### Required

- **Node.js ≥ 22.16** — `node --version` must report `v22.16.x` or newer.
  Older versions miss the built-in `node --test` runner the scheduler uses.
  Install via `nvm install 22` or your distro's package manager.

- **npm ≥ 10.9** — comes with Node 22.

- **Claude Code installed** — the `claude` binary must be in `$PATH`. See
  [docs.anthropic.com/claude-code](https://docs.anthropic.com/en/docs/claude-code)
  if you haven't installed it yet.

### Two API keys you need to obtain

1. **OpenRouter API key** — used by L1 / L2 / L3 LLM extraction.
   - Sign up: https://openrouter.ai/
   - Create key: https://openrouter.ai/keys
   - Format: starts with `sk-or-v1-...`
   - Cost: pay-per-use; expect ~$0.50-2/day on active days with the default Hy3 model

2. **Voyage AI API key** — used for semantic vector recall of L1 facts.
   - Sign up: https://www.voyageai.com/
   - Create key: dashboard → API keys
   - Format: starts with `pa-...`
   - Cost: free tier covers ~1M tokens/month — plenty for personal use

### Optional but strongly recommended

- **PM2** — for the auto-extract daemon. `npm i -g pm2`. Without PM2 you'd
  have to run `claude-mem extract` manually in each project.

---

## Step 1 — Install the package

```bash
npm i -g github:VKirill/TencentDB-Memory-Claude-Code#v0.4.0
```

This pulls the v0.4.0 tag from GitHub and installs the `claude-mem` binary
to your global npm bin directory (`$(npm root -g)/.bin/claude-mem`).

Verify:

```bash
claude-mem --version
# → 0.4.0
```

If the command isn't found, ensure your npm global bin directory is on your
`$PATH`. Check with `npm root -g`. Add to your shell rc if needed:

```bash
# ~/.bashrc or ~/.zshrc
export PATH="$(npm root -g | sed s/lib.node_modules/bin/):$PATH"
```

---

## Step 2 — Store your API keys

Create `~/.claude/claude-mem.env` with mode 600 (owner-only readable):

```bash
mkdir -p ~/.claude
cat > ~/.claude/claude-mem.env <<'EOF'
OPENROUTER_API_KEY=sk-or-v1-PASTE_YOUR_KEY_HERE
VOYAGE_API_KEY=pa-PASTE_YOUR_KEY_HERE
EOF
chmod 600 ~/.claude/claude-mem.env
```

**Why a file and not just `export`**: Claude Code hooks spawn subprocesses
that don't always inherit your shell env. Wrappers and CLI both auto-load
this file. Mode 600 keeps the keys out of shared / world-readable view.

Verify (without printing the key):

```bash
test -f ~/.claude/claude-mem.env && stat -c%a ~/.claude/claude-mem.env
# → 600
```

---

## Step 3 — Wire Claude Code hooks + MCP server

The installer copies hook wrappers into `~/.claude/hooks/claude-mem/` and
registers the MCP server in `~/.claude/settings.json`. Idempotent — safe to
re-run after upgrades.

```bash
bash $(npm root -g)/@vkirill/tencentdb-memory-claude-code/claude-code-integration/install.sh
```

You should see output like:

```
[install] using claude-mem bin: /home/you/.npm-global/bin/claude-mem
[install] copied scheduler.cjs (0755)
[install] copied recall-wrapper.sh (0755)
[install] copied stop-wrapper.sh (0755)
[install] env file ~/.claude/claude-mem.env: already exists, skipping (mode 600)
[install] claude-mem-projects.txt: created at ~/.claude/claude-mem-projects.txt
[install] settings.json: registered claude-mem MCP server
[install] settings.json: hooks (SessionStart, UserPromptSubmit, Stop, PostToolUse) wired
[install] done.
```

Verify the MCP server entry in your settings:

```bash
python3 -c "import json; print(json.load(open('$HOME/.claude/settings.json'))['mcpServers'].get('claude-mem','NOT REGISTERED'))"
# → {'command': '/home/you/.npm-global/bin/claude-mem', 'args': ['mcp', 'serve']}
```

---

## Step 4 — Add projects to the auto-extract allowlist

The PM2 scheduler reads `~/.claude/claude-mem-projects.txt` every tick to know
which projects to process. **Without this list, nothing happens automatically.**

```bash
# Add your projects (one absolute path per line)
echo "$HOME/apps/your-project" >> ~/.claude/claude-mem-projects.txt
echo "$HOME/code/another-project" >> ~/.claude/claude-mem-projects.txt
```

You can edit this file at any time — the scheduler hot-reloads every tick (no
restart required).

Each path you add will get its own `.claude/memory/` directory on first hook
invocation (auto-init).

---

## Step 5 — Start the PM2 scheduler

```bash
pm2 start ~/.claude/hooks/claude-mem/scheduler.cjs --name claude-mem-scheduler
pm2 save                 # persist across reboots
pm2 startup              # follow the printed instructions to enable systemd startup
```

The scheduler runs `claude-mem extract` in each allowlisted project every
30 minutes (configurable via `CLAUDE_MEM_INTERVAL_MIN`).

Verify it's running:

```bash
pm2 status
# → claude-mem-scheduler should show "online"

pm2 logs claude-mem-scheduler --lines 20
# → should show "tick: 0 project(s) to process" (if allowlist empty) or
#   "extract: project=..." entries
```

---

## Step 6 — Smoke-test with a real Claude Code session

```bash
cd ~/apps/your-project    # or any allowlisted project
claude
```

In the first message, ask Claude to recall something specific:

> «Search your memory for what we discussed about deployment yesterday»

If everything is wired:
- Claude will see prepended context including any `<persona-context>` (your
  persona.md if it's been generated) and `<scene-index>` (scene blocks list).
- Claude can call `mcp__claude-mem__memory_search` to find specific facts.
- Stop hook saves your conversation turns to L0.

On the **first session** in a fresh project, you won't see persona/scenes
yet — they'll appear after PM2 has run extract at least once on that project
(or run `claude-mem extract` manually to force it).

---

## Step 7 — (Optional) Orchestrator integration

If you use a task tracker that exposes `task update <id> --status done`,
enable bidirectional sync:

```bash
echo 'export CLAUDE_MEM_TASK_CAPTURE=1' >> ~/.bashrc  # or ~/.zshrc
source ~/.bashrc
```

Each completed task now writes a synthetic turn to the project's memory,
making it recallable later via `claude-mem recall "TASK-NNN"`.

---

## Upgrade workflow

```bash
# 1. Pull the new version
npm i -g github:VKirill/TencentDB-Memory-Claude-Code#vX.Y.Z

# 2. Re-run installer (idempotent — updates wrappers + scheduler)
bash $(npm root -g)/@vkirill/tencentdb-memory-claude-code/claude-code-integration/install.sh

# 3. Restart PM2 scheduler to pick up the new scheduler.cjs
pm2 restart claude-mem-scheduler

# 4. Restart Claude Code so it re-reads settings.json for MCP changes
```

The installer never overwrites your `claude-mem.env` or `claude-mem-projects.txt`.

---

## Uninstall

```bash
# 1. Stop + remove scheduler
pm2 delete claude-mem-scheduler
pm2 save

# 2. Remove hook wrappers
rm -rf ~/.claude/hooks/claude-mem/

# 3. Remove MCP + hook entries from settings.json (manual edit or use jq)
#    Look for "claude-mem" in mcpServers and any claude-mem-* paths in hooks arrays

# 4. Uninstall the npm package
npm uninstall -g @vkirill/tencentdb-memory-claude-code

# 5. (Optional) Remove per-project memory dirs
#    Don't do this casually — each .claude/memory/ contains your conversation history
#    find ~/apps -type d -name memory -path '*/.claude/*' -exec rm -rf {} +
```

Your `claude-mem.env` and `claude-mem-projects.txt` are left in place — remove
manually if you want a fully clean uninstall.

---

## Troubleshooting

### "command not found: claude-mem"

```bash
# Find global npm bin
npm root -g
# Look in <result>/.bin/claude-mem — does it exist?

# If yes, ensure parent dir is on PATH:
echo $PATH | tr ':' '\n' | grep "$(npm root -g | sed s/lib.node_modules/bin/)"

# If empty: add to your shell rc:
export PATH="$(npm root -g | sed s/lib.node_modules/bin/):$PATH"
```

### "OPENROUTER_API_KEY not set" when running extract from terminal

The CLI auto-loads `~/.claude/claude-mem.env` but only if the file exists and
is readable by the current user.

```bash
ls -la ~/.claude/claude-mem.env
# → must show -rw------- (mode 600) and your user as owner
```

If you symlinked `~/.claude/` to a different volume, ensure the env file lives
at the resolved (final) path.

### Persona / scene_blocks never appear

```bash
# Force a manual extract:
cd /your/project
claude-mem extract

# Inspect what happened:
cat .claude/memory/scheduler.log 2>/dev/null   # if extracted via PM2
tail -50 .claude/memory/memory.log             # CLI invocation log
```

If `l0_processed=0` in the extract summary, no new conversation turns were
captured — check that the Stop hook is wired (`grep -A3 "Stop" ~/.claude/settings.json`).

### MCP tools not callable in Claude Code

```bash
# 1. Verify registration
python3 -c "import json; print(json.load(open('$HOME/.claude/settings.json')).get('mcpServers', {}))"
# Should show "claude-mem" entry with command path

# 2. Test the server boots manually
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}},"id":1}' \
  '{"jsonrpc":"2.0","method":"tools/list","params":{},"id":2}' \
  | timeout 5 claude-mem mcp serve 2>/dev/null

# Should print initialize + tools/list responses with 4 tools
```

If both check out but Claude Code still can't call them, **restart Claude Code**
fully (kill any running instances + re-launch) — settings.json is read on
session start.

### PM2 scheduler is "online" but never extracts anything

```bash
# Check the allowlist
cat ~/.claude/claude-mem-projects.txt
# Must contain absolute paths, one per line. Empty file = no work.

# Check scheduler logs for what it tried
pm2 logs claude-mem-scheduler --lines 100 --nostream
```

Common gotchas:
- Relative paths in the allowlist are ignored
- Paths to non-existent dirs are skipped silently
- The `.extract.lock` file in `.claude/memory/` prevents concurrent ticks; if
  a previous tick hung, you may need to delete it manually

### Extract is slow / timing out

The PM2 scheduler kills any extract that runs > 15 minutes. If you have a project
with 100+ session-keys queued at once (e.g. backfill from old JSONL files), it
might not complete in one tick.

Solutions:
- Run `claude-mem extract --max-sessions 5` manually to process in chunks
- Increase `DEFAULT_EXTRACT_TIMEOUT_MS` in `scheduler.cjs` (default 15 min)
- Switch `extraction.model` to a faster (cheaper) model temporarily

---

## What's installed where

| Path | Purpose | Owned by |
|---|---|---|
| `$(npm root -g)/@vkirill/tencentdb-memory-claude-code/` | The package code | npm |
| `~/.claude/hooks/claude-mem/*.sh` | Hook wrappers (recall, stop) | install.sh |
| `~/.claude/hooks/claude-mem/scheduler.cjs` | PM2 daemon | install.sh |
| `~/.claude/claude-mem.env` | API keys (mode 600) | you |
| `~/.claude/claude-mem-projects.txt` | PM2 extract allowlist | you |
| `~/.claude/settings.json` | Hook + MCP registration | install.sh patches |
| `<project>/.claude/memory/` | Per-project memory state (L0/L1/L2/L3) | claude-mem CLI |
| `~/.pm2/` | PM2 process state | pm2 |

---

## Next steps

- Read [README.md](./README.md) for architecture details.
- Browse [CHANGELOG.md](./CHANGELOG.md) for what shipped in each version.
- Open issues at https://github.com/VKirill/TencentDB-Memory-Claude-Code/issues.
