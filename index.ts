/**
 * @vkirill/tencentdb-agent-memory — public entry point.
 *
 * Re-exports the standalone adapter + TdaiCore for programmatic use.
 * For CLI usage see `bin/claude-mem.mjs`.
 *
 * v0.1: standalone only. v0.2 adds ClaudeCodeHostAdapter re-exports.
 */

export * from "./src/adapters/standalone/index.js";
export { TdaiCore } from "./src/core/tdai-core.js";
export { main, buildCli } from "./src/cli/index.js";
// v0.3.1: L1 prompt symbols re-exported for the Hy3 smoke script
// (scripts/smoke-hy3.mjs imports from dist/index.mjs to use the same
// prompt as the actual extraction path — single source of truth).
export {
  EXTRACT_MEMORIES_SYSTEM_PROMPT,
  formatExtractionPrompt,
} from "./src/core/prompts/l1-extraction.js";
export type {
  HostAdapter,
  LLMRunner,
  LLMRunnerFactory,
  RuntimeContext,
  CompletedTurn,
  RecallResult,
  CaptureResult,
  MemorySearchParams,
  ConversationSearchParams,
} from "./src/core/types.js";
