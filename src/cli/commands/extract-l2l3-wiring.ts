/**
 * `extract` command — L2 + L3 runner wiring (v0.3.3).
 *
 * Builds a single shared LLM runner (enableTools=true, required for L2 scene
 * extraction + L3 persona generation file ops) and threads it into the
 * `createL2Runner` + `createL3Runner` pipeline-factory primitives.
 *
 * Mirrors the L1 wiring pattern in `extract.ts` — direct factory use,
 * skipping `TdaiCore` to avoid the openclaw-branch surface. ADR-5 of
 * `docs/plans/v0.3.3-l2-l3-chain/SPEC.md`: one LLM runner instance reused
 * across L2 (N sessions) + L3 (1 call) → saves ~50ms × N factory builds.
 *
 * Test seam: `buildL2L3Runners` returns `{l2Runner, l3Runner, llmRunner}`
 * so unit tests can inspect the wired runner without mocking the entire
 * pipeline-factory.
 */

import {
  createL2Runner,
  createL3Runner,
  type PipelineLogger,
} from "../../utils/pipeline-factory.js";
import type { L2Runner, L3Runner } from "../../utils/pipeline-manager.js";
import { StandaloneLLMRunnerFactory } from "../../adapters/standalone/llm-runner.js";
import type { LLMRunner } from "../../core/types.js";
import type { IMemoryStore } from "../../core/store/types.js";
import type { MemoryTdaiConfig } from "../../config.js";

/** Options accepted by `buildL2L3Runners`. */
export interface L2L3WiringOptions {
  /** `.claude/memory/` dir (used by L2 to read records, L3 to write persona.md). */
  pluginDataDir: string;
  /** Loaded `config.json`. `cfg.persona.model` is the LLM model ref for L2/L3. */
  cfg: MemoryTdaiConfig;
  /** Vector store from `initStores` — L2 uses it to query L1 records incrementally. */
  vectorStore: IMemoryStore | undefined;
  /** Plumbed into both runners; same shape as L1 wiring in extract.ts. */
  logger: PipelineLogger;
  /** Optional instance id (mirrored from extract context). */
  instanceId?: string;
}

/** Bundle returned to `extract.ts`. The shared `llmRunner` is exposed for visibility/tests. */
export interface L2L3Runners {
  l2Runner: L2Runner;
  l3Runner: L3Runner;
  llmRunner: LLMRunner;
}

/**
 * Build a shared LLM runner + L2/L3 runners using pipeline-factory primitives.
 *
 * Implementation lands in Task 3 (RED→GREEN). This file currently exports the
 * symbol so test-mode imports in Task 2 resolve. Calling the un-implemented
 * function throws a clear error so accidental wiring doesn't silently no-op.
 */
export function buildL2L3Runners(_opts: L2L3WiringOptions): L2L3Runners {
  void createL2Runner; // suppress unused-import while skeleton
  void createL3Runner;
  void StandaloneLLMRunnerFactory;
  throw new Error("buildL2L3Runners: not implemented (Task 3 of v0.3.3 SPEC)");
}
