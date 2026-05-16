#!/usr/bin/env bash
# claude-mem global uninstaller
#
# Removes claude-mem hooks from ~/.claude/settings.json and deletes
# the wrapper directory. Preserves per-project .claude/memory/
# directories (your data — wipe manually if desired).
#
# Usage:  bash <path-to-pkg>/claude-code-integration/uninstall.sh

set -uo pipefail

SETTINGS_FILE="${CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"
HOOKS_DIR_DEFAULT="${CLAUDE_HOOKS_DIR:-$HOME/.claude/hooks/claude-mem}"

if ! command -v jq >/dev/null 2>&1; then
  echo "claude-mem uninstall: 'jq' is required." >&2
  exit 1
fi

# Read identity from the marker so we only remove what THIS package installed.
# Preserves coexisting v12.7.5 hooks etc. P2 fix from codex round 2:
# prior uninstall greped /claude-mem/i and could wipe unrelated hooks.
HOOKS_DIR="$HOOKS_DIR_DEFAULT"
BIN_PATH=""
if [[ -f "$SETTINGS_FILE" ]]; then
  MARKER_HOOKS=$(jq -r '._claude_mem_installed.hooksDir // empty' "$SETTINGS_FILE" 2>/dev/null || true)
  MARKER_BIN=$(jq -r '._claude_mem_installed.binPath // empty' "$SETTINGS_FILE" 2>/dev/null || true)
  if [[ -n "$MARKER_HOOKS" ]]; then HOOKS_DIR="$MARKER_HOOKS"; fi
  if [[ -n "$MARKER_BIN" ]]; then BIN_PATH="$MARKER_BIN"; fi
fi

# v0.3.1: warn user about PM2 process before removing scheduler.cjs.
# Allowlist file at ~/.claude/claude-mem-projects.txt is USER DATA — kept.
if command -v pm2 >/dev/null 2>&1 && pm2 list 2>/dev/null | grep -q claude-mem-scheduler; then
  echo "claude-mem uninstall: PM2 process 'claude-mem-scheduler' still registered."
  echo "claude-mem uninstall: → run 'pm2 delete claude-mem-scheduler && pm2 save' to clean up"
fi

# Remove wrapper dir (data dirs untouched).
if [[ -d "$HOOKS_DIR" ]]; then
  rm -rf "$HOOKS_DIR"
  echo "claude-mem uninstall: removed $HOOKS_DIR"
fi

# Strip claude-mem hook entries from settings.json — match by OUR paths only.
if [[ -f "$SETTINGS_FILE" ]]; then
  TMP=$(mktemp)
  trap 'rm -f "$TMP"' EXIT

  jq \
    --arg hooksDir "$HOOKS_DIR" \
    --arg binPath "$BIN_PATH" '
    def isOurs:
      .hooks // [] |
      all(
        . | (.command // "") |
        (contains($hooksDir)) or
        (($binPath | length > 0) and contains($binPath))
      );
    del(._claude_mem_installed) |
    # v0.4.2: remove both current and legacy MCP server keys
    del(.mcpServers["tencentdb-memory"]) |
    del(.mcpServers["claude-mem"]) |
    .hooks = (
      (.hooks // {}) |
      to_entries |
      map(
        .value = [
          .value[] |
          select(isOurs | not)
        ]
      ) |
      map(select(.value | length > 0)) |
      from_entries
    )
  ' "$SETTINGS_FILE" > "$TMP"

  if ! jq empty "$TMP" 2>/dev/null; then
    echo "claude-mem uninstall: jq produced invalid JSON; aborting" >&2
    exit 1
  fi

  jq . "$TMP" > "$SETTINGS_FILE"
  echo "claude-mem uninstall: cleaned $SETTINGS_FILE"
fi

echo "claude-mem uninstall: ✅ done."
echo ""
echo "Per-project memory dirs (.claude/memory/) NOT removed — wipe manually if desired."
echo "To uninstall the bin itself: npm uninstall -g @vkirill/tencentdb-agent-memory"
exit 0
