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

import { loadContext } from "../context.js";
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
    ctx = await loadContext({ projectRoot: opts.projectRoot });
  } catch (err) {
    // No config — we can't write to <dataDir>/conversations
    return {
      ok: false,
      l0Recorded: 0,
      error: `capture: cannot load context: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Read stdin
  const stdinRaw = opts.stdin !== undefined ? opts.stdin : await readStdin();

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

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString("utf-8");
}
