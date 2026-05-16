import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { loadContext } from "./context.js";

/**
 * Test plan (SPEC §5 Task 11):
 *  1. loadContext({projectRoot}) returns ClaudeCliContext with concrete types
 *     (config: MemoryTdaiConfig, stateDir, dataDir, logger).
 *  2. throws on missing .claude/memory/config.json.
 *  3. merges env vars (OPENROUTER_API_KEY, VOYAGE_API_KEY) onto config.
 *  4. logger writes to <stateDir>/memory.log and never to stdout.
 */

function makeTmpProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-cli-ctx-"));
  return root;
}

function writeMinimalConfig(projectRoot: string): string {
  const dir = path.join(projectRoot, ".claude", "memory");
  fs.mkdirSync(dir, { recursive: true });
  const cfgPath = path.join(dir, "config.json");
  fs.writeFileSync(
    cfgPath,
    JSON.stringify({
      embedding: {
        provider: "voyage",
        baseUrl: "https://api.voyageai.com/v1",
        model: "voyage-3-lite",
        dimensions: 512,
      },
      llm: {
        enabled: true,
        baseUrl: "https://openrouter.ai/api/v1",
        model: "tencent/hy3-preview",
      },
    }),
  );
  return cfgPath;
}

describe("loadContext", () => {
  // Track keys added during a test so afterEach can remove them without
  // replacing the process.env reference (upstream env.ts caches the
  // reference at module load — replacing the object would orphan the cache).
  const KEYS_UNDER_TEST = ["OPENROUTER_API_KEY", "VOYAGE_API_KEY"];
  const originalValues: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS_UNDER_TEST) {
      originalValues[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of KEYS_UNDER_TEST) {
      if (originalValues[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = originalValues[k];
      }
    }
    vi.restoreAllMocks();
  });

  it("returns a ClaudeCliContext with concrete types when config exists", async () => {
    const projectRoot = makeTmpProject();
    writeMinimalConfig(projectRoot);

    const ctx = await loadContext({ projectRoot });

    expect(ctx.stateDir).toBe(path.join(projectRoot, ".claude", "memory"));
    expect(ctx.dataDir).toBe(path.join(projectRoot, ".claude", "memory"));
    expect(typeof ctx.logger.info).toBe("function");
    expect(typeof ctx.logger.warn).toBe("function");
    expect(typeof ctx.logger.error).toBe("function");
    // Config must be the resolved MemoryTdaiConfig shape — embedding block carried through
    expect(ctx.config.embedding.provider).toBe("voyage");
    expect(ctx.config.embedding.model).toBe("voyage-3-lite");
    expect(ctx.config.embedding.dimensions).toBe(512);
  });

  it("throws when .claude/memory/config.json is missing", async () => {
    const projectRoot = makeTmpProject();
    // No config.json written.

    await expect(loadContext({ projectRoot })).rejects.toThrow(/config\.json/i);
  });

  it("merges OPENROUTER_API_KEY and VOYAGE_API_KEY from env onto config", async () => {
    const projectRoot = makeTmpProject();
    writeMinimalConfig(projectRoot);

    process.env.OPENROUTER_API_KEY = "sk-or-test-key-from-env";
    process.env.VOYAGE_API_KEY = "pa-test-key-from-env";

    const ctx = await loadContext({ projectRoot });

    expect(ctx.config.llm.apiKey).toBe("sk-or-test-key-from-env");
    expect(ctx.config.embedding.apiKey).toBe("pa-test-key-from-env");
  });

  it("logger writes to <stateDir>/memory.log and never to stdout", async () => {
    const projectRoot = makeTmpProject();
    writeMinimalConfig(projectRoot);

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const ctx = await loadContext({ projectRoot });
    ctx.logger.info("hello from info");
    ctx.logger.warn("hello from warn");
    ctx.logger.error("hello from error");

    const logPath = path.join(projectRoot, ".claude", "memory", "memory.log");
    expect(fs.existsSync(logPath)).toBe(true);

    const contents = fs.readFileSync(logPath, "utf-8");
    expect(contents).toContain("hello from info");
    expect(contents).toContain("hello from warn");
    expect(contents).toContain("hello from error");

    // Crucial: hooks must not pollute stdout.
    expect(stdoutSpy).not.toHaveBeenCalled();
  });
});
