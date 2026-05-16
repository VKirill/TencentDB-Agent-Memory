import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ClaudeCodeHostAdapter, synthesizeSessionId } from "./host-adapter.js";

/**
 * Test plan (SPEC §7 Task A1):
 *  1. getRuntimeContext() returns platform: "claude-code".
 *  2. dataDir = <projectRoot>/.claude/memory.
 *  3. sessionId synthesized from CLAUDE_PROJECT_DIR + day bucket when not provided.
 *  4. Explicit sessionId overrides synthesis.
 */

const KEYS = ["CLAUDE_PROJECT_DIR"];
const originalValues: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) {
    originalValues[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    if (originalValues[k] === undefined) delete process.env[k];
    else process.env[k] = originalValues[k];
  }
});

function makeLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

function makeAdapter(projectRoot: string, sessionId?: string) {
  return new ClaudeCodeHostAdapter({
    projectRoot,
    sessionId,
    llmConfig: {
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "test-key",
      model: "tencent/hy3-preview",
    },
    logger: makeLogger(),
  });
}

describe("ClaudeCodeHostAdapter.getRuntimeContext", () => {
  it("returns platform: claude-code", () => {
    const a = makeAdapter("/tmp/some-project");
    const ctx = a.getRuntimeContext();
    expect(ctx.platform).toBe("claude-code");
  });

  it("sets dataDir to <projectRoot>/.claude/memory", () => {
    const a = makeAdapter("/tmp/my-project");
    const ctx = a.getRuntimeContext();
    expect(ctx.dataDir).toBe("/tmp/my-project/.claude/memory");
  });

  it("synthesizes sessionId from CLAUDE_PROJECT_DIR + UTC day when not provided", () => {
    process.env.CLAUDE_PROJECT_DIR = "/home/user/proj-x";
    const a = makeAdapter("/home/user/proj-x");
    const ctx = a.getRuntimeContext();
    expect(ctx.sessionId).toBeTruthy();
    expect(ctx.sessionId.length).toBeGreaterThanOrEqual(8);
    // Deterministic across two instances on the same day
    const b = makeAdapter("/home/user/proj-x");
    expect(b.getRuntimeContext().sessionId).toBe(ctx.sessionId);
    // Different across different projects
    const c = makeAdapter("/home/user/proj-y");
    process.env.CLAUDE_PROJECT_DIR = "/home/user/proj-y";
    const c2 = new ClaudeCodeHostAdapter({
      projectRoot: "/home/user/proj-y",
      llmConfig: { baseUrl: "x", apiKey: "y", model: "z" },
      logger: makeLogger(),
    });
    expect(c2.getRuntimeContext().sessionId).not.toBe(ctx.sessionId);
  });

  it("uses explicit sessionId when provided (overrides synthesis)", () => {
    process.env.CLAUDE_PROJECT_DIR = "/tmp/p";
    const a = makeAdapter("/tmp/p", "explicit-session-abc");
    expect(a.getRuntimeContext().sessionId).toBe("explicit-session-abc");
  });
});

describe("synthesizeSessionId", () => {
  it("is deterministic for the same projectDir + date", () => {
    const date = new Date("2026-05-16T12:00:00Z");
    expect(synthesizeSessionId("/home/user/proj", date)).toBe(
      synthesizeSessionId("/home/user/proj", date),
    );
  });

  it("differs across projects", () => {
    const date = new Date("2026-05-16T12:00:00Z");
    expect(synthesizeSessionId("/home/user/a", date)).not.toBe(
      synthesizeSessionId("/home/user/b", date),
    );
  });

  it("differs across days", () => {
    expect(synthesizeSessionId("/p", new Date("2026-05-16T00:00:00Z"))).not.toBe(
      synthesizeSessionId("/p", new Date("2026-05-17T00:00:00Z")),
    );
  });

  it("returns a non-empty, fixed-length string", () => {
    const s = synthesizeSessionId("/p", new Date("2026-05-16T00:00:00Z"));
    expect(s).toMatch(/^[a-f0-9]{16}$/);
  });
});
