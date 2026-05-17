/**
 * `claude-mem extract` — run the L1 LLM extraction pipeline over accumulated
 * L0 turns. Manually-triggerable batch command. Idempotent (cursor-based).
 *
 * v0.3.0 scope: L1 only. L2/L3 deferred. Uses pipeline-factory primitives
 * directly (initStores + createL1Runner) instead of full TdaiCore wiring —
 * cleaner test seam and avoids TdaiCore's openclaw-branch surface.
 *
 * Drain loop: per sessionKey, repeatedly call wired L1 runner until
 * processedCount===0. Upstream readConversationMessagesGroupedBySessionId
 * caps each batch at 50; without draining, sessions with >50 unextracted
 * turns leak data permanently (P1 fix from codex review round 2).
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { loadContextOrAutoInit } from "../context.js";
import {
  initDataDirectories,
  initStores,
  createL1Runner,
  type PipelineLogger,
} from "../../utils/pipeline-factory.js";
import { StandaloneLLMRunnerFactory } from "../../adapters/standalone/llm-runner.js";
import type { LLMRunner } from "../../core/types.js";
import type { IMemoryStore, L0Record } from "../../core/store/types.js";
import type { L2Runner, L3Runner } from "../../utils/pipeline-manager.js";
import { CheckpointManager } from "../../utils/checkpoint.js";
import { buildL2L3Runners } from "./extract-l2l3-wiring.js";

const CONVERSATIONS_SUBDIR = "conversations";
/** Hard safety cap on per-session drain iterations (50 iters × 50 turns/iter = 2500 L0 turns per session). */
const DRAIN_HARD_CAP = 50;

/** Function signature exactly matching what `createL1Runner` returns. Used to inject a fake in tests. */
export type L1RunnerFn = (params: { sessionKey: string }) => Promise<{ processedCount: number }>;

/** Test seam: identical shape to `createL2Runner` return value (v0.3.3 Task 6). */
export type L2RunnerFn = L2Runner;

/** Test seam: identical shape to `createL3Runner` return value (v0.3.3 Task 6). */
export type L3RunnerFn = L3Runner;

export interface RunExtractOptions {
  /** Project root — typically process.cwd(). */
  projectRoot: string;
  /** If true, enumerate sessionKeys but do NOT call the L1 runner. */
  dryRun?: boolean;
  /**
   * Hard cap on number of sessions processed in one extract run.
   * 0 = no cap. Default: 0.
   */
  maxSessions?: number;
  /**
   * Auto-init on missing config (hook scenario). Default false — extract is
   * a deliberate command; we want explicit init.
   */
  autoInit?: boolean;
  /**
   * Test seam: inject an L1 runner fn directly, bypassing pipeline-factory
   * + LLM provider wiring. When supplied, store/embedding init is skipped
   * (the override is assumed self-contained). Used by extract.test.ts.
   */
  l1RunnerOverride?: L1RunnerFn;
  /**
   * Test seam (v0.3.3): inject an L2 runner. When provided, the wiring
   * via `buildL2L3Runners` is skipped for L2. Required for unit tests of
   * the L1→L2→L3 chain (real L2 runner needs OpenRouter + scene fixtures).
   */
  l2RunnerOverride?: L2RunnerFn;
  /**
   * Test seam (v0.3.3): inject an L3 runner. When provided, the wiring
   * via `buildL2L3Runners` is skipped for L3. Required for unit tests.
   */
  l3RunnerOverride?: L3RunnerFn;
}

export interface ExtractSummary {
  /** Number of unique sessionKeys processed (skipped via maxSessions counts as not-processed). */
  sessions: number;
  /** Total L0 message rows observed across all JSONL files (informational). */
  l0_total: number;
  /**
   * Total L0 input messages the L1 runner considered across all drain
   * iterations. NOT the count of L1 facts created — Hy3 may decide an
   * input batch is too thin / too generic to yield individual facts
   * (returns scene name but 0 memories). For accurate L1-row-count
   * deltas, compare `vectors.db` `l1_records` count before/after.
   */
  l0_processed: number;
  /** Sessions that failed mid-extract (LLM error, etc.) — informational. */
  failed_sessions: number;

  // ─── v0.3.3: L2 + L3 chain ──────────────────────────────────────────
  /** Sessions where L2 scene extraction was attempted (post-L1, non-failed L1 sessions). */
  l2_scenes_processed: number;
  /** Subset of l2_scenes_processed where the L2 runner threw. */
  failed_l2_sessions: number;
  /**
   * True if the L3 runner was invoked (post-L2 loop). Always exactly one
   * call per extract — L3 itself runs PersonaTrigger.shouldGenerate()
   * internally and short-circuits when not needed (returns void without
   * writing persona.md). So `l3_attempted=true` does NOT mean persona was
   * regenerated; check `l3_persona_bytes` for that.
   */
  l3_attempted: boolean;
  /** True if the L3 runner call threw (error from PersonaGenerator / LLM / file IO). */
  l3_failed: boolean;
  /**
   * Size in bytes of persona.md AFTER the L3 call, ONLY if both mtime and
   * size strictly increased compared to the pre-call snapshot (proxy for
   * "L3 actually generated and wrote a new persona"). Undefined if no
   * change detected OR persona.md absent both before and after. Codex
   * round 1 P2 fix: L3Runner returns void for success, no-op, and silent
   * failure alike — fs.stat diff is the only inference available without
   * modifying the upstream contract.
   */
  l3_persona_bytes?: number;
}

export interface RunExtractResult {
  ok: boolean;
  exitCode: 0 | 1;
  summary?: ExtractSummary;
  error?: string;
}

/**
 * Load OPENROUTER_API_KEY + OPENAI_API_KEY (or VOYAGE_API_KEY) from `~/.claude/claude-mem.env`
 * into process.env if the file exists. Mirrors the `set -a; . file; set +a`
 * pattern from hook wrappers — needed because terminal-invoked extract
 * bypasses wrappers entirely. P1 fix from codex adversarial review.
 *
 * Lines beginning with # are skipped. Format: KEY=VALUE (no quoting,
 * no expansion — matches `claude-mem.env.example` template).
 */
function loadEnvFileIntoProcess(envPath: string): void {
  if (!fs.existsSync(envPath)) return;
  let buf: string;
  try {
    buf = fs.readFileSync(envPath, "utf-8");
  } catch {
    return;
  }
  for (const rawLine of buf.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    if (!k) continue;
    // Don't overwrite explicit shell env (export wins over file).
    if (process.env[k] !== undefined && process.env[k] !== "") continue;
    process.env[k] = v;
  }
}

export async function runExtract(opts: RunExtractOptions): Promise<RunExtractResult> {
  // ── Load ~/.claude/claude-mem.env BEFORE loadContext (P1 codex fix) ─
  // CLI invocation bypasses hook wrappers' set-a-source pattern. Without
  // this, users following the documented setup ('keys in env file') get
  // 'OPENROUTER_API_KEY not set' from terminal even when the file is
  // correctly populated.
  if (!opts.l1RunnerOverride) {
    const home = process.env.HOME;
    if (home) {
      loadEnvFileIntoProcess(path.join(home, ".claude", "claude-mem.env"));
    }
  }

  // ── Preflight: config exists ────────────────────────────────────────
  let ctx;
  try {
    ctx = await loadContextOrAutoInit({
      projectRoot: opts.projectRoot,
      autoInit: opts.autoInit,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // loadContext throws when config.json missing — surface as actionable error.
    return {
      ok: false,
      exitCode: 1,
      error: `extract: ${msg} — run \`claude-mem init\` in this project first.`,
    };
  }

  // ── Preflight: extraction.enabled in config ─────────────────────────
  // Tencent's MemoryTdaiConfig has `extraction.enableDedup` (not `enabled`),
  // but for the extract command we want a hard switch the user can flip in
  // config.json — `extraction.enabled` defaults to true (per upstream's
  // parseConfig). When user explicitly sets false → bail with a clear message.
  const extractionEnabled = (ctx.config.extraction as { enabled?: boolean })?.enabled !== false;
  if (!extractionEnabled) {
    return {
      ok: false,
      exitCode: 1,
      error: "extract: extraction disabled in config.json (set extraction.enabled=true).",
    };
  }

  // ── Preflight: API key present (unless override) ────────────────────
  // The L1 runner needs OpenRouter for real calls. When an override is
  // injected (test mode), keys aren't needed.
  if (!opts.l1RunnerOverride) {
    const apiKey = ctx.config.llm.apiKey?.trim();
    if (!apiKey) {
      return {
        ok: false,
        exitCode: 1,
        error:
          "extract: OPENROUTER_API_KEY not set. " +
          "Add it to ~/.claude/claude-mem.env or export it in your shell.",
      };
    }
  }

  // ── Enumerate sessionKeys + count L0 from flat JSONL ────────────────
  const convDir = path.join(ctx.dataDir, CONVERSATIONS_SUBDIR);
  const { sessionKeys, l0Total } = enumerateSessions(convDir);

  // ── Dry-run short-circuit ───────────────────────────────────────────
  if (opts.dryRun) {
    return {
      ok: true,
      exitCode: 0,
      summary: {
        sessions: sessionKeys.length,
        l0_total: l0Total,
        l0_processed: 0,
        failed_sessions: 0,
        l2_scenes_processed: 0,
        failed_l2_sessions: 0,
        l3_attempted: false,
        l3_failed: false,
      },
    };
  }

  // ── Build / inject L1 runner ────────────────────────────────────────
  const logger: PipelineLogger = {
    debug: (m) => ctx.logger.debug?.(m),
    info: (m) => ctx.logger.info(m),
    warn: (m) => ctx.logger.warn(m),
    error: (m) => ctx.logger.error(m),
  };

  let l1Runner: L1RunnerFn;
  // Hoisted so the v0.3.3 L2/L3 chain (post-L1) can reuse the vectorStore.
  // Stays undefined in the override path — L2/L3 chain is then only reachable
  // via explicit l2RunnerOverride / l3RunnerOverride.
  let storesForChain: Awaited<ReturnType<typeof initStores>> | undefined;
  if (opts.l1RunnerOverride) {
    l1Runner = opts.l1RunnerOverride;
  } else {
    initDataDirectories(ctx.dataDir);
    const stores = await initStores(ctx.config, ctx.dataDir, logger);
    storesForChain = stores;

    // ── Backfill SQLite l0_conversations from JSONL ───────────────────
    // v0.3.0 architectural bridge: capture (v0.2) writes only JSONL.
    // The L1 runner reads from SQLite l0_conversations (vectorStore.
    // queryL0GroupedBySessionId) when vectorStore is available — and
    // it always is here. Without this backfill, fixture/historical JSONL
    // L0 turns are invisible to L1 → extract silently does nothing.
    //
    // upsertL0 is idempotent on `id` field, so re-runs are no-ops for
    // already-bridged rows (we still pay the parse cost — minor for L0
    // sizes; could add cursor optimization in v0.3.1 if needed).
    if (stores.vectorStore) {
      const upserted = await backfillSqliteFromJsonl(stores.vectorStore, convDir, logger);
      if (upserted > 0) {
        ctx.logger.info(`extract: backfilled ${upserted} L0 row(s) from JSONL → SQLite`);
      }
    }

    // P2 codex fix: honor cfg.extraction.model when set (R1 fallback
    // configures this to e.g. anthropic/claude-sonnet-4.6 for L1 only).
    // createRunner's modelRef option overrides config.model on a
    // per-call basis. When extraction.model unset, falls back to
    // cfg.llm.model (no behavior change).
    const l1ModelRef = ctx.config.extraction.model || ctx.config.llm.model;
    const llmRunnerInstance: LLMRunner = new StandaloneLLMRunnerFactory({
      config: {
        baseUrl: ctx.config.llm.baseUrl,
        apiKey: ctx.config.llm.apiKey,
        model: ctx.config.llm.model,
      },
      logger,
    }).createRunner({ enableTools: false, modelRef: l1ModelRef });

    l1Runner = createL1Runner({
      pluginDataDir: ctx.dataDir,
      cfg: ctx.config,
      openclawConfig: undefined,
      vectorStore: stores.vectorStore,
      embeddingService: stores.embeddingService,
      logger,
      llmRunner: llmRunnerInstance,
    });
  }

  // ── Per-session drain loop ──────────────────────────────────────────
  const cap = opts.maxSessions && opts.maxSessions > 0 ? opts.maxSessions : sessionKeys.length;
  const toProcess = sessionKeys.slice(0, cap);

  let l0Processed = 0;
  let failedSessions = 0;

  for (const sessionKey of toProcess) {
    try {
      let iter = 0;
      while (iter < DRAIN_HARD_CAP) {
        const result = await l1Runner({ sessionKey });
        const processed = result?.processedCount ?? 0;
        l0Processed += processed;
        if (processed === 0) break;
        iter += 1;
      }
      if (iter >= DRAIN_HARD_CAP) {
        ctx.logger.warn(
          `extract: session ${sessionKey} hit drain hard cap (${DRAIN_HARD_CAP} iters); ` +
          `${DRAIN_HARD_CAP * 50} turns processed but more may remain. Re-run to continue.`,
        );
      }
    } catch (err) {
      failedSessions += 1;
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logger.error(`extract: session ${sessionKey} failed: ${msg}`);
    }
  }

  // ═════════ v0.3.3: L2 + L3 chain (post-L1, before exit code) ═══════
  //
  // ADR-1: always-on chain. ADR-2: fail-soft — L2/L3 errors NEVER change
  // exitCode (L1 is the money operation; L2/L3 retry on next scheduler tick).
  // Skip conditions:
  //   - dryRun (already early-returned above)
  //   - all L1 sessions failed (failedSessions === toProcess.length)
  //   - no L1 records produced at all (l0Processed === 0) — no new scenes possible
  //   - no runners available (override missing AND store init was skipped via L1 override)
  let l2ScenesProcessed = 0;
  let failedL2Sessions = 0;
  let l3Attempted = false;
  let l3Failed = false;
  let l3PersonaBytes: number | undefined;

  const allL1Failed = toProcess.length > 0 && failedSessions === toProcess.length;
  const noNewL1Data = l0Processed === 0;
  const shouldRunChain = !allL1Failed && !noNewL1Data;

  if (shouldRunChain) {
    // Build / inject L2 runner.
    let l2Runner: L2RunnerFn | undefined = opts.l2RunnerOverride;
    let l3Runner: L3RunnerFn | undefined = opts.l3RunnerOverride;

    if ((!l2Runner || !l3Runner) && storesForChain?.vectorStore) {
      try {
        const bundle = buildL2L3Runners({
          pluginDataDir: ctx.dataDir,
          cfg: ctx.config,
          vectorStore: storesForChain.vectorStore,
          logger,
        });
        l2Runner = l2Runner ?? bundle.l2Runner;
        l3Runner = l3Runner ?? bundle.l3Runner;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.logger.warn(`extract.l2l3.wiring: build failed: ${msg}`);
      }
    }

    // ── L2: per-session loop with cursor persistence (codex C1 fix) ───
    if (l2Runner) {
      const checkpointMgr = new CheckpointManager(ctx.dataDir, logger);
      for (const sessionKey of toProcess) {
        try {
          // Read latest cursor for this session (defaults to "" → undefined).
          const cp = await checkpointMgr.read();
          const pState = checkpointMgr.getPipelineState(cp, sessionKey);
          const priorCursor = pState.last_extraction_updated_time || undefined;

          const result = await l2Runner(sessionKey, priorCursor);
          l2ScenesProcessed += 1;

          // Persist returned latestCursor (only when L2 actually returned
          // a result object AND advanced the cursor). Void return = no L1
          // records processed → leave cursor untouched (incremental safe).
          if (result && typeof result === "object" && result.latestCursor) {
            await checkpointMgr.mergePipelineStates({
              [sessionKey]: { ...pState, last_extraction_updated_time: result.latestCursor },
            });
          }
        } catch (err) {
          failedL2Sessions += 1;
          const msg = err instanceof Error ? err.message : String(err);
          ctx.logger.error(`extract.l2: session ${sessionKey} failed: ${msg}`);
        }
      }
    }

    // ── L3: single call, gate via filesystem mtime/size diff (codex C2 fix) ─
    if (l3Runner) {
      const personaPath = path.join(ctx.dataDir, "persona.md");
      const preStat = await statSafe(personaPath);

      l3Attempted = true;
      try {
        await l3Runner();
      } catch (err) {
        l3Failed = true;
        const msg = err instanceof Error ? err.message : String(err);
        ctx.logger.error(`extract.l3: persona generation failed: ${msg}`);
      }

      const postStat = await statSafe(personaPath);
      if (postStat && (!preStat || (postStat.mtimeMs > preStat.mtimeMs && postStat.size > preStat.size))) {
        l3PersonaBytes = postStat.size;
      }
    }
  }

  // ── Exit code: 1 only if ALL processed sessions failed ─────────────
  // Note: L2/L3 errors are deliberately excluded from this — see ADR-2.
  const exitCode: 0 | 1 = toProcess.length > 0 && failedSessions === toProcess.length ? 1 : 0;
  return {
    ok: exitCode === 0,
    exitCode,
    summary: {
      sessions: toProcess.length,
      l0_total: l0Total,
      l0_processed: l0Processed,
      failed_sessions: failedSessions,
      l2_scenes_processed: l2ScenesProcessed,
      failed_l2_sessions: failedL2Sessions,
      l3_attempted: l3Attempted,
      l3_failed: l3Failed,
      l3_persona_bytes: l3PersonaBytes,
    },
  };
}

/** Stat a file; return undefined if absent or unreadable. */
async function statSafe(p: string): Promise<{ size: number; mtimeMs: number } | undefined> {
  try {
    const s = await fsp.stat(p);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return undefined;
  }
}

interface SessionEnum {
  sessionKeys: string[];
  l0Total: number;
}

function enumerateSessions(convDir: string): SessionEnum {
  if (!fs.existsSync(convDir)) return { sessionKeys: [], l0Total: 0 };

  const sessionKeys = new Set<string>();
  let l0Total = 0;

  for (const entry of fs.readdirSync(convDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const filePath = path.join(convDir, entry.name);
    let buf: string;
    try {
      buf = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }
    for (const line of buf.split("\n")) {
      if (!line) continue;
      let row: { sessionKey?: string };
      try {
        row = JSON.parse(line) as { sessionKey?: string };
      } catch {
        continue;
      }
      l0Total += 1;
      if (typeof row.sessionKey === "string" && row.sessionKey.length > 0) {
        sessionKeys.add(row.sessionKey);
      }
    }
  }

  // Stable iteration order: sorted alphabetically. Important for --max-sessions
  // determinism in tests (e.g. "sA" comes before "sB").
  return { sessionKeys: Array.from(sessionKeys).sort(), l0Total };
}

/**
 * Walk all JSONL files in conversations/ and upsert each L0 message into
 * SQLite via vectorStore.upsertL0. Idempotent: upsertL0 dedupes by `id`.
 * Returns the count of rows upserted (includes no-ops on existing rows).
 *
 * JSONL line shape (written by recordConversation upstream):
 *   { sessionKey, sessionId, recordedAt, id, role, content, timestamp }
 * L0Record shape (SQLite store):
 *   { id, sessionKey, sessionId, role, messageText, recordedAt, timestamp }
 * The only field rename: `content` (JSONL) → `messageText` (L0Record).
 */
async function backfillSqliteFromJsonl(
  vectorStore: IMemoryStore,
  convDir: string,
  logger: PipelineLogger,
): Promise<number> {
  if (!fs.existsSync(convDir)) return 0;
  let upserted = 0;
  for (const entry of fs.readdirSync(convDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const filePath = path.join(convDir, entry.name);
    let buf: string;
    try {
      buf = fs.readFileSync(filePath, "utf-8");
    } catch (err) {
      logger.warn(`extract.backfill: read ${filePath} failed: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const line of buf.split("\n")) {
      if (!line) continue;
      let row: {
        id?: string;
        sessionKey?: string;
        sessionId?: string;
        role?: string;
        content?: string;
        recordedAt?: string;
        timestamp?: number;
      };
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (!row.id || !row.sessionKey || !row.role || typeof row.content !== "string") continue;
      const record: L0Record = {
        id: row.id,
        sessionKey: row.sessionKey,
        sessionId: row.sessionId ?? "",
        role: row.role,
        messageText: row.content,
        recordedAt: row.recordedAt ?? new Date().toISOString(),
        timestamp: typeof row.timestamp === "number" ? row.timestamp : Date.now(),
      };
      try {
        await vectorStore.upsertL0(record);
        upserted += 1;
      } catch (err) {
        logger.warn(`extract.backfill: upsertL0 ${row.id} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return upserted;
}

/** Format a RunExtractResult.summary for human stdout (single line). */
export function formatExtractSummary(projectRoot: string, s: ExtractSummary): string {
  const l3Part = s.l3_attempted
    ? ` l3=${s.l3_failed ? "fail" : s.l3_persona_bytes !== undefined ? `wrote-${s.l3_persona_bytes}b` : "noop"}`
    : "";
  return (
    `extract: project=${projectRoot} sessions=${s.sessions} l0_total=${s.l0_total} ` +
    `l0_processed=${s.l0_processed} failed_sessions=${s.failed_sessions} ` +
    `l2_scenes=${s.l2_scenes_processed} failed_l2=${s.failed_l2_sessions}${l3Part}`
  );
}
