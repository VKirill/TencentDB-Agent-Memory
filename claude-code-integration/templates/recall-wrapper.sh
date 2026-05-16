#!/usr/bin/env bash
# claude-mem recall-wrapper
# Translates Claude Code's UserPromptSubmit hook stdin envelope into a
# plain query string and pipes to `claude-mem recall --query -`.
#
# Claude Code stdin shape: { "user_prompt": "...", "session_id": "...", ... }
# What recall expects:     stdin = the literal query text.
#
# Why a wrapper: we never want recall (a generic library command) to know
# about Claude Code's envelope. The wrapper is the seam.
#
# Exit 0 always — hooks must never block the user.

set -u
# v0.3.0: source user's env file (set -a auto-exports each assignment).
# Pattern works in bash 3.2+ and dash. Brings OPENROUTER_API_KEY +
# VOYAGE_API_KEY into the subprocess Claude Code spawns.
if [ -f "$HOME/.claude/claude-mem.env" ]; then
  set -a
  . "$HOME/.claude/claude-mem.env"
  set +a
fi

# Split CLAUDE_MEM_BIN on whitespace so "node /path/bin.mjs" works in dev
# while a single absolute path (production install.sh output) also works.
read -ra CLAUDE_MEM_CMD <<< "${CLAUDE_MEM_BIN:-claude-mem}"

# Read all of stdin (small JSON, bounded by Claude Code's hook contract).
INPUT="$(cat 2>/dev/null || true)"

# Extract user_prompt via inline node — no jq dep. Empty string on parse failure.
QUERY="$(node -e '
let raw = "";
process.stdin.on("data", (d) => { raw += d; });
process.stdin.on("end", () => {
  try {
    const p = JSON.parse(raw);
    const q = p && typeof p.user_prompt === "string" ? p.user_prompt : "";
    process.stdout.write(q);
  } catch { process.stdout.write(""); }
});
' <<< "$INPUT" 2>/dev/null || true)"

# Pipe query to recall. recall exits 0 even on missing query.
printf '%s' "$QUERY" | "${CLAUDE_MEM_CMD[@]}" --auto-init --platform claude-code recall --query - --limit 3 || true
exit 0
