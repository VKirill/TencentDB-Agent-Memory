/**
 * ClaudeCodeLLMRunnerFactory — wraps StandaloneLLMRunnerFactory with
 * OpenRouter deepseek-v4-flash defaults. Reads OPENROUTER_API_KEY from env if not
 * supplied in config.
 *
 * v0.2 wraps (does not subclass) StandaloneLLMRunnerFactory because
 * StandaloneLLMRunnerFactory is final-ish in shape and composition
 * is cleaner than inheritance for one extra config-resolution layer.
 */

import { StandaloneLLMRunnerFactory } from "../standalone/llm-runner.js";
import type { StandaloneLLMConfig } from "../standalone/llm-runner.js";
import type { LLMRunner, LLMRunnerFactory, Logger } from "../../core/types.js";
import { getEnv } from "../../utils/env.js";

const DEFAULTS = {
  baseUrl: "https://openrouter.ai/api/v1",
  model: "deepseek/deepseek-v4-flash",
};

export interface ClaudeCodeLLMRunnerFactoryOptions {
  /** Partial LLM config — defaults applied for missing fields. */
  config?: Partial<StandaloneLLMConfig>;
  /** Logger instance. */
  logger?: Logger;
}

export class ClaudeCodeLLMRunnerFactory implements LLMRunnerFactory {
  private inner: StandaloneLLMRunnerFactory;

  constructor(opts: ClaudeCodeLLMRunnerFactoryOptions = {}) {
    const apiKeyFromEnv = getEnv("OPENROUTER_API_KEY");
    const resolved: StandaloneLLMConfig = {
      baseUrl: opts.config?.baseUrl ?? DEFAULTS.baseUrl,
      apiKey: opts.config?.apiKey ?? apiKeyFromEnv ?? "",
      model: opts.config?.model ?? DEFAULTS.model,
    };

    this.inner = new StandaloneLLMRunnerFactory({
      config: resolved,
      logger: opts.logger,
    });
  }

  createRunner(opts?: { enableTools?: boolean; modelRef?: string }): LLMRunner {
    return this.inner.createRunner(opts);
  }
}
