/**
 * `claude-mem capture` — write a completed turn to L0 (JSONL store).
 *
 * Reads a JSON object on stdin: { user: string, assistant: string,
 * metadata?: { sessionId?, sessionKey?, tags?, toolName?, projectPath? } }.
 *
 * Writes to <projectRoot>/.claude/memory/conversations/<dateBucket>/...
 * via upstream `recordConversation()`. Does NOT invoke any LLM — the
 * L1/L2/L3 extraction pipeline runs separately (background scheduler
 * in v0.2; recall-triggered or explicit `claude-mem pipeline` in v0.1).
 *
 * Exit discipline: returns {ok, l0Recorded, error?} and never throws.
 * The CLI wrapper exits 0 always.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { loadContextOrAutoInit } from "../context.js";
import { recordConversation } from "../../core/conversation/l0-recorder.js";

export interface CaptureStdinPayload {
  user: string;
  assistant: string;
  metadata?: {
    sessionKey?: string;
    sessionId?: string;
    tags?: string[];
    toolName?: string;
    projectPath?: string;
  };
}

export interface RunCaptureOptions {
  /** Project root — typically process.cwd(). */
  projectRoot: string;
  /** Pre-resolved stdin contents (test-friendly). If omitted, read from process.stdin. */
  stdin?: string;
  /**
   * When true and the project's .claude/memory/config.json is missing,
   * bootstrap it silently before proceeding. Used by Claude Code hooks
   * (--auto-init flag) so first SessionStart in a fresh project works
   * without manual `claude-mem init`.
   */
  autoInit?: boolean;
  /** Platform tag — written into config on auto-init (e.g. "claude-code"). */
  platform?: string;
}

export interface RunCaptureResult {
  ok: boolean;
  /** Number of L0 messages written (user + assistant typically = 2). */
  l0Recorded: number;
  error?: string;
}

const DEFAULT_SESSION_KEY = "default";

export async function runCapture(opts: RunCaptureOptions): Promise<RunCaptureResult> {
  let ctx;
  try {
    ctx = await loadContextOrAutoInit({
      projectRoot: opts.projectRoot,
      autoInit: opts.autoInit,
      platform: opts.platform,
    });
  } catch (err) {
    // No config — we can't write to <dataDir>/conversations
    return {
      ok: false,
      l0Recorded: 0,
      error: `capture: cannot load context: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Read stdin (with OOM cap — see readStdin)
  let stdinRaw: string;
  try {
    stdinRaw = opts.stdin !== undefined ? opts.stdin : await readStdin();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.logger.error(msg);
    return { ok: false, l0Recorded: 0, error: msg };
  }

  let payload: CaptureStdinPayload;
  try {
    payload = JSON.parse(stdinRaw) as CaptureStdinPayload;
  } catch (err) {
    const msg = `capture: failed to parse stdin JSON: ${err instanceof Error ? err.message : String(err)}`;
    ctx.logger.error(msg);
    return { ok: false, l0Recorded: 0, error: msg };
  }

  if (typeof payload?.user !== "string" || typeof payload?.assistant !== "string") {
    const msg = `capture: stdin must be { user: string, assistant: string, metadata?: ... }`;
    ctx.logger.error(msg);
    return { ok: false, l0Recorded: 0, error: msg };
  }

  const sessionKey = payload.metadata?.sessionKey ?? DEFAULT_SESSION_KEY;
  const sessionId = payload.metadata?.sessionId;

  // Dedup: skip write if the last captured pair in today's JSONL is identical.
  const isDup = await isIdenticalToLastCapture({
    dataDir: ctx.dataDir,
    sessionKey,
    userContent: payload.user,
    assistantContent: payload.assistant,
  });
  if (isDup) {
    ctx.logger.debug?.("[capture] dedup skip — identical to last record");
    return { ok: true, l0Recorded: 0 };
  }

  const nowMs = Date.now();
  const rawMessages: unknown[] = [
    { role: "user", content: payload.user, timestamp: nowMs },
    { role: "assistant", content: payload.assistant, timestamp: nowMs + 1 },
  ];

  try {
    const written = await recordConversation({
      sessionKey,
      sessionId,
      rawMessages,
      baseDir: ctx.dataDir,
      logger: {
        info: (m) => ctx.logger.info(m),
        warn: (m) => ctx.logger.warn(m),
        error: (m) => ctx.logger.error(m),
        debug: (m) => ctx.logger.debug?.(m),
      },
      originalUserText: payload.user,
    });

    return { ok: true, l0Recorded: written.length };
  } catch (err) {
    const msg = `capture: recordConversation failed: ${err instanceof Error ? err.message : String(err)}`;
    ctx.logger.error(msg);
    return { ok: false, l0Recorded: 0, error: msg };
  }
}

// ── Dedup helper ────────────────────────────────────────────────────────────

/**
 * Format a Date as YYYY-MM-DD using local time — matches l0-recorder's
 * formatLocalDate scheme so we read the correct daily shard file.
 */
function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Returns true if the last user+assistant pair already stored in today's JSONL
 * file for this sessionKey is byte-for-byte identical to the incoming payload.
 * Any I/O error is treated as non-duplicate (safe: worst case we write a dupe,
 * never silently skip a novel turn).
 */
async function isIdenticalToLastCapture(opts: {
  dataDir: string;
  sessionKey: string;
  userContent: string;
  assistantContent: string;
}): Promise<boolean> {
  const todayPath = path.join(
    opts.dataDir,
    "conversations",
    `${formatLocalDate(new Date())}.jsonl`,
  );

  let raw: string;
  try {
    raw = await fs.readFile(todayPath, "utf-8");
  } catch {
    // File absent or unreadable — no prior record, not a duplicate.
    return false;
  }

  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return false;

  // Walk backwards to find the last assistant record for this sessionKey,
  // then look for the preceding user record with the same sessionKey.
  let lastAssistantContent: string | undefined;
  let lastAssistantIndex = -1;

  for (let i = lines.length - 1; i >= 0; i--) {
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(lines[i]) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (
      rec.sessionKey === opts.sessionKey &&
      rec.role === "assistant" &&
      typeof rec.content === "string"
    ) {
      lastAssistantContent = rec.content;
      lastAssistantIndex = i;
      break;
    }
  }

  if (lastAssistantContent === undefined || lastAssistantIndex < 0) return false;

  // Scan backwards from the assistant record for the preceding user record.
  let lastUserContent: string | undefined;
  for (let i = lastAssistantIndex - 1; i >= 0; i--) {
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(lines[i]) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (
      rec.sessionKey === opts.sessionKey &&
      rec.role === "user" &&
      typeof rec.content === "string"
    ) {
      lastUserContent = rec.content;
      break;
    }
  }

  if (lastUserContent === undefined) return false;

  return lastUserContent === opts.userContent && lastAssistantContent === opts.assistantContent;
}

// ── Stdin reader ─────────────────────────────────────────────────────────────

/** Max stdin size for capture payload (8 MiB). Larger inputs are rejected
 *  to prevent OOM from runaway or malicious producers. A single turn
 *  shouldn't exceed a few KB in practice. */
const MAX_STDIN_BYTES = 8 * 1024 * 1024;

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += b.length;
    if (total > MAX_STDIN_BYTES) {
      throw new Error(
        `capture: stdin payload too large (>${MAX_STDIN_BYTES} bytes). ` +
        `Refusing to read further to avoid OOM.`,
      );
    }
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString("utf-8");
}
