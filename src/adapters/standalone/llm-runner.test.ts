import { describe, expect, it } from "vitest";

import {
  StandaloneLLMRunnerFactory,
  isOpenAIProperHost,
  stripProviderPrefix,
} from "./llm-runner.js";

/**
 * Regression test for the v0.1 Task 21 slug-strip bug.
 *
 * Original behavior: createRunner() blindly stripped `provider/` prefix
 * from `provider/model` slugs, sending `hy3-preview` to OpenRouter
 * instead of the required `tencent/hy3-preview`.
 *
 * New behavior: preserve the full slug for everything EXCEPT
 * api.openai.com (which doesn't accept provider/ prefixes).
 */

describe("isOpenAIProperHost", () => {
  it("matches https://api.openai.com/v1", () => {
    expect(isOpenAIProperHost("https://api.openai.com/v1")).toBe(true);
  });

  it("does NOT match openrouter.ai", () => {
    expect(isOpenAIProperHost("https://openrouter.ai/api/v1")).toBe(false);
  });

  it("does NOT match voyage", () => {
    expect(isOpenAIProperHost("https://api.voyageai.com/v1")).toBe(false);
  });

  it("returns false for undefined or malformed url", () => {
    expect(isOpenAIProperHost(undefined)).toBe(false);
    expect(isOpenAIProperHost("not a url")).toBe(false);
    expect(isOpenAIProperHost("")).toBe(false);
  });
});

describe("stripProviderPrefix", () => {
  it("strips the provider segment", () => {
    expect(stripProviderPrefix("openai/gpt-4")).toBe("gpt-4");
    expect(stripProviderPrefix("anthropic/claude-sonnet-4.6")).toBe("claude-sonnet-4.6");
  });

  it("passes bare model names through", () => {
    expect(stripProviderPrefix("gpt-4")).toBe("gpt-4");
  });
});

describe("StandaloneLLMRunnerFactory.createRunner — slug preservation", () => {
  it("preserves full slug for OpenRouter (tencent/hy3-preview stays intact)", () => {
    const factory = new StandaloneLLMRunnerFactory({
      config: {
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "sk-or-test",
        model: "default-model",
      },
    });
    // Cast to access private `model` via the StandaloneLLMRunner instance
    const runner = factory.createRunner({ modelRef: "tencent/hy3-preview" });
    // The runner stores the resolved model on its config; verify via toString-like access
    expect((runner as unknown as { model: string }).model).toBe("tencent/hy3-preview");
  });

  it("preserves full slug for anthropic models on OpenRouter (R1 fallback case)", () => {
    const factory = new StandaloneLLMRunnerFactory({
      config: {
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "sk-or-test",
        model: "default-model",
      },
    });
    const runner = factory.createRunner({ modelRef: "anthropic/claude-sonnet-4.6" });
    expect((runner as unknown as { model: string }).model).toBe("anthropic/claude-sonnet-4.6");
  });

  it("strips provider prefix when targeting api.openai.com proper", () => {
    const factory = new StandaloneLLMRunnerFactory({
      config: {
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-test",
        model: "default-model",
      },
    });
    const runner = factory.createRunner({ modelRef: "openai/gpt-4" });
    expect((runner as unknown as { model: string }).model).toBe("gpt-4");
  });
});
