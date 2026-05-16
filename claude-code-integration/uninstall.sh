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
HOOKS_DIR="${CLAUDE_HOOKS_DIR:-$HOME/.claude/hooks/claude-mem}"

if ! command -v jq >/dev/null 2>&1; then
  echo "claude-mem uninstall: 'jq' is required." >&2
  exit 1
fi

# Remove wrapper dir (data dirs untouched).
if [[ -d "$HOOKS_DIR" ]]; then
  rm -rf "$HOOKS_DIR"
  echo "claude-mem uninstall: removed $HOOKS_DIR"
fi

# Strip claude-mem hook entries from settings.json.
if [[ -f "$SETTINGS_FILE" ]]; then
  TMP=$(mktemp)
  trap 'rm -f "$TMP"' EXIT

  jq '
    del(._claude_mem_installed) |
    .hooks = (
      (.hooks // {}) |
      to_entries |
      map(
        .value = [
          .value[] |
          select(
            .hooks // [] |
            all(. | (.command // "") | test("claude-mem|/claude-mem/"; "i") | not)
          )
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
