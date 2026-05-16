# v0.5.0 SPEC — rename binary `claude-mem` → `tencentdb-mem`

> Date: 2026-05-17 · Branch: `feat/v0.5.0-rename-binary`
> Predecessor: v0.4.3 (install.sh writes MCP to correct file)
> **Breaking change — major version bump 0.4.3 → 0.5.0**

## 1. Goal

Rename the CLI binary from `claude-mem` to `tencentdb-mem` to eliminate
Anthropic brand collision. The current binary name reads as if it were an
official Anthropic product. Aligning to the upstream TencentDB brand
(which we openly fork from, attribution preserved) is honest and
trust-building.

## 2. Non-goals

- Renaming the npm package (`@vkirill/tencentdb-memory-claude-code` —
  `claude-code` here is descriptor-as-fair-use, like `firebase-tools` or
  `stripe-cli`)
- Renaming the GitHub repo (`TencentDB-Memory-Claude-Code` — same reasoning)
- Renaming MCP server identifier (`tencentdb-memory` — already correct since v0.4.2)
- Renaming hooks dir (`~/.claude/hooks/claude-mem/` — local path, not user-facing)
- Backward-compat shim `claude-mem → tencentdb-mem` (clean break; upgrade via npm uninstall+install)

## 3. Architecture decisions

| ID | Decision | Rationale |
|---|---|---|
| ADR-1 | New binary name = `tencentdb-mem` (13 chars) | Brand-honest (TencentDB is upstream), readable, no Anthropic conflict |
| ADR-2 | NO backward-compat symlink for `claude-mem` | Clean semantic break. Users get explicit error if they type old command instead of silent proxy that hides upgrade. CHANGELOG migration note covers it. |
| ADR-3 | Major version bump 0.4.3 → 0.5.0 | Binary rename = breaking change for anyone with hardcoded `claude-mem` in scripts; semver-major communicates this |
| ADR-4 | install.sh runs idempotently — re-running over v0.4.x state cleans hooks that reference `claude-mem` and re-wires to `tencentdb-mem` | Smooth upgrade for existing users |
| ADR-5 | Hooks dir (`~/.claude/hooks/claude-mem/`) NOT renamed — internal path, no user impact | Less churn; not a brand-claim issue (not user-visible binary) |
| ADR-6 | All docs (README, README.ru, INSTALL, CHANGELOG) reflect new binary name | First-impression accuracy |

## 4. Acceptance criteria

1. ✅ `package.json` `bin` field maps `tencentdb-mem` → `./bin/tencentdb-mem.mjs`
2. ✅ `bin/claude-mem.mjs` renamed → `bin/tencentdb-mem.mjs`
3. ✅ `install.sh` resolves the new binary path; wires SessionStart hook to `tencentdb-mem mcp serve`; MCP registration in `~/.claude.json` uses `tencentdb-mem`
4. ✅ All 3 wrapper scripts (`recall-wrapper.sh`, `stop-wrapper.sh`, `capture-wrapper.sh`) invoke `tencentdb-mem`
5. ✅ `scheduler.cjs` invokes `tencentdb-mem extract`
6. ✅ `settings.json.template` hook commands reference `tencentdb-mem`
7. ✅ `CLAUDE_MEM_BIN` env var honors new name (was `/path/to/claude-mem`; should default to `/path/to/tencentdb-mem`)
8. ✅ Fresh install: `which tencentdb-mem` resolves; `tencentdb-mem --version` = 0.5.0; `tencentdb-mem mcp serve` boots MCP server with name `tencentdb-memory`
9. ✅ Upgrade test: re-run install.sh after v0.4.3 install — old hooks pointing to `claude-mem` get replaced with `tencentdb-mem`
10. ✅ README + README.ru + INSTALL show new binary in all command examples
11. ✅ CHANGELOG `[0.5.0]` entry with clear migration steps
12. ✅ `npm test` 91/91 still passing
13. ✅ `npm run build` + `npm run lint:gate` clean

## 5. File plan

| File | Change | Lines |
|---|---|---|
| `package.json` `bin` field | rename key | 1 |
| `bin/claude-mem.mjs` → `bin/tencentdb-mem.mjs` | git mv | rename |
| `claude-code-integration/install.sh` | replace `claude-mem` references → `tencentdb-mem` (binary name, MCP registration command, hook commands) | ~20 |
| `claude-code-integration/uninstall.sh` | same | ~10 |
| `claude-code-integration/templates/settings.json.template` | hook commands | ~3 |
| `claude-code-integration/templates/recall-wrapper.sh` | `CLAUDE_MEM_CMD` resolution + invocation | ~5 |
| `claude-code-integration/templates/stop-wrapper.sh` | same | ~5 |
| `claude-code-integration/templates/capture-wrapper.sh` | same | ~5 |
| `claude-code-integration/scheduler.cjs` | `resolveBinPath()` default fallback path | ~3 |
| `README.md` | all `claude-mem` commands → `tencentdb-mem`; new version refs | ~30 |
| `README.ru.md` | same | ~30 |
| `INSTALL.md` | same | ~20 |
| `CHANGELOG.md` | `[0.5.0]` entry + migration | +50 |
| `src/cli/index.ts` | `.version("0.4.3")` → `.version("0.5.0")`; `program.name("claude-mem")` → `program.name("tencentdb-mem")` | 2 |
| `package.json` version | 0.4.3 → 0.5.0 | 1 |

Total: ~13 files modified, 1 renamed, ~190 LOC delta.

## 6. install.sh sketch — old name cleanup on upgrade

Add migration block in install.sh AFTER current MCP registration logic:

```bash
# v0.5.0: clean up references to old 'claude-mem' binary in hooks
SETTINGS_PATH="$HOME/.claude/settings.json"
if [ -f "$SETTINGS_PATH" ]; then
  # If settings.json references 'claude-mem' in any hook command, replace with 'tencentdb-mem'
  if grep -q '/claude-mem' "$SETTINGS_PATH" 2>/dev/null; then
    sed -i.bak.before-v0.5.0 's|/claude-mem |/tencentdb-mem |g; s|/claude-mem"|/tencentdb-mem"|g' "$SETTINGS_PATH"
    echo "claude-mem install: migrated settings.json hook commands from claude-mem → tencentdb-mem"
  fi
fi
# Also clean MCP server command in ~/.claude.json if it still points to old binary
node -e '
const fs = require("node:fs");
const p = "'"$HOME"'/.claude.json";
if (!fs.existsSync(p)) process.exit(0);
const s = JSON.parse(fs.readFileSync(p, "utf-8"));
const tdm = s.mcpServers && s.mcpServers["tencentdb-memory"];
if (tdm && tdm.command && tdm.command.endsWith("/claude-mem")) {
  tdm.command = tdm.command.replace(/\/claude-mem$/, "/tencentdb-mem");
  const tmp = p + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, p);
  console.log("claude-mem install: migrated ~/.claude.json MCP command to tencentdb-mem");
}
'
```

## 7. CHANGELOG migration block (canonical)

```markdown
## [0.5.0] — 2026-05-17

**BREAKING:** CLI binary renamed `claude-mem` → `tencentdb-mem` to eliminate
Anthropic brand collision (the old name read as if it were an official
Anthropic tool; align to the upstream TencentDB brand we openly fork from).

### Changed
- Binary name: `claude-mem` → `tencentdb-mem`
- All hook commands, wrappers, scheduler, MCP registration updated
- All docs, examples use new binary name

### Migration (existing users — mandatory)
```bash
# 1. Remove old install
npm uninstall -g @vkirill/tencentdb-memory-claude-code

# 2. Install v0.5.0
npm i -g github:VKirill/TencentDB-Memory-Claude-Code#v0.5.0

# 3. Re-run install.sh — auto-migrates hook commands + MCP registration from old name
bash $(npm root -g)/@vkirill/tencentdb-memory-claude-code/claude-code-integration/install.sh

# 4. Restart Claude Code

# 5. Verify
tencentdb-mem --version    # → 0.5.0
which claude-mem            # → (not found — expected)
```

### Unchanged
- npm package name `@vkirill/tencentdb-memory-claude-code`
- GitHub repo `TencentDB-Memory-Claude-Code`
- MCP server name `tencentdb-memory`
- All tool names `mcp__tencentdb-memory__*`
- All config files, env vars, data formats
- All test fixtures
```

## 8. Verification

```bash
cd /home/ubuntu/projects/TencentDB-MCC-v0.5.0
npm test 2>&1 | tail -3   # 91/91
npm run build 2>&1 | tail -3
npm run lint:gate 2>&1 | tail -3

# Pack + install in clean HOME
TMP=$(mktemp -d)
mkdir -p "$TMP/.claude" "$TMP/.npm-global/bin" "$TMP/.npm-global/lib/node_modules"
npm pack 2>&1 | tail -1
# Install dependencies into tmp prefix
PREFIX=$TMP/.npm-global npm i -g vkirill-tencentdb-memory-claude-code-0.5.0.tgz 2>&1 | tail -3

# Verify new binary
test -x "$TMP/.npm-global/bin/tencentdb-mem" && echo "✅ tencentdb-mem binary present"
test ! -e "$TMP/.npm-global/bin/claude-mem" && echo "✅ old claude-mem absent"

# Verify version
"$TMP/.npm-global/bin/tencentdb-mem" --version  # expect 0.5.0

# Verify MCP boot
printf '%s\n' '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}},"id":1}' \
  | timeout 5 "$TMP/.npm-global/bin/tencentdb-mem" mcp serve 2>/dev/null \
  | python3 -c "import sys,json; r=json.loads(sys.stdin.read()); print('server name:', r['result']['serverInfo']['name'])"
# Expected: server name: tencentdb-memory

# Verify install.sh wires new binary + migrates old
HOME=$TMP CLAUDE_MEM_BIN="$TMP/.npm-global/bin/tencentdb-mem" bash claude-code-integration/install.sh 2>&1 | tail -10
python3 -c "
import json
s = json.load(open('$TMP/.claude.json')) if __import__('os').path.exists('$TMP/.claude.json') else {}
mcp = s.get('mcpServers',{}).get('tencentdb-memory',{})
cmd = mcp.get('command','')
assert cmd.endswith('/tencentdb-mem'), f'wrong command: {cmd}'
print('✅ MCP command points to new binary:', cmd)
"

# Upgrade test — pre-existing v0.4.3 install state
TMP2=$(mktemp -d)
mkdir -p $TMP2/.claude
cat > $TMP2/.claude.json <<EOF
{"mcpServers":{"tencentdb-memory":{"type":"stdio","command":"/home/ubuntu/.npm-global/bin/claude-mem","args":["mcp","serve"]}}}
EOF
cat > $TMP2/.claude/settings.json <<EOF
{"hooks":{"SessionStart":[{"matcher":"*","hooks":[{"type":"command","command":"/home/ubuntu/.npm-global/bin/claude-mem mcp serve","timeout":8000}]}]}}
EOF
HOME=$TMP2 CLAUDE_MEM_BIN=/home/ubuntu/.npm-global/bin/tencentdb-mem bash claude-code-integration/install.sh 2>&1 | grep -i "migrated"
# Should show migration messages

gio trash $TMP $TMP2 vkirill-tencentdb-memory-claude-code-0.5.0.tgz 2>&1
```

## 9. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | npm doesn't remove old bin when bin field changes — user has BOTH `claude-mem` and `tencentdb-mem` after `npm i -g` upgrade | Document mandatory `npm uninstall` before `npm i -g` in CHANGELOG migration block |
| R2 | User's custom scripts hardcoded `claude-mem` | This is the EXPECTED breaking change. Major version bump signals it. CHANGELOG migration explicit. |
| R3 | PM2 scheduler restart needed (uses old binary path) | Document in migration: `pm2 restart claude-mem-scheduler` after install |
| R4 | Hooks dir name `~/.claude/hooks/claude-mem/` still has old brand | Local path, not user-visible binary. Out of scope. If user objects, separate ticket. |
