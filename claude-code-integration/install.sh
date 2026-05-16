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
HOOKS_DIR="${CLAUDE_HOOKS_DIR:-$HOME/.claude/hooks/claude-mem}"
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

CLAUDE_MEM_BIN="$(command -v claude-mem || true)"
if [[ -z "$CLAUDE_MEM_BIN" ]]; then
  echo "claude-mem install: 'claude-mem' bin not found on PATH." >&2
  echo "  Install first: npm i -g github:VKirill/TencentDB-Agent-Memory" >&2
  exit 1
fi
echo "claude-mem install: using bin = $CLAUDE_MEM_BIN"

mkdir -p "$(dirname "$SETTINGS_FILE")"
mkdir -p "$HOOKS_DIR"

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
      (contains($hooksDir)) or (contains($binPath))
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
echo "claude-mem install: ✅ done. Start a new Claude Code session to activate hooks."
exit 0
