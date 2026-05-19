import { describe, expect, it, vi } from "vitest";

import {
  StandaloneLLMRunner,
  StandaloneLLMRunnerFactory,
  isOpenAIProperHost,
  stripProviderPrefix,
} from "./llm-runner.js";

// ── Module mocks (hoisted by Vitest) ────────────────────────────────────────
// Capture the args that generateText receives so we can assert providerOptions.
let capturedGenerateTextArgs: Record<string, unknown> | undefined;

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    generateText: vi.fn(async (args: Record<string, unknown>) => {
      capturedGenerateTextArgs = args;
      return { text: "mocked-response", steps: [] };
    }),
  };
});

vi.mock("@ai-sdk/openai", async () => {
  const actual = await vi.importActual<typeof import("@ai-sdk/openai")>("@ai-sdk/openai");
  return {
    ...actual,
    createOpenAI: vi.fn(() => ({
      chat: vi.fn(() => "mock-model-instance"),
    })),
  };
});

vi.mock("../../core/report/reporter.js", () => ({
  report: vi.fn(),
}));

/**
 * Regression test for the v0.1 Task 21 slug-strip bug.
 *
 * Original behavior: createRunner() blindly stripped `provider/` prefix
 * from `provider/model` slugs, sending `deepseek-v4-flash` to OpenRouter
 * instead of the required `deepseek/deepseek-v4-flash`.
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
  it("preserves full slug for OpenRouter (deepseek/deepseek-v4-flash stays intact)", () => {
    const factory = new StandaloneLLMRunnerFactory({
      config: {
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "sk-or-test",
        model: "default-model",
      },
    });
    // Cast to access private `model` via the StandaloneLLMRunner instance
    const runner = factory.createRunner({ modelRef: "deepseek/deepseek-v4-flash" });
    // The runner stores the resolved model on its config; verify via toString-like access
    expect((runner as unknown as { model: string }).model).toBe("deepseek/deepseek-v4-flash");
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

describe("StandaloneLLMRunner.run — providerOptions forwarded to generateText", () => {
  it("passes providerOptions.openai.reasoning.enabled=false to generateText", async () => {
    capturedGenerateTextArgs = undefined;

    const runner = new StandaloneLLMRunner({
      config: {
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "sk-or-test",
        model: "deepseek/deepseek-v4-flash",
      },
    });

    const output = await runner.run({
      taskId: "test-task",
      systemPrompt: "You are a test assistant.",
      prompt: "Hello",
    });

    expect(output).toBe("mocked-response");
    expect(capturedGenerateTextArgs).toBeDefined();
    const opts = capturedGenerateTextArgs as {
      providerOptions?: {
        openai?: {
          reasoning?: { enabled: boolean };
        };
      };
    };
    expect(opts.providerOptions?.openai?.reasoning?.enabled).toBe(false);
  });

  it("injects response_format.json_schema when responseSchema is provided", async () => {
    capturedGenerateTextArgs = undefined;

    const runner = new StandaloneLLMRunner({
      config: {
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "sk-or-test",
        model: "deepseek/deepseek-v4-flash",
      },
    });

    await runner.run({
      taskId: "test-schema",
      systemPrompt: "Extract memories.",
      prompt: "Hello",
      responseSchema: {
        name: "l1_scenes",
        strict: true,
        schema: { type: "object", properties: { scenes: { type: "array" } }, required: ["scenes"], additionalProperties: false },
      },
    });

    expect(capturedGenerateTextArgs).toBeDefined();
    const opts = capturedGenerateTextArgs as {
      providerOptions?: {
        openai?: {
          reasoning?: { enabled: boolean };
          response_format?: { type: string; json_schema: { name: string } };
        };
      };
    };
    expect(opts.providerOptions?.openai?.reasoning?.enabled).toBe(false);
    expect(opts.providerOptions?.openai?.response_format?.type).toBe("json_schema");
    expect(opts.providerOptions?.openai?.response_format?.json_schema?.name).toBe("l1_scenes");
  });

  it("omits response_format when responseSchema is not provided", async () => {
    capturedGenerateTextArgs = undefined;

    const runner = new StandaloneLLMRunner({
      config: {
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "sk-or-test",
        model: "deepseek/deepseek-v4-flash",
      },
    });

    await runner.run({
      taskId: "test-no-schema",
      systemPrompt: "You are a test assistant.",
      prompt: "Hello",
    });

    expect(capturedGenerateTextArgs).toBeDefined();
    const opts = capturedGenerateTextArgs as {
      providerOptions?: {
        openai?: Record<string, unknown>;
      };
    };
    expect(opts.providerOptions?.openai?.response_format).toBeUndefined();
  });

  it("passes tools=undefined to generateText when responseSchema is set and enableTools=false", async () => {
    capturedGenerateTextArgs = undefined;

    const runner = new StandaloneLLMRunner({
      config: {
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "sk-or-test",
        model: "deepseek/deepseek-v4-flash",
      },
      enableTools: false,
    });

    await runner.run({
      taskId: "test-schema-no-tools",
      systemPrompt: "Extract memories.",
      prompt: "Hello",
      responseSchema: {
        name: "l1_scenes",
        strict: true,
        schema: { type: "object", properties: { scenes: { type: "array" } }, required: ["scenes"], additionalProperties: false },
      },
    });

    expect(capturedGenerateTextArgs).toBeDefined();
    const args = capturedGenerateTextArgs as Record<string, unknown>;
    expect(args.tools).toBeUndefined();
  });
});
