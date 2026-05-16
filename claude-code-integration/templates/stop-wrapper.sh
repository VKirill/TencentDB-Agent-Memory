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
const fs = require("fs");
let raw = "";
process.stdin.on("data", (d) => { raw += d; });
process.stdin.on("end", () => {
  let env = {};
  try { env = JSON.parse(raw); } catch { /* fall through */ }
  const sessionId = typeof env.session_id === "string" ? env.session_id : "";
  const reason = typeof env.reason === "string" ? env.reason : "";

  // Real Claude Code Stop payload: { session_id, stop_hook_active,
  // transcript_path?, reason? }. Test fixtures may use inline `transcript`.
  // Resolution order: inline transcript → read from transcript_path → reason → fallback.
  let assistantText = "";
  if (typeof env.transcript === "string" && env.transcript.length > 0) {
    assistantText = env.transcript;
  } else if (typeof env.transcript_path === "string" && env.transcript_path.length > 0) {
    try {
      const buf = fs.readFileSync(env.transcript_path, "utf-8");
      // Cap at 4 KiB tail — sessions can be huge, L0 stays human-readable.
      assistantText = buf.length > 4096 ? "…" + buf.slice(-4096) : buf;
    } catch {
      assistantText = `[transcript_path unreadable: ${env.transcript_path}]`;
    }
  }
  if (!assistantText) {
    assistantText = reason || "[session ended]";
  }

  const out = {
    user: "session-end",
    assistant: assistantText,
    metadata: { sessionId, reason, tags: ["session-summary"] },
  };
  process.stdout.write(JSON.stringify(out));
});
' <<< "$INPUT" 2>/dev/null || echo "{}")"

printf '%s' "$PAYLOAD" | "${CLAUDE_MEM_CMD[@]}" --auto-init --platform claude-code capture >/dev/null 2>&1 || true
exit 0
