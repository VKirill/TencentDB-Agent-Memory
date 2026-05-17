/**
 * runVectorRecall — v0.3.2 vector recall path.
 *
 * Embeds the query via Voyage, searches l1_records via
 * vectorStore.searchL1Vector, formats matches. Returns null to signal
 * "fall back to keyword path" for ANY non-success condition:
 *   1. opts.vector === false       — user opt-out
 *   2. !ctx.apiKey                  — no Voyage key
 *   3. vectorStore.isDegraded()    — store init failed
 *   4. countL1 === 0                — no L1 data yet
 *   5. embed throws                 — Voyage API failure
 *   6. searchL1Vector returns []   — semantic miss (ADR-5)
 *
 * The 5-branch decision tree per ADR-2: 4 conditions known upfront,
 * 1 exception (#5). Linear happy path, no try/catch noise weaving.
 *
 * Caller (runRecall in recall.ts) interprets null as "use existing
 * keyword path" — guarantees v0.2 behavior preservation when vector
 * cannot or should not run.
 */

import type { Logger } from "../../core/types.js";
import { formatL1SearchResult } from "./recall-format.js";

/** Minimal L1 search hit shape — matches L1SearchResult subset we use. */
interface L1Hit {
  record_id: string;
  content: string;
  type: string;
  priority: number;
  scene_name: string;
  score: number;
  timestamp_str: string;
  timestamp_start: string;
  timestamp_end: string;
  session_key: string;
  session_id: string;
  metadata_json: string;
}

/** Test seam — extract.ts injects real instances; tests pass minimal mocks. */
export interface VectorRecallContext {
  apiKey: string;
  embeddingService: {
    embed: (text: string) => Promise<Float32Array>;
  };
  // Loosely typed to accept IMemoryStore (sync or Promise return per
  // MaybePromise type) AND simple test mocks (Promise-returning).
  vectorStore: {
    isDegraded: () => boolean;
    countL1: () => number | Promise<number>;
    searchL1Vector: (
      queryEmbedding: Float32Array,
      topK?: number,
      queryText?: string,
    ) =>
      | Promise<Array<L1Hit>>
      | Array<L1Hit>;
  };
  logger: Pick<Logger, "debug" | "info" | "warn" | "error">;
  /** Cosine similarity floor (per ADR-4, default 0.3 from cfg.recall.scoreThreshold). */
  scoreThreshold: number;
}

export interface VectorRecallOptions {
  limit: number;
  vector?: boolean;
}

export async function runVectorRecall(
  ctx: VectorRecallContext,
  query: string,
  opts: VectorRecallOptions,
): Promise<string[] | null> {
  // ── Branch 1: --no-vector opt-out (before any work) ────────────────
  if (opts.vector === false) {
    ctx.logger.debug?.("recall: vector disabled via --no-vector, falling back to keyword");
    return null;
  }

  // ── Branch 2: no apiKey → fallback ─────────────────────────────────
  if (!ctx.apiKey) {
    ctx.logger.debug?.("recall: no OPENAI_API_KEY (or VOYAGE_API_KEY), falling back to keyword");
    return null;
  }

  // ── Branch 3: store degraded → fallback ────────────────────────────
  if (ctx.vectorStore.isDegraded()) {
    ctx.logger.warn("recall: vector store degraded, falling back to keyword");
    return null;
  }

  // ── Branch 4: empty L1 (no extract has run yet) → fallback ────────
  const l1Count = await ctx.vectorStore.countL1();
  if (l1Count === 0) {
    ctx.logger.info("recall: L1 empty, falling back to keyword");
    return null;
  }

  // ── Embed query via Voyage (only branch with exception risk) ───────
  let queryEmbedding: Float32Array;
  try {
    queryEmbedding = await ctx.embeddingService.embed(query);
  } catch (err) {
    ctx.logger.warn(
      `recall: embedding failure, falling back to keyword: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  // ── Branch 5: vector miss (codex C1 / ADR-5) → fallback ────────────
  // topK = max(opts.limit, 5) per ADR-4; truncate to opts.limit after threshold filter.
  const topK = Math.max(opts.limit, 5);
  // searchL1Vector may return sync (IMemoryStore MaybePromise) or async.
  // `await` handles both safely.
  const raw = await Promise.resolve(ctx.vectorStore.searchL1Vector(queryEmbedding, topK, query));
  const filtered = raw.filter((r) => r.score >= ctx.scoreThreshold);
  if (filtered.length === 0) {
    ctx.logger.info(
      `recall: vector miss (${raw.length} hits below threshold ${ctx.scoreThreshold}), falling back to keyword`,
    );
    return null;
  }

  // ── Happy path: format up to opts.limit results ────────────────────
  const limited = filtered.slice(0, opts.limit);
  return limited.map((r) => formatL1SearchResult(r));
}
