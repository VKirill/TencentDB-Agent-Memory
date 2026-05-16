#!/usr/bin/env bash
# claude-mem stop-wrapper for Stop hook (session-end summary capture)
# Translates Claude Code's Stop envelope into capture's stdin shape.
#
# Claude Code stdin: { "session_id", "stop_hook_active", "transcript"?, ... }
# What capture expects: { user: string, assistant: string, metadata?: {...} }
#
# Translation:
#   user      = "session-end"
#   assistant = transcript if available, else "[session ended]"
#   metadata  = { sessionId, tags: ["session-summary"] }
#
# Synchronous (we want this to flush before Claude Code finalizes).
# Bounded by Claude Code's 10s hook budget.
#
# Exit 0 always.

set -u
read -ra CLAUDE_MEM_CMD <<< "${CLAUDE_MEM_BIN:-claude-mem}"

INPUT="$(cat 2>/dev/null || true)"

PAYLOAD="$(node -e '
let raw = "";
process.stdin.on("data", (d) => { raw += d; });
process.stdin.on("end", () => {
  let env = {};
  try { env = JSON.parse(raw); } catch { /* fall through */ }
  const sessionId = typeof env.session_id === "string" ? env.session_id : "";
  const transcript = typeof env.transcript === "string" ? env.transcript : "";
  const out = {
    user: "session-end",
    assistant: transcript || "[session ended]",
    metadata: { sessionId, tags: ["session-summary"] },
  };
  process.stdout.write(JSON.stringify(out));
});
' <<< "$INPUT" 2>/dev/null || echo "{}")"

printf '%s' "$PAYLOAD" | "${CLAUDE_MEM_CMD[@]}" --auto-init --platform claude-code capture >/dev/null 2>&1 || true
exit 0
