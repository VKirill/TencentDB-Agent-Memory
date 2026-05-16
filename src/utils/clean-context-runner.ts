/**
 * CleanContextRunner — stub for v0.1 standalone mode.
 *
 * The original CleanContextRunner shipped by upstream depends on the
 * OpenClaw plugin runtime (api.runEmbeddedPiAgent, prompt-cache injection,
 * tool sandboxing). We deleted the OpenClaw integration in v0.1 Task 4
 * because it's not used in standalone / Claude Code mode.
 *
 * However, three src/core/* files import `CleanContextRunner` as a
 * compile-time symbol, even though they only USE it in a runtime
 * fallback branch (`opts.llmRunner ?? new CleanContextRunner(...)`).
 * In standalone mode the caller always provides `llmRunner`, so the
 * `new CleanContextRunner(...)` branch is never reached.
 *
 * This stub keeps the import path alive (so rolldown/tsdown can resolve
 * it) while throwing loudly if anyone ever actually instantiates it —
 * which would indicate a host-adapter wiring bug in production.
 *
 * Do NOT delete this file in v0.1. v0.2 may delete once src/core/ is
 * rebased to drop the legacy fallback.
 */

import type { LLMRunner } from "../core/types.js";

interface Logger {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

export interface CleanContextRunnerOptions {
  /** Legacy OpenClaw plugin config; unused in standalone mode. */
  config: unknown;
  /** Optional model reference override. */
  modelRef?: string;
  /** Whether the runner should expose tool-call capability. */
  enableTools?: boolean;
  /** Logger instance for diagnostics. */
  logger?: Logger;
}

const ERROR_MSG =
  "CleanContextRunner is not available in standalone mode. " +
  "Pass a host-neutral LLMRunner (e.g. StandaloneLLMRunner) to the " +
  "calling extractor instead. This stub exists only to keep import " +
  "paths in src/core/* resolvable after the OpenClaw adapter was " +
  "removed in v0.1 Task 4 (see src/utils/clean-context-runner.ts header).";

/**
 * Stub class. Constructor throws on instantiation — never reached in
 * standalone-mode runtime because callers always inject `llmRunner`.
 */
export class CleanContextRunner implements LLMRunner {
  constructor(_options: CleanContextRunnerOptions) {
    throw new Error(ERROR_MSG);
  }

  async run(_params: {
    prompt: string;
    systemPrompt?: string;
    taskId?: string;
    timeoutMs?: number;
  }): Promise<string> {
    throw new Error(ERROR_MSG);
  }
}
