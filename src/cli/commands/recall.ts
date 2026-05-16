/**
 * `claude-mem recall` — keyword search over L0 JSONL conversations.
 *
 * v0.1 design: simple case-insensitive substring search over recorded
 * turns in <dataDir>/conversations/. No LLM, no vector embedding, no
 * API key required. Returns the most recent matching turns first.
 *
 * v0.2 will replace the keyword path with TdaiCore.handleBeforeRecall
 * (vector + FTS hybrid via the embedding service); the same `runRecall`
 * signature and `--query / --limit` flags stay. Hooks (SessionStart,
 * UserPromptSubmit) only need the surface contract, not the impl.
 *
 * Output budget: total formatted text capped at MAX_OUTPUT_CHARS to fit
 * inside Claude Code's hook stdout → system-context injection budget.
 */

import fs from "node:fs";
import path from "node:path";

import { loadContextOrAutoInit } from "../context.js";
import { initStores, type PipelineLogger } from "../../utils/pipeline-factory.js";
import { runVectorRecall } from "./recall-vector.js";

const MAX_OUTPUT_CHARS = 4000;
const RECORD_SEPARATOR = "\n---\n";
const CONVERSATIONS_SUBDIR = "conversations";

export interface RunRecallOptions {
  projectRoot: string;
  /** Search query. Use '-' to read query from stdin (CLI integration). */
  query: string;
  /** Max number of matching turns to return. */
  limit: number;
  /** Auto-init missing .claude/memory/ on first use (hook scenario). */
  autoInit?: boolean;
  /** Platform tag — written into config on auto-init (e.g. "claude-code"). */
  platform?: string;
  /**
   * v0.3.2: semantic vector recall via Voyage + L1 records. Default true.
   * Set to false (CLI `--no-vector` flag) to force the v0.2 keyword path
   * (useful for debugging, no-key environments, or speed-critical UPS hooks).
   */
  vector?: boolean;
}

export interface RunRecallResult {
  ok: boolean;
  /** Formatted text suitable for stdout / hook injection. */
  text: string;
  /** Number of distinct matches returned. */
  matchCount: number;
  error?: string;
}

interface L0Message {
  sessionKey?: string;
  sessionId?: string;
  recordedAt?: string;
  id?: string;
  role?: string;
  content?: string;
  timestamp?: number;
}

export async function runRecall(opts: RunRecallOptions): Promise<RunRecallResult> {
  let ctx;
  try {
    ctx = await loadContextOrAutoInit({
      projectRoot: opts.projectRoot,
      autoInit: opts.autoInit,
      platform: opts.platform,
    });
  } catch (err) {
    return {
      ok: false,
      text: "",
      matchCount: 0,
      error: `recall: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const convDir = path.join(ctx.dataDir, CONVERSATIONS_SUBDIR);
  const rawQuery = (opts.query ?? "").trim();
  if (!rawQuery) {
    return { ok: true, text: "", matchCount: 0 };
  }
  const query = rawQuery.toLowerCase();

  // ── v0.3.2: try vector path first ──────────────────────────────────
  // Returns null on any fallback condition (no key, empty L1, degraded
  // store, embed failure, vector miss). Linear control flow per ADR-2.
  const vectorLines = await tryVectorPath(ctx, rawQuery, opts);
  if (vectorLines && vectorLines.length > 0) {
    const text = composeBounded(vectorLines, MAX_OUTPUT_CHARS);
    return { ok: true, text, matchCount: vectorLines.length };
  }

  // ── Keyword fallback (v0.2 behavior preserved) ────────────────────
  if (!fs.existsSync(convDir)) {
    return { ok: true, text: "", matchCount: 0 };
  }

  // Collect all JSONL files (newest by file name first — files are named
  // by date bucket YYYY-MM-DD.jsonl per upstream l0-recorder).
  const files = listJsonlFiles(convDir).sort().reverse();

  // Stream-read; group consecutive user/assistant pairs into a single
  // "turn" string for matching. Stop once we've collected `limit` matches
  // AND output budget reached.
  const matches: string[] = [];
  outer: for (const file of files) {
    const lines = safeReadLines(file);
    // Iterate newest-first within each file too
    let pendingUser: L0Message | undefined;
    const turns: Array<{ user: L0Message; assistant: L0Message }> = [];
    for (const line of lines) {
      const msg = safeParseLine(line);
      if (!msg) continue;
      if (msg.role === "user") {
        pendingUser = msg;
      } else if (msg.role === "assistant" && pendingUser) {
        turns.push({ user: pendingUser, assistant: msg });
        pendingUser = undefined;
      }
    }
    // Newest first within file
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i];
      const blob = `${t.user.content ?? ""}\n${t.assistant.content ?? ""}`.toLowerCase();
      if (blob.includes(query)) {
        matches.push(formatTurn(t.user, t.assistant));
        if (matches.length >= opts.limit) break outer;
      }
    }
  }

  // Compose output respecting MAX_OUTPUT_CHARS
  const text = composeBounded(matches, MAX_OUTPUT_CHARS);
  return { ok: true, text, matchCount: matches.length };
}

function listJsonlFiles(dir: string): string[] {
  const out: string[] = [];
  walk(dir, out);
  return out.filter((f) => f.endsWith(".jsonl"));

  function walk(d: string, acc: string[]): void {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, acc);
      else acc.push(full);
    }
  }
}

function safeReadLines(file: string): string[] {
  try {
    return fs.readFileSync(file, "utf-8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function safeParseLine(line: string): L0Message | undefined {
  try {
    return JSON.parse(line) as L0Message;
  } catch {
    return undefined;
  }
}

function formatTurn(user: L0Message, assistant: L0Message): string {
  const ts = user.recordedAt ?? "?";
  return `[${ts}]\nuser: ${user.content ?? ""}\nassistant: ${assistant.content ?? ""}`;
}

/**
 * v0.3.2: build a VectorRecallContext from the loaded CliContext and
 * call runVectorRecall. Returns null when vector path is unavailable
 * or has no results — caller falls back to keyword grep.
 *
 * Heavy lift (initStores) only happens when vector path is enabled
 * AND keys are present — avoids cold-start cost for users without Voyage.
 */
async function tryVectorPath(
  ctx: Awaited<ReturnType<typeof loadContextOrAutoInit>>,
  query: string,
  opts: RunRecallOptions,
): Promise<string[] | null> {
  // Cheap pre-checks first — avoid initStores cost when we'll bail anyway.
  if (opts.vector === false) return null;
  const apiKey = ctx.config.embedding?.apiKey?.trim() ?? "";
  if (!apiKey) return null;

  // ── Cheap pre-check: skip initStores cost when L1 is definitely empty.
  // initStores loads SQLite + builds embedding service (~1.7s on cold call).
  // If vectors.db doesn't exist OR is <50KB (schema-only, no rows), L1
  // has nothing to vector-search. Fall back immediately at keyword speed.
  // Measured impact: vector path on empty L1 drops from ~2s to ~50ms.
  const dbPath = path.join(ctx.dataDir, "vectors.db");
  try {
    const stat = fs.statSync(dbPath);
    if (stat.size < 50_000) {
      ctx.logger.debug?.(`recall: vectors.db too small (${stat.size}B), L1 unlikely populated; falling back to keyword`);
      return null;
    }
  } catch {
    // ENOENT etc. — no DB yet, no L1 to search
    return null;
  }

  const logger: PipelineLogger = {
    debug: (m) => ctx.logger.debug?.(m),
    info: (m) => ctx.logger.info(m),
    warn: (m) => ctx.logger.warn(m),
    error: (m) => ctx.logger.error(m),
  };

  let stores;
  try {
    stores = await initStores(ctx.config, ctx.dataDir, logger);
  } catch (err) {
    ctx.logger.warn(`recall: initStores failed, falling back to keyword: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  if (!stores.vectorStore || !stores.embeddingService) return null;

  const scoreThreshold = ctx.config.recall?.scoreThreshold ?? 0.3;

  return runVectorRecall(
    {
      apiKey,
      embeddingService: stores.embeddingService,
      vectorStore: stores.vectorStore,
      logger,
      scoreThreshold,
    },
    query,
    { limit: opts.limit, vector: opts.vector },
  );
}

function composeBounded(matches: string[], maxChars: number): string {
  if (matches.length === 0) return "";
  const out: string[] = [];
  let used = 0;
  for (const m of matches) {
    const next = (out.length === 0 ? m : RECORD_SEPARATOR + m);
    if (used + next.length > maxChars) {
      // Try a truncated tail of `next`
      const remaining = maxChars - used;
      if (remaining > 50) {
        // Worth emitting a truncated entry
        out.push(next.slice(0, remaining - 5) + "…");
      }
      break;
    }
    out.push(next);
    used += next.length;
  }
  return out.join("");
}
