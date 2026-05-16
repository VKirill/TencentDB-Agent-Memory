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

const CONVERSATIONS_SUBDIR = "conversations";
/** Hard safety cap on per-session drain iterations (50 iters × 50 turns/iter = 2500 L0 turns per session). */
const DRAIN_HARD_CAP = 50;

/** Function signature exactly matching what `createL1Runner` returns. Used to inject a fake in tests. */
export type L1RunnerFn = (params: { sessionKey: string }) => Promise<{ processedCount: number }>;

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
}

export interface ExtractSummary {
  /** Number of unique sessionKeys processed (skipped via maxSessions counts as not-processed). */
  sessions: number;
  /** Total L0 message rows observed across all JSONL files (informational). */
  l0_total: number;
  /** Total L1 records newly extracted this run (summed from drain iterations). */
  l1_new: number;
  /** Sessions that failed mid-extract (LLM error, etc.) — informational. */
  failed_sessions: number;
}

export interface RunExtractResult {
  ok: boolean;
  exitCode: 0 | 1;
  summary?: ExtractSummary;
  error?: string;
}

export async function runExtract(opts: RunExtractOptions): Promise<RunExtractResult> {
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
        l1_new: 0,
        failed_sessions: 0,
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
  if (opts.l1RunnerOverride) {
    l1Runner = opts.l1RunnerOverride;
  } else {
    initDataDirectories(ctx.dataDir);
    const stores = await initStores(ctx.config, ctx.dataDir, logger);
    const llmRunnerInstance: LLMRunner = new StandaloneLLMRunnerFactory({
      config: {
        baseUrl: ctx.config.llm.baseUrl,
        apiKey: ctx.config.llm.apiKey,
        model: ctx.config.llm.model,
      },
      logger,
    }).createRunner({ enableTools: false });

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

  let l1New = 0;
  let failedSessions = 0;

  for (const sessionKey of toProcess) {
    try {
      let iter = 0;
      while (iter < DRAIN_HARD_CAP) {
        const result = await l1Runner({ sessionKey });
        const processed = result?.processedCount ?? 0;
        l1New += processed;
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

  // ── Exit code: 1 only if ALL processed sessions failed ─────────────
  const exitCode: 0 | 1 = toProcess.length > 0 && failedSessions === toProcess.length ? 1 : 0;
  return {
    ok: exitCode === 0,
    exitCode,
    summary: {
      sessions: toProcess.length,
      l0_total: l0Total,
      l1_new: l1New,
      failed_sessions: failedSessions,
    },
  };
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

/** Format a RunExtractResult.summary for human stdout (single line). */
export function formatExtractSummary(projectRoot: string, s: ExtractSummary): string {
  return (
    `extract: project=${projectRoot} sessions=${s.sessions} l0_total=${s.l0_total} ` +
    `l1_new=${s.l1_new} failed_sessions=${s.failed_sessions}`
  );
}
