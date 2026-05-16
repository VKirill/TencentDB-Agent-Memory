# v0.4.3 SPEC — install.sh writes MCP to correct file (`~/.claude.json`)

> Date: 2026-05-17 · Branch: `fix/v0.4.3-mcp-correct-location`
> Predecessor: v0.4.2 (rename to tencentdb-memory)

## 1. Goal — critical install bug fix

`install.sh` v0.4.0-v0.4.2 wrote `mcpServers.tencentdb-memory` to the WRONG file:
`~/.claude/settings.json` (which is Claude Code's hooks settings file).

The actual file Claude Code reads for MCP server registration is
**`~/.claude.json`** (at HOME root, not inside `~/.claude/` directory).

Effect: every user who installed v0.4.0/v0.4.1/v0.4.2 has a non-functional MCP
registration. `/mcp` UI doesn't show our server. Tools can't be called by
Claude (even though the server itself boots correctly via stdio).

This release fixes the location + migrates botched installs cleanly.

## 2. Non-goals

- Changing MCP server name (`tencentdb-memory` stays — fixed in v0.4.2)
- Changing CLI binary name
- Code changes to MCP server itself
- Touching `~/.claude.json` other keys (this file holds many other configs)

## 3. Architecture decisions

| ID | Decision | Rationale |
|---|---|---|
| ADR-1 | Write to `~/.claude.json` `mcpServers` key | This is the canonical location Claude Code reads; verified by inspecting working MCP entries (context7, gitnexus, etc.) all live there |
| ADR-2 | Include `"type": "stdio"` field in the registration object | Matches the convention of other working MCP entries (thedotmack, library, etc.) and is more explicit |
| ADR-3 | Atomic write: `tmpfile → rename` via node script (existing util) | `~/.claude.json` is critical — corruption would brick user's Claude Code. Atomic write prevents partial writes on Ctrl-C / disk full |
| ADR-4 | Migration on install: REMOVE `mcpServers.tencentdb-memory` AND legacy `mcpServers.claude-mem` from `~/.claude/settings.json` if present | Cleanup botched v0.4.0-v0.4.2 installs; leaves settings.json with empty mcpServers field (still valid) |
| ADR-5 | Idempotency: check `~/.claude.json` for existing `mcpServers.tencentdb-memory`; if present and command path matches current bin → skip with friendly message | Re-runs upgrade cleanly without churning the file |
| ADR-6 | NO migration of MCP TOOL references in user's custom agent files | `mcp__tencentdb-memory__*` tool prefix already documented in v0.4.2 — users adopt this manually |

## 4. Acceptance criteria

1. ✅ Fresh install on a user with no prior MCP setup: `~/.claude.json` gets `mcpServers.tencentdb-memory` with `type: "stdio"`, command + args
2. ✅ Upgrade from v0.4.0-v0.4.2: install.sh REMOVES the legacy entry in `~/.claude/settings.json` AND adds correct one to `~/.claude.json` (clean state in both files)
3. ✅ Re-run on already-correct install: no-op message, no churn
4. ✅ `~/.claude.json` corruption protection: write fails → original file restored from tmp
5. ✅ All other `mcpServers` entries in `~/.claude.json` (context7, gitnexus, github, etc.) preserved
6. ✅ All other top-level keys in `~/.claude.json` preserved
7. ✅ `claude-mem --version` = 0.4.3
8. ✅ `npm test` 91/91 still passing
9. ✅ `npm run build` + `npm run lint:gate` clean
10. ✅ uninstall.sh updated symmetrically (removes from both files for backward-compat)
11. ✅ INSTALL.md / README.md verification snippets updated to reference correct file path

## 5. File plan

| File | Change | Lines |
|---|---|---|
| `claude-code-integration/install.sh` | Replace settings.json MCP write block with new dual-action: (a) write to `~/.claude.json`, (b) remove from `~/.claude/settings.json` and project-level if present | ~50 |
| `claude-code-integration/uninstall.sh` | Symmetric: remove from `~/.claude.json` first, then settings.json (back-compat) | ~30 |
| `claude-code-integration/templates/settings.json.template` | REMOVE `mcpServers` key (was misplaced) | -7 |
| `INSTALL.md` | Verification snippets — reference `~/.claude.json` not `~/.claude/settings.json` | ~10 |
| `README.md` | Same wherever MCP location is mentioned | ~5 |
| `README.ru.md` | Same | ~5 |
| `CHANGELOG.md` | `[0.4.3]` entry — critical fix + migration notes | +50 |
| `package.json` + `src/cli/index.ts` | 0.4.2 → 0.4.3 | 2 |

Total: ~8 files modified, ~155 LOC delta. **No new files.**

## 6. The fix — canonical install.sh patch

Current (broken) block (around line 130-165 in v0.4.2 install.sh):

```bash
# v0.4.0: register MCP server in settings.json
SETTINGS_PATH="$HOME/.claude/settings.json"
if [ -f "$SETTINGS_PATH" ]; then
  if ! grep -q '"tencentdb-memory"' "$SETTINGS_PATH"; then
    node -e '
      const fs = require("node:fs");
      const p = "'"$SETTINGS_PATH"'";
      const s = JSON.parse(fs.readFileSync(p, "utf-8"));
      s.mcpServers = s.mcpServers || {};
      if (s.mcpServers["claude-mem"]) {
        delete s.mcpServers["claude-mem"];
        console.log("removed legacy claude-mem MCP key from", p);
      }
      s.mcpServers["tencentdb-memory"] = {
        command: "'"$BIN_PATH"'",
        args: ["mcp", "serve"]
      };
      fs.writeFileSync(p, JSON.stringify(s, null, 2));
      console.log("registered tencentdb-memory MCP server in", p);
    '
  else
    echo "claude-mem install: tencentdb-memory MCP server already registered, skipping"
  fi
fi
```

Replacement (v0.4.3):

```bash
# v0.4.3: register MCP server in ~/.claude.json (the canonical file Claude Code reads).
# v0.4.0-v0.4.2 BUG: wrote to ~/.claude/settings.json which is hooks-only — Claude Code's
# /mcp UI never saw the server. We now write to the correct file AND migrate stale entries
# from the wrong locations.
CLAUDE_JSON="$HOME/.claude.json"
LEGACY_SETTINGS="$HOME/.claude/settings.json"
LEGACY_PROJECT_SETTINGS=""  # set below if PROJECT_DIR provided
node -e '
const fs = require("node:fs");
const path = require("node:path");
const binPath = "'"$BIN_PATH"'";
const targetFile = "'"$CLAUDE_JSON"'";
const legacyFiles = [
  "'"$LEGACY_SETTINGS"'",
];

// 1. Atomic write to ~/.claude.json
function atomicWrite(p, obj) {
  const tmp = p + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}

// 2. Read or initialize ~/.claude.json (must preserve all other keys + mcpServers)
let main = {};
if (fs.existsSync(targetFile)) {
  try { main = JSON.parse(fs.readFileSync(targetFile, "utf-8")); }
  catch (e) {
    console.error("claude-mem install: ~/.claude.json is corrupt — aborting MCP registration");
    process.exit(1);
  }
}
main.mcpServers = main.mcpServers || {};

// 3. Idempotency check
const existing = main.mcpServers["tencentdb-memory"];
const wanted = { type: "stdio", command: binPath, args: ["mcp", "serve"] };
if (existing && existing.command === wanted.command &&
    JSON.stringify(existing.args || []) === JSON.stringify(wanted.args)) {
  console.log("claude-mem install: tencentdb-memory MCP already registered in ~/.claude.json, skipping");
} else {
  main.mcpServers["tencentdb-memory"] = wanted;
  atomicWrite(targetFile, main);
  console.log("claude-mem install: registered tencentdb-memory MCP server in ~/.claude.json");
}

// 4. Cleanup legacy entries in WRONG files (v0.4.0-v0.4.2 botched installs)
for (const lf of legacyFiles) {
  if (!fs.existsSync(lf)) continue;
  let s;
  try { s = JSON.parse(fs.readFileSync(lf, "utf-8")); } catch { continue; }
  if (!s.mcpServers) continue;
  let changed = false;
  for (const k of ["tencentdb-memory", "claude-mem"]) {
    if (s.mcpServers[k]) {
      delete s.mcpServers[k];
      console.log("claude-mem install: removed stale " + k + " MCP entry from " + lf);
      changed = true;
    }
  }
  if (changed) atomicWrite(lf, s);
}
'
```

## 7. uninstall.sh patch

Remove from BOTH `~/.claude.json` (current location) AND legacy `~/.claude/settings.json` (for users uninstalling botched v0.4.0-v0.4.2 installs).

```bash
node -e '
const fs = require("node:fs");
const files = [
  "'"$HOME"'/.claude.json",
  "'"$HOME"'/.claude/settings.json",
];
for (const p of files) {
  if (!fs.existsSync(p)) continue;
  let s;
  try { s = JSON.parse(fs.readFileSync(p, "utf-8")); } catch { continue; }
  if (!s.mcpServers) continue;
  let changed = false;
  for (const k of ["tencentdb-memory", "claude-mem"]) {
    if (s.mcpServers[k]) {
      delete s.mcpServers[k];
      console.log("removed " + k + " from " + p);
      changed = true;
    }
  }
  if (changed) {
    const tmp = p + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
    fs.renameSync(tmp, p);
  }
}
'
```

## 8. Verification

```bash
cd /home/ubuntu/projects/TencentDB-MCC-v0.4.3
npm test 2>&1 | tail -3
npm run build 2>&1 | tail -3
npm run lint:gate 2>&1 | tail -3
node bin/claude-mem.mjs --version  # expect 0.4.3

# Fresh install test
TMP=$(mktemp -d)
mkdir -p "$TMP/.claude"
HOME=$TMP CLAUDE_MEM_BIN=/home/ubuntu/.npm-global/bin/claude-mem bash claude-code-integration/install.sh 2>&1 | grep "claude-mem install"
python3 -c "
import json, os
home = '$TMP'
correct = json.load(open(f'{home}/.claude.json'))
print('~/.claude.json mcpServers:', list(correct.get('mcpServers',{}).keys()))
tdm = correct['mcpServers']['tencentdb-memory']
print(f'  type: {tdm.get(\"type\")} (expect stdio)')
print(f'  command: {tdm[\"command\"]}')
print(f'  args: {tdm[\"args\"]}')
# Old file should NOT have tencentdb-memory anymore
settings = json.load(open(f'{home}/.claude/settings.json'))
assert 'tencentdb-memory' not in settings.get('mcpServers',{}), 'should NOT be in settings.json'
print('~/.claude/settings.json: ✅ clean (no MCP key)')
"

# Migration test: legacy install state from v0.4.2
TMP2=$(mktemp -d)
mkdir -p $TMP2/.claude
cat > $TMP2/.claude.json <<EOF
{"mcpServers":{"other-mcp":{"command":"/somewhere","args":[]}}}
EOF
cat > $TMP2/.claude/settings.json <<EOF
{"mcpServers":{"tencentdb-memory":{"command":"/home/ubuntu/.npm-global/bin/claude-mem","args":["mcp","serve"]}}}
EOF
HOME=$TMP2 CLAUDE_MEM_BIN=/home/ubuntu/.npm-global/bin/claude-mem bash claude-code-integration/install.sh 2>&1 | grep "claude-mem install"
python3 -c "
import json
home = '$TMP2'
correct = json.load(open(f'{home}/.claude.json'))
mcp = correct.get('mcpServers',{})
print('~/.claude.json mcpServers:', list(mcp.keys()))
assert 'other-mcp' in mcp, 'other-mcp lost!'
assert 'tencentdb-memory' in mcp, 'tencentdb-memory not added'
settings = json.load(open(f'{home}/.claude/settings.json'))
assert 'tencentdb-memory' not in settings.get('mcpServers',{}), 'stale entry not cleaned'
print('✅ migration clean: other-mcp preserved, tencentdb-memory moved to correct file')
"

gio trash $TMP $TMP2 2>&1
```

## 9. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Corruption of `~/.claude.json` (huge file with user's all state) on partial write | Atomic write via tmp + rename; parse error → abort with clear message |
| R2 | User's other MCP entries lost | Read-modify-write preserves all sibling keys; explicit assertion in tests |
| R3 | `~/.claude.json` doesn't exist for fresh Claude Code users | Initialize as `{}` and add `mcpServers` — fresh install works |
| R4 | settings.json template still references mcpServers — orphan key | Remove from template so future installs don't create wrong-location entry |
