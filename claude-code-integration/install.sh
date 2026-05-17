#!/usr/bin/env bash
# claude-mem global install.sh
#
# Installs claude-mem hooks into ~/.claude/settings.json (Claude Code's
# global settings) and copies 3 wrappers to ~/.claude/hooks/claude-mem/.
# Idempotent: re-run safely upgrades existing hooks.
#
# Usage:
#   bash <path-to-pkg>/claude-code-integration/install.sh
#   bash ... install.sh --force          # overwrite duplicate-matcher hooks
#   bash ... install.sh --allow-coexist  # ignore claude-mem v12.7.5 conflict
#
# Requires: jq (hard dep, install-time only), node (already required for
#           claude-mem itself).
#
# Exit codes:
#   0 — success or no-op (idempotent re-run)
#   1 — bin not found, jq missing, conflicting v12.7.5 hooks present

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEMPLATES_DIR="$SCRIPT_DIR/templates"
SETTINGS_FILE="${CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"
HOOKS_DIR="${CLAUDE_HOOKS_DIR:-$HOME/.claude/hooks/tencentdb-memory}"
LEGACY_HOOKS_DIR="$HOME/.claude/hooks/claude-mem"
# Read version dynamically from package.json so install.sh and package
# stay in sync without manual bumping (v0.2.1 fix).
PKG_JSON="$SCRIPT_DIR/../package.json"
if [[ -f "$PKG_JSON" ]]; then
  VERSION="$(node -e "process.stdout.write(require('$PKG_JSON').version || '0.0.0')" 2>/dev/null || echo "0.0.0")"
else
  VERSION="0.0.0"
fi

FORCE=0
ALLOW_COEXIST=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --allow-coexist) ALLOW_COEXIST=1 ;;
    -h|--help)
      sed -n '2,16p' "$0"
      exit 0
      ;;
    *) echo "claude-mem install: unknown arg '$arg'" >&2; exit 1 ;;
  esac
done

# ── Preflight ────────────────────────────────────────────────────────

if ! command -v jq >/dev/null 2>&1; then
  echo "claude-mem install: 'jq' is required but not installed." >&2
  echo "  Ubuntu/Debian: sudo apt install jq" >&2
  echo "  macOS:         brew install jq" >&2
  exit 1
fi

CLAUDE_MEM_BIN="${CLAUDE_MEM_BIN:-$(command -v tencentdb-mem || true)}"
if [[ -z "$CLAUDE_MEM_BIN" ]]; then
  echo "claude-mem install: 'tencentdb-mem' bin not found on PATH." >&2
  echo "  Install first: npm i -g github:VKirill/TencentDB-Memory-Claude-Code#v0.5.2" >&2
  exit 1
fi
echo "claude-mem install: using bin = $CLAUDE_MEM_BIN"

mkdir -p "$(dirname "$SETTINGS_FILE")"
mkdir -p "$HOOKS_DIR"

# ── v0.5.0: migrate old 'claude-mem' binary references → 'tencentdb-mem' ─
# Must run BEFORE conflict detection so the guard doesn't mistake our own
# v0.4.x hook paths for the foreign claude-mem v12.7.5 tool.
if [ -f "$SETTINGS_FILE" ]; then
  if grep -q '/claude-mem' "$SETTINGS_FILE" 2>/dev/null; then
    sed -i.bak.before-v0.5.0 's|/claude-mem |/tencentdb-mem |g; s|/claude-mem"|/tencentdb-mem"|g' "$SETTINGS_FILE"
    echo "claude-mem install: migrated settings.json hook commands from claude-mem → tencentdb-mem"
  fi
fi
node -e '
const fs = require("node:fs");
const p = "'"$HOME"'/.claude.json";
if (!fs.existsSync(p)) process.exit(0);
let s;
try { s = JSON.parse(fs.readFileSync(p, "utf-8")); } catch { process.exit(0); }
const tdm = s.mcpServers && s.mcpServers["tencentdb-memory"];
if (tdm && tdm.command && tdm.command.endsWith("/claude-mem")) {
  tdm.command = tdm.command.replace(/\/claude-mem$/, "/tencentdb-mem");
  const tmp = p + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, p);
  console.log("claude-mem install: migrated ~/.claude.json MCP command to tencentdb-mem");
}
'

# ── v0.5.1: migrate hooks directory claude-mem → tencentdb-memory ────
# The hook folder name on disk used to be `claude-mem/` for historical
# reasons. v0.5.1 aligns it with the package identity. We migrate
# transparently so existing installs do not end up with two parallel
# folders. The CLAUDE_HOOKS_DIR env override still wins over both.
if [[ -d "$LEGACY_HOOKS_DIR" && ! -d "$HOOKS_DIR" && -z "${CLAUDE_HOOKS_DIR:-}" ]]; then
  mv "$LEGACY_HOOKS_DIR" "$HOOKS_DIR"
  echo "claude-mem install: migrated $LEGACY_HOOKS_DIR → $HOOKS_DIR"
fi
# Rewrite any hook-path references in settings.json so they point at the
# new directory. Idempotent: no-op if already pointing at tencentdb-memory.
if [[ -f "$SETTINGS_FILE" ]] && grep -q "hooks/claude-mem/" "$SETTINGS_FILE" 2>/dev/null; then
  sed -i.bak.before-v0.5.1 's|hooks/claude-mem/|hooks/tencentdb-memory/|g' "$SETTINGS_FILE"
  echo "claude-mem install: rewrote settings.json hook paths claude-mem → tencentdb-memory"
fi

# ── Conflict detection: claude-mem v12.7.5 ───────────────────────────

if [[ -f "$SETTINGS_FILE" ]]; then
  # Look for any "claude-mem" string in settings.json that isn't our marker.
  EXISTING_REF=$(jq -r '
    .hooks // {} | [..|strings? | select(test("claude-mem"; "i"))] | length
  ' "$SETTINGS_FILE" 2>/dev/null || echo 0)
  # Marker is now an object (v0.2.0+) but may be a legacy string from v0.2.0-dev.
  EXISTING_MARKER=$(jq -r '
    if has("_claude_mem_installed") then 1 else 0 end
  ' "$SETTINGS_FILE" 2>/dev/null || echo 0)

  if [[ "$EXISTING_REF" -gt 0 ]] && [[ "$EXISTING_MARKER" -eq 0 ]] && [[ "$ALLOW_COEXIST" -eq 0 ]]; then
    echo "claude-mem install: detected existing 'claude-mem' references in $SETTINGS_FILE" >&2
    echo "  Looks like claude-mem v12.7.5 (or another claude-mem flavor) is already wired." >&2
    echo "  Pass --allow-coexist to merge anyway (both will run in parallel)." >&2
    exit 1
  fi
fi

# ── Copy wrappers + bake CLAUDE_MEM_BIN default + chmod +x ──────────
#
# Wrappers fall back to bare `claude-mem` when $CLAUDE_MEM_BIN is unset.
# Claude Code spawn shells may have an empty / minimal PATH, so we bake
# the resolved absolute bin into each copied wrapper as the default.
# P1 fix from codex round 2 — round 1 finding addressed: hooks would
# silently fail in non-interactive shells.

# Escape the bin path for safe use in sed RHS (only / and & need escaping
# when delimiter is |). Single quotes preserved literally — bash heredoc
# below uses double quotes for the wrapper variable expansion.
BIN_ESC="$(printf '%s' "$CLAUDE_MEM_BIN" | sed 's/[|&]/\\&/g')"

# v0.2.1: PostToolUse hook removed from template — tool envelopes
# captured as opaque JSON noise, not human-readable memory.
# capture-wrapper.sh kept in repo for future v0.3 reuse but NOT installed.
for w in recall-wrapper.sh stop-wrapper.sh; do
  src="$TEMPLATES_DIR/$w"
  if [[ ! -f "$src" ]]; then
    echo "claude-mem install: missing wrapper template $src" >&2
    exit 1
  fi
  # Substitute the default for CLAUDE_MEM_BIN — keep env override possible
  # (the read-into-array still picks up an exported CLAUDE_MEM_BIN).
  sed "s|CLAUDE_MEM_BIN:-claude-mem|CLAUDE_MEM_BIN:-${BIN_ESC}|g" "$src" > "$HOOKS_DIR/$w"
  chmod +x "$HOOKS_DIR/$w"
done

# Cleanup stale v0.2.0 capture-wrapper if upgrading.
if [[ -f "$HOOKS_DIR/capture-wrapper.sh" ]]; then
  rm -f "$HOOKS_DIR/capture-wrapper.sh"
  echo "claude-mem install: removed stale capture-wrapper.sh (v0.2.0 → v0.2.1 cleanup)"
fi

echo "claude-mem install: wrappers installed to $HOOKS_DIR (with bin baked)"

# ── v0.4.3: MCP server registration in ~/.claude.json (correct file) ─
# v0.4.0-v0.4.2 BUG: wrote to ~/.claude/settings.json (hooks-only file).
# The canonical MCP registry Claude Code reads is ~/.claude.json (HOME root).
# This block: (a) writes to ~/.claude.json atomically, (b) removes stale
# entries from ~/.claude/settings.json (botched v0.4.0-v0.4.2 installs).
BIN_PATH="$CLAUDE_MEM_BIN"
CLAUDE_JSON="$HOME/.claude.json"
LEGACY_SETTINGS="$HOME/.claude/settings.json"

register_mcp_entry() {
  node -e '
const fs = require("node:fs");
const binPath = "'"$BIN_PATH"'";
const targetFile = "'"$CLAUDE_JSON"'";
const legacyFiles = [
  "'"$LEGACY_SETTINGS"'",
];

// 1. Atomic write helper
function atomicWrite(p, obj) {
  const tmp = p + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}

// 2. Read or initialize ~/.claude.json (preserve all other keys + mcpServers)
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
}

# ── v0.3.0: env file for OPENROUTER_API_KEY / VOYAGE_API_KEY ────────
# Wrappers `set -a; . $HOME/.claude/claude-mem.env; set +a` if file exists.
# We create it from template (mode 0600) ONLY if absent — never overwrite
# user's existing keys.
ENV_FILE="${CLAUDE_MEM_ENV_FILE:-$HOME/.claude/claude-mem.env}"
ENV_TEMPLATE="$TEMPLATES_DIR/claude-mem.env.example"
if [[ ! -f "$ENV_FILE" ]]; then
  if [[ -f "$ENV_TEMPLATE" ]]; then
    cp "$ENV_TEMPLATE" "$ENV_FILE"
    chmod 0600 "$ENV_FILE"
    echo "claude-mem install: created env file at $ENV_FILE (mode 0600)"
    echo "claude-mem install: → edit it and add OPENROUTER_API_KEY=... OPENAI_API_KEY=..."
    echo "claude-mem install: → then 'claude-mem extract' (v0.3.0+) can call the LLM pipeline"
  else
    echo "claude-mem install: env template missing ($ENV_TEMPLATE) — skipping env file creation" >&2
  fi
else
  echo "claude-mem install: env file already at $ENV_FILE (unchanged)"
fi

# ── v0.3.1: scheduler.cjs + allowlist + PM2 instructions ────────────
# Auto-extract daemon. We copy the script but do NOT auto-start PM2 —
# user opts in explicitly. Allowlist starts empty (user adds projects).
SCHEDULER_SRC="$SCRIPT_DIR/scheduler.cjs"
SCHEDULER_DST="$HOOKS_DIR/scheduler.cjs"
ALLOWLIST_FILE="${CLAUDE_MEM_ALLOWLIST:-$HOME/.claude/claude-mem-projects.txt}"
ALLOWLIST_TEMPLATE="$TEMPLATES_DIR/claude-mem-projects.txt.example"

if [[ -f "$SCHEDULER_SRC" ]]; then
  cp "$SCHEDULER_SRC" "$SCHEDULER_DST"
  chmod 0755 "$SCHEDULER_DST"
  echo "claude-mem install: scheduler installed at $SCHEDULER_DST"
fi

if [[ ! -f "$ALLOWLIST_FILE" ]]; then
  if [[ -f "$ALLOWLIST_TEMPLATE" ]]; then
    cp "$ALLOWLIST_TEMPLATE" "$ALLOWLIST_FILE"
  else
    : > "$ALLOWLIST_FILE"  # empty file
  fi
  chmod 0644 "$ALLOWLIST_FILE"
  echo "claude-mem install: created allowlist at $ALLOWLIST_FILE"
  echo "claude-mem install: → add project paths (one absolute per line) to opt them in"
fi

if command -v pm2 >/dev/null 2>&1 && [[ -f "$SCHEDULER_DST" ]]; then
  RUNNING=$(pm2 jlist 2>/dev/null | node -e \
    'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const a=JSON.parse(s);process.stdout.write(a.some(p=>p.name==="tencentdb-memory-scheduler")?"1":"0")}catch{process.stdout.write("0")}})' \
    2>/dev/null || echo "0")
  if [[ "$RUNNING" == "1" ]]; then
    echo ""
    echo "claude-mem install: scheduler already running in pm2, skipping start"
  else
    echo ""
    set +e
    PM2_ERR=$(pm2 start "$SCHEDULER_DST" --name tencentdb-memory-scheduler 2>&1)
    PM2_RC=$?
    set -e
    if [[ $PM2_RC -ne 0 ]]; then
      echo "claude-mem install: pm2 start failed (exit $PM2_RC): $PM2_ERR" >&2
      echo "  manual fallback: pm2 start $SCHEDULER_DST --name tencentdb-memory-scheduler && pm2 save"
    else
      pm2 save >/dev/null 2>&1 || true
      echo "claude-mem install: scheduler started via pm2 (tencentdb-memory-scheduler)"
      echo "  logs: pm2 logs tencentdb-memory-scheduler"
    fi
  fi
  echo "claude-mem install: for boot persistence run: pm2 startup  (requires sudo, writes systemd unit)"
elif command -v pm2 >/dev/null 2>&1; then
  echo ""
  echo "claude-mem install: to start auto-extract daemon (every 30 min):"
  echo "  pm2 start $SCHEDULER_DST --name tencentdb-memory-scheduler"
  echo "  pm2 save"
  echo "  # logs: pm2 logs tencentdb-memory-scheduler"
else
  echo ""
  echo "claude-mem install: pm2 NOT found — install it to enable auto-extract:"
  echo "  npm i -g pm2"
  echo "  pm2 start $SCHEDULER_DST --name tencentdb-memory-scheduler && pm2 save"
fi

# ── Resolve template placeholders ────────────────────────────────────

TPL="$TEMPLATES_DIR/settings.json.template"
RESOLVED_TPL=$(mktemp)
trap 'rm -f "$RESOLVED_TPL"' EXIT

# Escape & for sed; substitute placeholders.
sed \
  -e "s|<ABS_BIN>|$CLAUDE_MEM_BIN|g" \
  -e "s|<WRAPPER_DIR>|$HOOKS_DIR|g" \
  -e "s|<VERSION>|$VERSION|g" \
  "$TPL" > "$RESOLVED_TPL"

# Validate the resolved template is valid JSON
if ! jq empty "$RESOLVED_TPL" 2>/dev/null; then
  echo "claude-mem install: resolved template is not valid JSON" >&2
  exit 1
fi

# ── Merge into settings.json ─────────────────────────────────────────

if [[ ! -f "$SETTINGS_FILE" ]]; then
  cp "$RESOLVED_TPL" "$SETTINGS_FILE"
  echo "claude-mem install: created $SETTINGS_FILE"
  register_mcp_entry
  echo "claude-mem install: ✅ done. Start a new Claude Code session to activate hooks."
  exit 0
fi

# Deep-merge with dedup by (event, matcher) tuple for hooks.
# For each event in the template, append entries whose matcher isn't
# already present in the user's settings (unless --force).
MERGED=$(mktemp)
trap 'rm -f "$RESOLVED_TPL" "$MERGED"' EXIT

# Build the merged JSON via jq.
# Merge rule:
#   - If --allow-coexist: PRESERVE every existing entry verbatim, just
#     append our new entries (both claude-mem flavors run in parallel).
#   - Otherwise: filter out only entries that match THIS version's
#     wrapper path (our prior install) so re-runs upgrade cleanly without
#     touching other claude-mem variants. (Conflict detection above has
#     already refused the install if non-marker claude-mem hooks were
#     found without --allow-coexist.)
HOOKS_DIR_ESCAPED="$(printf '%s' "$HOOKS_DIR" | sed 's/[\/&]/\\&/g')"
jq \
  --slurpfile new "$RESOLVED_TPL" \
  --arg hooksDir "$HOOKS_DIR" \
  --arg binPath "$CLAUDE_MEM_BIN" '
  . as $existing |
  ($new[0]._claude_mem_installed) as $newMarker |
  (
    ($existing.hooks // {}) as $eh |
    ($new[0].hooks // {}) as $nh |
    [($eh|keys_unsorted), ($nh|keys_unsorted)] | add | unique
  ) as $events |
  # An entry counts as "ours" iff EVERY hook command in it references our
  # wrapper dir OR our resolved bin. SessionStart command uses bin
  # directly; other 3 use wrapper dir. P2 fix codex round 2: prior
  # filter only matched wrapperDir → SessionStart duplicated on reinstall.
  def isOurs:
    .hooks // [] |
    all(
      . | (.command // "") |
      (contains($hooksDir))
      or (contains($binPath))
      or (contains("claude-mem-projects.txt"))
    );
  $existing
  | ._claude_mem_installed = $newMarker
  | .hooks = (
      reduce $events[] as $evt ({};
        . + {
          ($evt): (
            (($existing.hooks // {})[$evt] // []) as $existingEntries |
            (($new[0].hooks // {})[$evt] // []) as $newEntries |
            (
              [
                $existingEntries[]
                # Always drop OUR own entries (so re-runs upgrade, never
                # duplicate). --allow-coexist only spares foreign claude-mem
                # entries — it does NOT spare our own.
                | select(isOurs | not)
              ] as $keptExisting |
              $keptExisting + $newEntries
            )
          )
        }
      )
    )
' "$SETTINGS_FILE" > "$MERGED"

if ! jq empty "$MERGED" 2>/dev/null; then
  echo "claude-mem install: merge produced invalid JSON; aborting" >&2
  exit 1
fi

# Pretty-print final settings.
jq . "$MERGED" > "$SETTINGS_FILE"

echo "claude-mem install: merged into $SETTINGS_FILE"
register_mcp_entry
echo "claude-mem install: ✅ done. Start a new Claude Code session to activate hooks."
exit 0
