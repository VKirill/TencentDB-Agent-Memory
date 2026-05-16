#!/usr/bin/env bash
# claude-mem capture-wrapper for PostToolUse hook
# Translates Claude Code's PostToolUse envelope into capture's stdin shape.
#
# Claude Code stdin: { "tool_name", "tool_input", "tool_response", "session_id", ... }
# What capture expects: { user: string, assistant: string, metadata?: {...} }
#
# Translation:
#   user      = JSON.stringify(tool_input)   — what the agent intended
#   assistant = JSON.stringify(tool_response) || "ok"
#   metadata  = { toolName, sessionId, tags: ["code-change"] }
#
# Backgrounded: hooks have 10s budget; capture writes JSONL <100ms typically
# but we still detach to guarantee a fast return.
#
# Exit 0 always.

set -u
read -ra CLAUDE_MEM_CMD <<< "${CLAUDE_MEM_BIN:-claude-mem}"

INPUT="$(cat 2>/dev/null || true)"

# Build capture payload via inline node — no jq dep.
PAYLOAD="$(node -e '
let raw = "";
process.stdin.on("data", (d) => { raw += d; });
process.stdin.on("end", () => {
  let env = {};
  try { env = JSON.parse(raw); } catch { /* fall through with empty env */ }
  const toolName = typeof env.tool_name === "string" ? env.tool_name : "unknown";
  const sessionId = typeof env.session_id === "string" ? env.session_id : "";
  const userText = env.tool_input != null ? JSON.stringify(env.tool_input) : "";
  // Real Claude Code PostToolUse payload field is `tool_result`. Older
  // builds and our test fixtures use `tool_response`. Accept both.
  const rawResult = env.tool_result != null
    ? env.tool_result
    : (env.tool_response != null ? env.tool_response : null);
  let assistantText = "ok";
  if (rawResult != null) {
    assistantText = typeof rawResult === "string"
      ? rawResult
      : JSON.stringify(rawResult);
  }
  const out = {
    user: userText,
    assistant: assistantText,
    metadata: { toolName, sessionId, tags: ["code-change"] },
  };
  process.stdout.write(JSON.stringify(out));
});
' <<< "$INPUT" 2>/dev/null || echo "{}")"

# Background the capture write — return fast.
( printf '%s' "$PAYLOAD" | "${CLAUDE_MEM_CMD[@]}" --auto-init --platform claude-code capture >/dev/null 2>&1 ) &
disown 2>/dev/null || true
exit 0
