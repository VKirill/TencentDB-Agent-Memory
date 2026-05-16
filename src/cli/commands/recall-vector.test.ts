import { describe, expect, it, vi } from "vitest";

import { runVectorRecall, type VectorRecallContext } from "./recall-vector.js";

/**
 * 7 cases per SPEC v0.3.2 §5 Task 2 (+ codex round 1 ADR-5 fix):
 * (a) Happy path: 3 L1 matches → formatted lines
 * (b) No apiKey → null (fall back)
 * (c) countL1() === 0 → null
 * (d) vectorStore.isDegraded() → null
 * (e) embed throws → null
 * (f) opts.vector === false → null (no embed call)
 * (g) Vector miss (searchL1Vector returns []) → null (codex C1)
 */

function makeCtx(overrides: Partial<VectorRecallContext> = {}): VectorRecallContext {
  return {
    apiKey: "voyage-test-key",
    embeddingService: {
      embed: vi.fn().mockResolvedValue(new Float32Array(512)),
    },
    vectorStore: {
      isDegraded: vi.fn().mockReturnValue(false),
      countL1: vi.fn().mockResolvedValue(10),
      searchL1Vector: vi.fn().mockResolvedValue([
        { record_id: "r1", content: "fact one", type: "instruction", priority: 3,
          scene_name: "scene-a", score: 0.9, timestamp_str: "", timestamp_start: "",
          timestamp_end: "", session_key: "", session_id: "", metadata_json: "{}" },
      ]),
    },
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    scoreThreshold: 0.3,
    ...overrides,
  };
}

describe("runVectorRecall", () => {
  it("(a) happy path: 3 L1 matches → formatted lines", async () => {
    const ctx = makeCtx({
      vectorStore: {
        isDegraded: vi.fn().mockReturnValue(false),
        countL1: vi.fn().mockResolvedValue(10),
        searchL1Vector: vi.fn().mockResolvedValue([
          { record_id: "r1", content: "first fact", type: "persona", priority: 3,
            scene_name: "s1", score: 0.95, timestamp_str: "", timestamp_start: "",
            timestamp_end: "", session_key: "", session_id: "", metadata_json: "{}" },
          { record_id: "r2", content: "second fact", type: "episodic", priority: 2,
            scene_name: "s2", score: 0.85, timestamp_str: "", timestamp_start: "",
            timestamp_end: "", session_key: "", session_id: "", metadata_json: "{}" },
          { record_id: "r3", content: "third fact", type: "instruction", priority: 1,
            scene_name: "s3", score: 0.75, timestamp_str: "", timestamp_start: "",
            timestamp_end: "", session_key: "", session_id: "", metadata_json: "{}" },
        ]),
      },
    });
    const result = await runVectorRecall(ctx, "test query", { limit: 3 });
    expect(result).not.toBeNull();
    expect(result).toHaveLength(3);
    expect(result![0]).toContain("first fact");
    expect(result![0]).toContain("(0.95)");
    expect(result![2]).toContain("third fact");
  });

  it("(b) no apiKey → null (pre-embed fallback)", async () => {
    const ctx = makeCtx({ apiKey: "" });
    const result = await runVectorRecall(ctx, "x", { limit: 5 });
    expect(result).toBeNull();
    expect(ctx.embeddingService.embed).not.toHaveBeenCalled();
  });

  it("(c) countL1() === 0 → null", async () => {
    const ctx = makeCtx({
      vectorStore: {
        isDegraded: vi.fn().mockReturnValue(false),
        countL1: vi.fn().mockResolvedValue(0),
        searchL1Vector: vi.fn(),
      },
    });
    const result = await runVectorRecall(ctx, "x", { limit: 5 });
    expect(result).toBeNull();
    expect(ctx.embeddingService.embed).not.toHaveBeenCalled();
  });

  it("(d) vectorStore.isDegraded() → null", async () => {
    const ctx = makeCtx({
      vectorStore: {
        isDegraded: vi.fn().mockReturnValue(true),
        countL1: vi.fn(),
        searchL1Vector: vi.fn(),
      },
    });
    const result = await runVectorRecall(ctx, "x", { limit: 5 });
    expect(result).toBeNull();
    expect(ctx.embeddingService.embed).not.toHaveBeenCalled();
  });

  it("(e) embed throws → null", async () => {
    const ctx = makeCtx({
      embeddingService: { embed: vi.fn().mockRejectedValue(new Error("Voyage timeout")) },
    });
    const result = await runVectorRecall(ctx, "x", { limit: 5 });
    expect(result).toBeNull();
  });

  it("(f) opts.vector === false → null (short-circuit before embed)", async () => {
    const ctx = makeCtx();
    const result = await runVectorRecall(ctx, "x", { limit: 5, vector: false });
    expect(result).toBeNull();
    expect(ctx.embeddingService.embed).not.toHaveBeenCalled();
    expect(ctx.vectorStore.countL1).not.toHaveBeenCalled();
  });

  it("(g) vector miss (searchL1Vector returns []) → null (ADR-5 codex C1)", async () => {
    const ctx = makeCtx({
      vectorStore: {
        isDegraded: vi.fn().mockReturnValue(false),
        countL1: vi.fn().mockResolvedValue(10),
        searchL1Vector: vi.fn().mockResolvedValue([]),
      },
    });
    const result = await runVectorRecall(ctx, "x", { limit: 5 });
    expect(result).toBeNull();
    expect(ctx.embeddingService.embed).toHaveBeenCalled(); // confirmed embed ran
  });
});
