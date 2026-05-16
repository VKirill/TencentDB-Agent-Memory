# v0.4.2 SPEC — rename MCP server `claude-mem` → `tencentdb-memory`

> Date: 2026-05-17 · Branch: `fix/v0.4.2-rename-mcp`
> Predecessor: v0.4.1 (auto-register on SessionStart)

## 1. Goal

Eliminate the namespace collision with the unrelated `thedotmack/claude-mem`
Claude Code plugin (5 cached versions in `~/.claude/plugins/cache/thedotmack/claude-mem/`).
When both register MCP under similar prefixes, `/mcp` UI may shadow ours. Rename
our MCP server **name** + tool **prefix** to a unique brand-aligned identifier.

| Layer | Before | After |
|---|---|---|
| MCP server key in settings.json `mcpServers` | `claude-mem` | `tencentdb-memory` |
| MCP server `name` field in Server init | `claude-mem` | `tencentdb-memory` |
| Tool prefix in agent calls | `mcp__claude-mem__*` | `mcp__tencentdb-memory__*` |
| CLI binary | `claude-mem` (UNCHANGED — brand) | `claude-mem` |
| npm package | `@vkirill/tencentdb-memory-claude-code` (UNCHANGED) | same |
| GitHub repo | `TencentDB-Memory-Claude-Code` (UNCHANGED) | same |

## 2. Non-goals

- Rename CLI binary (would break every user)
- Rename npm package (just renamed in v0.4.0; another rename would be churn)
- Rename GitHub repo (same)
- Code changes to MCP tool logic (just the registration name)
- Backward-compat alias for the old `claude-mem` MCP name — fresh install only

## 3. Architecture decisions

| ID | Decision | Rationale |
|---|---|---|
| ADR-1 | Server name = `tencentdb-memory` (no hyphens at end, no `mcc` acronym) | Aligns with package brand TencentDB; longer than `claude-mem` but unique to this fork; reads naturally as "TencentDB memory" |
| ADR-2 | All 4 tool names UNCHANGED (`memory_search`, `conversation_search`, `recall_persona`, `recall_scenes`) | Tool function names are semantic; only the server prefix changes |
| ADR-3 | install.sh idempotency: if old `claude-mem` MCP key exists in user's settings.json, REMOVE it then add new `tencentdb-memory` key | Clean upgrade — no orphan registrations |
| ADR-4 | Same rename to uninstall.sh — remove `tencentdb-memory` AND legacy `claude-mem` keys | Idempotent uninstall regardless of install version |
| ADR-5 | Docs (README/INSTALL/CHANGELOG) updated with all 4 new tool names | First-impression accuracy for new GitHub visitors |

## 4. Acceptance criteria

1. ✅ `claude-mem mcp serve` starts MCP server with `name: "tencentdb-memory"` in init response
2. ✅ Fresh install via `install.sh v0.4.2`: settings.json `mcpServers.tencentdb-memory` registered; no `mcpServers.claude-mem` key present
3. ✅ Upgrade from v0.4.1: re-running install.sh removes old `claude-mem` key, adds `tencentdb-memory` key, no duplicates
4. ✅ `uninstall.sh v0.4.2` removes both `tencentdb-memory` AND any legacy `claude-mem` MCP key (clean state regardless of install age)
5. ✅ README.md and README.ru.md show updated tool names `mcp__tencentdb-memory__*`
6. ✅ INSTALL.md verification snippets use new name
7. ✅ `npm test` 91/91 still passing (tests check server name)
8. ✅ `npm run build` + `npm run lint:gate` clean
9. ✅ `claude-mem --version` = `0.4.2`

## 5. File plan

| File | Change | Lines |
|---|---|---|
| `src/mcp/server.ts` | `name: "claude-mem"` → `name: "tencentdb-memory"` (Server init) | 1 |
| `src/mcp/server.test.ts` | Update any assertion against server name | 0-2 |
| `claude-code-integration/templates/settings.json.template` | `mcpServers` key rename | 1 |
| `claude-code-integration/install.sh` | jq script: register under new key; remove legacy `claude-mem` key if present (upgrade path) | ~15 |
| `claude-code-integration/uninstall.sh` | Remove BOTH new and legacy MCP keys | ~10 |
| `claude-code-integration/README.md` | Tool name references | ~5 |
| `README.md` | `mcp__claude-mem__*` × 4 → `mcp__tencentdb-memory__*` | ~5 |
| `README.ru.md` | Same | ~5 |
| `INSTALL.md` | Tool name in verification + troubleshooting | ~5 |
| `CHANGELOG.md` | `[0.4.2]` entry | +30 |
| `package.json` + `src/cli/index.ts` | 0.4.1 → 0.4.2 | 2 |

Total: ~10 modified files, ~80 LOC delta.

## 6. Verification

```bash
cd /home/ubuntu/projects/TencentDB-MCC-v0.4.2
npm test 2>&1 | tail -3
npm run build 2>&1 | tail -3
npm run lint:gate 2>&1 | tail -3
node bin/claude-mem.mjs --version

# MCP server reports new name
printf '%s\n' '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}},"id":1}' \
  | timeout 5 node bin/claude-mem.mjs mcp serve 2>/dev/null \
  | python3 -c "import sys,json; r=json.loads(sys.stdin.read()); print('server name:', r['result']['serverInfo']['name'])"
# Expected: server name: tencentdb-memory

# Fresh install dry-run
TMP=$(mktemp -d)
HOME=$TMP CLAUDE_MEM_BIN=/home/ubuntu/.npm-global/bin/claude-mem bash claude-code-integration/install.sh 2>&1 | tail -5
python3 -c "
import json
s = json.load(open('$TMP/.claude/settings.json'))
print('mcpServers keys:', list(s.get('mcpServers',{}).keys()))"
# Expected: ['tencentdb-memory']

# Upgrade test — start with legacy claude-mem key, run install, verify cleanup
TMP2=$(mktemp -d)
mkdir -p $TMP2/.claude
cat > $TMP2/.claude/settings.json <<EOF
{"mcpServers":{"claude-mem":{"command":"/home/ubuntu/.npm-global/bin/claude-mem","args":["mcp","serve"]}}}
EOF
HOME=$TMP2 CLAUDE_MEM_BIN=/home/ubuntu/.npm-global/bin/claude-mem bash claude-code-integration/install.sh 2>&1 | tail -5
python3 -c "
import json
s = json.load(open('$TMP2/.claude/settings.json'))
keys = list(s.get('mcpServers',{}).keys())
assert 'claude-mem' not in keys, 'legacy key not removed'
assert 'tencentdb-memory' in keys, 'new key not registered'
print('✅ upgrade clean:', keys)"

gio trash $TMP $TMP2 2>&1
```

## 7. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | User has agents with `mcp__claude-mem__*` in tools allowlist — will break for them after upgrade | Doc in CHANGELOG migration: "rename all `mcp__claude-mem__*` references in your custom agents to `mcp__tencentdb-memory__*`". Orchestrator-managed agents (~/.claude/agents/) get patched by user separately. |
| R2 | npm package or repo name churn | Out of scope — only MCP server identifier renames |
| R3 | install.sh migration removes user's `claude-mem` key but they actually have the unrelated `thedotmack/claude-mem` plugin's MCP registered there (cross-contamination) | Highly unlikely — thedotmack's MCP is named `mcp-search`, not `claude-mem`. If user has manually added a custom claude-mem entry, the migration logic only removes entries whose command points to our bin or contains `tencentdb-memory-claude-code` package path |
