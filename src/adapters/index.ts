/**
 * TDAI Adapters — barrel re-export for all host adapter implementations.
 *
 * Each adapter translates a specific host environment's API into
 * the host-neutral HostAdapter interface consumed by TdaiCore.
 *
 * v0.1: standalone only. v0.2 adds claude-code.
 */

// Standalone adapter
export { StandaloneHostAdapter, StandaloneLLMRunner, StandaloneLLMRunnerFactory } from "./standalone/index.js";
export type { StandaloneHostAdapterOptions, StandaloneLLMConfig, StandaloneLLMRunnerFactoryOptions } from "./standalone/index.js";

// Claude Code adapter (v0.2)
export { ClaudeCodeHostAdapter, ClaudeCodeLLMRunnerFactory, synthesizeSessionId } from "./claude-code/index.js";
export type { ClaudeCodeHostAdapterOptions, ClaudeCodeLLMRunnerFactoryOptions } from "./claude-code/index.js";
