/**
 * Unit tests for `buildL2L3Runners` (v0.3.3 Task 2 — RED, then GREEN in Task 3).
 *
 * Mocks `pipeline-factory` createL2Runner/createL3Runner + the
 * StandaloneLLMRunnerFactory so we can inspect the exact options the
 * wiring layer passes to each.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Capture vars (populated by mock factories) ─────────────────────────
const captured: {
  l2Opts?: Record<string, unknown>;
  l3Opts?: Record<string, unknown>;
  factoryOpts?: Record<string, unknown>;
  createRunnerOpts?: Record<string, unknown>;
} = {};

const sentinelL2Runner = vi.fn(async () => ({ latestCursor: undefined }));
const sentinelL3Runner = vi.fn(async () => undefined);
const sentinelLLMRunner = { __tag: "llm-runner" } as unknown as import("../../core/types.js").LLMRunner;

vi.mock("../../utils/pipeline-factory.js", async () => {
  const actual = await vi.importActual<typeof import("../../utils/pipeline-factory.js")>(
    "../../utils/pipeline-factory.js",
  );
  return {
    ...actual,
    createL2Runner: (opts: Record<string, unknown>) => {
      captured.l2Opts = opts;
      return sentinelL2Runner;
    },
    createL3Runner: (opts: Record<string, unknown>) => {
      captured.l3Opts = opts;
      return sentinelL3Runner;
    },
  };
});

vi.mock("../../adapters/standalone/llm-runner.js", () => ({
  StandaloneLLMRunnerFactory: class {
    constructor(opts: Record<string, unknown>) {
      captured.factoryOpts = opts;
    }
    createRunner(opts: Record<string, unknown>) {
      captured.createRunnerOpts = opts;
      return sentinelLLMRunner;
    }
  },
}));

// Import AFTER mocks so the wiring module picks them up.
const { buildL2L3Runners } = await import("./extract-l2l3-wiring.js");

function makeCfg(personaModel?: string): import("../../config.js").MemoryTdaiConfig {
  return {
    llm: { baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-test", model: "tencent/hy3-preview" },
    persona: {
      triggerEveryN: 50,
      maxScenes: 15,
      backupCount: 3,
      sceneBackupCount: 10,
      model: personaModel,
    },
  } as unknown as import("../../config.js").MemoryTdaiConfig;
}

const mockLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const sentinelStore = { __tag: "store" } as unknown as import("../../core/store/types.js").IMemoryStore;

beforeEach(() => {
  captured.l2Opts = undefined;
  captured.l3Opts = undefined;
  captured.factoryOpts = undefined;
  captured.createRunnerOpts = undefined;
});

describe("buildL2L3Runners (v0.3.3)", () => {
  it("returns bundle with l2Runner, l3Runner, llmRunner fields", () => {
    const bundle = buildL2L3Runners({
      pluginDataDir: "/tmp/x",
      cfg: makeCfg("tencent/hy3-preview"),
      vectorStore: sentinelStore,
      logger: mockLogger,
    });
    expect(bundle.l2Runner).toBe(sentinelL2Runner);
    expect(bundle.l3Runner).toBe(sentinelL3Runner);
    expect(bundle.llmRunner).toBe(sentinelLLMRunner);
  });

  it("builds LLM runner with enableTools=true (required for scene/persona file ops)", () => {
    buildL2L3Runners({
      pluginDataDir: "/tmp/x",
      cfg: makeCfg("tencent/hy3-preview"),
      vectorStore: sentinelStore,
      logger: mockLogger,
    });
    expect(captured.createRunnerOpts).toBeDefined();
    expect((captured.createRunnerOpts as { enableTools?: boolean }).enableTools).toBe(true);
  });

  it("propagates vectorStore into both L2 and L3 runners", () => {
    buildL2L3Runners({
      pluginDataDir: "/tmp/x",
      cfg: makeCfg("tencent/hy3-preview"),
      vectorStore: sentinelStore,
      logger: mockLogger,
    });
    expect((captured.l2Opts as { vectorStore?: unknown }).vectorStore).toBe(sentinelStore);
    expect((captured.l3Opts as { vectorStore?: unknown }).vectorStore).toBe(sentinelStore);
  });

  it("defaults LLM model from cfg.persona.model when set", () => {
    buildL2L3Runners({
      pluginDataDir: "/tmp/x",
      cfg: makeCfg("custom/persona-model"),
      vectorStore: sentinelStore,
      logger: mockLogger,
    });
    expect((captured.createRunnerOpts as { modelRef?: string }).modelRef).toBe("custom/persona-model");
  });
});
