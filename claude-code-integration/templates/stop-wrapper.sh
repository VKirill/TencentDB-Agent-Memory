#!/usr/bin/env bash
# claude-mem stop-wrapper for Stop hook (session-end summary capture).
#
# Claude Code Stop stdin: { session_id, stop_hook_active, transcript_path?, reason? }
# transcript_path → JSONL file, each line:
#   { type: "user"|"assistant"|"system"|..., message: { role, content }, ... }
# message.content is either a STRING or an ARRAY of content blocks:
#   { type: "text", text: "..." }       ← what we keep
#   { type: "tool_use", ... }           ← drop
#   { type: "tool_result", content: ... } ← drop
#   { type: "thinking", ... }           ← drop
#
# v0.2.0 BUG: prior version raw-tailed the JSONL file (4 KiB) → garbage
# tool_use/usage JSON in memory. v0.2.1 fix: parse properly, keep only
# `text` blocks from user/assistant messages, format human-readable.
#
# Exit 0 always.

set -u

# v0.3.0: source user's env file (set -a auto-exports each assignment).
if [ -f "$HOME/.claude/claude-mem.env" ]; then
  set -a
  . "$HOME/.claude/claude-mem.env"
  set +a
fi

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

  // Extract only the human-readable text exchange from the transcript.
  // Drop tool_use/tool_result/thinking/system blocks — those are noise
  // for long-term memory.
  function extractText(messageContent) {
    if (typeof messageContent === "string") return messageContent;
    if (!Array.isArray(messageContent)) return "";
    const parts = [];
    for (const block of messageContent) {
      if (block && block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
    return parts.join("\n").trim();
  }

  function parseTranscript(path) {
    let buf;
    try {
      buf = fs.readFileSync(path, "utf-8");
    } catch (err) {
      return { ok: false, err: String((err && err.message) || err) };
    }
    const lines = buf.split("\n");
    // Walk newest-first so we capture session tail (most relevant for
    // summary) within our 4 KiB budget. Then reverse so chronological.
    //
    // v0.2.2 cosmetic: use «U» / «A» marker prefixes instead of
    // "user:"/"assistant:" so the inner labels do not visually collide
    // with recall.ts outer "user: ... \nassistant: ..." wrapping
    // (which would otherwise produce "assistant: assistant: …").
    const turns = [];
    let budget = 4096;
    const marker = (r) => (r === "user" ? "«U» " : "«A» ");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      const msg = obj && obj.message;
      if (!msg) continue;
      const role = msg.role;
      if (role !== "user" && role !== "assistant") continue;
      const text = extractText(msg.content);
      if (!text) continue;
      const prefix = marker(role);
      const formatted = prefix + text;
      if (formatted.length >= budget) {
        turns.unshift(prefix + "…" + text.slice(-(budget - prefix.length - 1)));
        break;
      }
      budget -= formatted.length + 1; // +1 for newline separator
      turns.unshift(formatted);
      if (budget <= 0) break;
    }
    return { ok: true, text: turns.join("\n\n") };
  }

  let assistantText = "";
  // Test/dev fixtures may pass inline transcript (kept for back-compat)
  if (typeof env.transcript === "string" && env.transcript.length > 0) {
    assistantText = env.transcript;
  } else if (typeof env.transcript_path === "string" && env.transcript_path.length > 0) {
    const r = parseTranscript(env.transcript_path);
    if (r.ok) {
      assistantText = r.text;
    } else {
      assistantText = "[transcript_path unreadable: " + r.err + "]";
    }
  }
  if (!assistantText) {
    assistantText = reason || "[session ended — no transcript content]";
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
