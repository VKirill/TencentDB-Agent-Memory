# v0.4.1 SPEC — auto-register project on SessionStart

> Date: 2026-05-16 · Branch: `feat/v0.4.1-auto-register`
> Predecessor: v0.4.0 (MCP + rebrand + README rewrite)

## 1. Goal

Eliminate the manual `echo "$HOME/project" >> ~/.claude/claude-mem-projects.txt`
step from the install flow. When Claude Code starts in any project, the
SessionStart hook idempotently appends the project's absolute path to the
PM2 scheduler allowlist if it's not already there.

## 2. Non-goals

- Removing projects from the allowlist (manual operation; not auto-managed)
- Auto-register from `.bashrc` (wrong tool — fires on every terminal, not Claude usage)
- New code in `src/` — install + template + docs only

## 3. Architecture decisions

| ID | Decision | Rationale |
|---|---|---|
| ADR-1 | Add SECOND hook command to existing SessionStart matcher entry (not a new matcher) | Keeps related hooks grouped; runs both serially per Claude Code's hook contract |
| ADR-2 | Auto-register command runs BEFORE the recall command in the array | Allowlist populated before any future PM2 tick benefits — recall doesn't depend on it but order is intuitive |
| ADR-3 | Idempotent via `grep -qxF` — exact-line match; if path already present, no-op | Zero risk of duplicate entries on repeated sessions |
| ADR-4 | Path = `${CLAUDE_PROJECT_DIR:-$PWD}` (Claude Code sets this env on session start; fallback to current dir for direct CLI usage) | Matches the existing recall hook's convention |
| ADR-5 | `isOurs` jq check in install.sh extended to also match `claude-mem-projects.txt` literal | Otherwise reinstall over the old single-hook entry would not detect ownership of the new entry → duplicate accumulation |
| ADR-6 | NO change to the template's other 3 hooks (UserPromptSubmit, Stop, PostToolUse) | Out of scope — they work fine |

## 4. Acceptance criteria

1. ✅ Fresh install with `install.sh v0.4.1` produces a settings.json SessionStart entry with **2** hook commands: auto-register first, recall second
2. ✅ Existing user upgrading from v0.4.0: re-running install.sh replaces the old single-hook entry without producing duplicates
3. ✅ Starting Claude Code in any project appends the project's absolute path to `~/.claude/claude-mem-projects.txt` if absent; no-op if present
4. ✅ `~/.claude/claude-mem-projects.txt` is created (via `mkdir -p ~/.claude && touch`) if it doesn't exist when the hook runs
5. ✅ `claude-mem --version` returns `0.4.1`
6. ✅ `npm test` 91/91 still green (no src/ changes)
7. ✅ `npm run build` OK, `npm run lint:gate` clean

## 5. File plan

| File | Change | Lines |
|---|---|---|
| `claude-code-integration/templates/settings.json.template` | Add auto-register hook command to SessionStart array (first position) | +5 |
| `claude-code-integration/install.sh` | Extend `isOurs` jq def to also match `claude-mem-projects.txt` literal | +1 |
| `package.json` | 0.4.0 → 0.4.1 | 1 |
| `src/cli/index.ts` | `.version("0.4.0")` → `.version("0.4.1")` | 1 |
| `CHANGELOG.md` | `[0.4.1]` entry | +25 |
| `README.md` | Remove Step 4 manual echo; note it's automatic | +3/-4 |
| `README.ru.md` | Same | +3/-4 |
| `INSTALL.md` | Update Step 4 section to say "happens automatically" | +5/-15 |

Total: 8 files modified, ~50 LOC delta. **No new files.**

## 6. The hook command — canonical form

In `settings.json.template`, the SessionStart array becomes:

```json
"SessionStart": [
  {
    "matcher": "*",
    "hooks": [
      {
        "type": "command",
        "command": "P=\"${CLAUDE_PROJECT_DIR:-$PWD}\"; mkdir -p \"$HOME/.claude\" && touch \"$HOME/.claude/claude-mem-projects.txt\" && grep -qxF \"$P\" \"$HOME/.claude/claude-mem-projects.txt\" || echo \"$P\" >> \"$HOME/.claude/claude-mem-projects.txt\"",
        "timeout": 2000
      },
      {
        "type": "command",
        "command": "<ABS_BIN> --auto-init --platform claude-code recall --query \"$(basename \"${CLAUDE_PROJECT_DIR:-$PWD}\")\" --limit 5",
        "timeout": 8000
      }
    ]
  }
]
```

Notes:
- The auto-register command is a single bash line — `mkdir -p` + `touch` + `grep || echo`
- Timeout 2s (shell ops only — no LLM)
- The `||` chain: append only if grep finds no exact match

## 7. install.sh `isOurs` patch

Current `isOurs` def (line ~275):
```jq
def isOurs:
  .hooks // [] |
  all(
    . | (.command // "") |
    (contains($hooksDir)) or (contains($binPath))
  );
```

After patch — add a third literal match for the allowlist filename:
```jq
def isOurs:
  .hooks // [] |
  all(
    . | (.command // "") |
    (contains($hooksDir))
    or (contains($binPath))
    or (contains("claude-mem-projects.txt"))
  );
```

Rationale: the new auto-register hook command contains neither `$hooksDir`
nor `$binPath` — only the allowlist filename. Without this, the check would
return false → entry classified as "foreign" → kept on reinstall → duplicate.

## 8. Verification

After implementation:

```bash
# 1. Build
npm run build

# 2. Simulate fresh install on a tmp HOME
TMP_HOME=$(mktemp -d)
HOME=$TMP_HOME bash claude-code-integration/install.sh
cat $TMP_HOME/.claude/settings.json | python3 -m json.tool | grep -A 12 SessionStart
# Expected: 2 hook commands, auto-register first

# 3. Simulate session start
cd /tmp/some-test-project  # or any dir
CLAUDE_PROJECT_DIR=/tmp/some-test-project bash -c 'P="${CLAUDE_PROJECT_DIR:-$PWD}"; mkdir -p "$TMP_HOME/.claude" && touch "$TMP_HOME/.claude/claude-mem-projects.txt" && grep -qxF "$P" "$TMP_HOME/.claude/claude-mem-projects.txt" || echo "$P" >> "$TMP_HOME/.claude/claude-mem-projects.txt"'
cat $TMP_HOME/.claude/claude-mem-projects.txt
# Expected: /tmp/some-test-project listed

# 4. Run same hook again — must remain idempotent
CLAUDE_PROJECT_DIR=/tmp/some-test-project bash -c '...same command...'
wc -l $TMP_HOME/.claude/claude-mem-projects.txt
# Expected: still 1 line (no duplicate)

# 5. Simulate reinstall — must not duplicate SessionStart entries
HOME=$TMP_HOME bash claude-code-integration/install.sh
cat $TMP_HOME/.claude/settings.json | python3 -c "import sys,json; s=json.load(sys.stdin); print(len(s['hooks']['SessionStart'][0]['hooks']))"
# Expected: 2 (not 4)
```

## 9. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | jq doesn't recognize escaped quotes in our complex bash command | jq treats the whole "command" string as opaque — no parsing. The shell escaping is what Claude Code's hook runner handles when spawning bash. Test in §8 step 2 confirms. |
| R2 | `mkdir -p ~/.claude` runs on every SessionStart — wasted call | ~1ms; trivial. Could optimize via `[ ! -f ... ] && mkdir...` but readability worse. Keep simple. |
| R3 | If `~/.claude/claude-mem-projects.txt` has a path with embedded whitespace, `grep -qxF` still works (whole line match) | No mitigation needed — grep -qxF is line-oriented |
| R4 | User has a custom SessionStart hook that includes `claude-mem-projects.txt` (unlikely but possible) | isOurs would now drop their entry on reinstall. Acceptable risk — string is specific enough. |
