import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { runExtract } from "./extract.js";
import { runInit } from "./init.js";

/**
 * Test plan (v0.3.0 SPEC §5 Task A1):
 *  Orchestration-level tests for runExtract. LLM-mediated end-to-end
 *  flow lives in tests/integration/extract.integration.test.ts (A5).
 *
 *  Cases:
 *  (a) No config.json     → exit=1, error mentions 'claude-mem init'
 *  (b) Missing OPENROUTER → exit=1, error mentions OPENROUTER_API_KEY
 *  (c) extraction.enabled=false in config → exit=1, error mentions config
 *  (d) Init done but no conversations/ dir → exit=0, l0_total=0 l0_processed=0
 *  (e) Init done, JSONL with 2 sessionKeys → enumeration returns both
 *  (f) --dry-run → injected L1 runner NOT called
 *  (g) --max-sessions=1 → processes only first sessionKey
 *  (h) Drain loop: injected runner returns {processedCount:50} twice then 0
 *       → counted as 100 l0_processed and called 3 times (2 with work + 1 with 0)
 */

const tmpDirs: string[] = [];

function makeTmpProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-extract-"));
  tmpDirs.push(root);
  return root;
}

const KEYS = ["OPENROUTER_API_KEY", "VOYAGE_API_KEY", "HOME"];
const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) {
    originalEnv[k] = process.env[k];
    delete process.env[k];
  }
  // Force HOME to a tmp dir with no claude-mem.env, so the P1
  // extract-time env-file loader doesn't pull keys from the real
  // developer's $HOME/.claude/claude-mem.env into these tests.
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-extract-home-"));
  tmpDirs.push(tmpHome);
  process.env.HOME = tmpHome;
});

afterEach(() => {
  for (const k of KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  vi.restoreAllMocks();
});

function writeJsonl(file: string, rows: object[]) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

describe("runExtract — preflight errors", () => {
  it("(a) exits 1 when .claude/memory/config.json missing", async () => {
    const projectRoot = makeTmpProject();
    const r = await runExtract({ projectRoot });
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.error?.toLowerCase()).toContain("claude-mem init");
  });

  it("(b) exits 1 when OPENROUTER_API_KEY missing", async () => {
    const projectRoot = makeTmpProject();
    await runInit({ projectRoot });
    // No OPENROUTER_API_KEY in env (beforeEach deleted it)
    const r = await runExtract({ projectRoot });
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.error?.toUpperCase()).toContain("OPENROUTER_API_KEY");
  });

  it("(c) exits 1 when extraction.enabled=false in config.json", async () => {
    const projectRoot = makeTmpProject();
    await runInit({ projectRoot });
    process.env.OPENROUTER_API_KEY = "sk-test";

    // Patch config to disable extraction
    const cfgPath = path.join(projectRoot, ".claude", "memory", "config.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    cfg.extraction = { ...cfg.extraction, enabled: false };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

    const r = await runExtract({ projectRoot });
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.error?.toLowerCase()).toMatch(/extraction.*disabled|config/);
  });
});

describe("runExtract — happy paths with injected L1 runner", () => {
  it("(d) no conversations/ dir → ok with zero counts", async () => {
    const projectRoot = makeTmpProject();
    await runInit({ projectRoot });
    process.env.OPENROUTER_API_KEY = "sk-test";

    const r = await runExtract({
      projectRoot,
      l1RunnerOverride: vi.fn().mockResolvedValue({ processedCount: 0 }),
    });
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.summary?.sessions).toBe(0);
    expect(r.summary?.l0_total).toBe(0);
    expect(r.summary?.l0_processed).toBe(0);
  });

  it("(e) enumerates unique sessionKeys from flat JSONL", async () => {
    const projectRoot = makeTmpProject();
    await runInit({ projectRoot });
    process.env.OPENROUTER_API_KEY = "sk-test";

    const jsonlPath = path.join(
      projectRoot,
      ".claude/memory/conversations/2026-05-16.jsonl",
    );
    writeJsonl(jsonlPath, [
      { sessionKey: "session-a", role: "user", content: "hi", recordedAt: "2026-05-16T10:00:00Z", timestamp: 1, id: "m1" },
      { sessionKey: "session-a", role: "assistant", content: "hello", recordedAt: "2026-05-16T10:00:01Z", timestamp: 2, id: "m2" },
      { sessionKey: "session-b", role: "user", content: "test", recordedAt: "2026-05-16T11:00:00Z", timestamp: 3, id: "m3" },
    ]);

    const l1 = vi.fn().mockResolvedValue({ processedCount: 0 });
    const r = await runExtract({ projectRoot, l1RunnerOverride: l1 });

    expect(r.ok).toBe(true);
    expect(r.summary?.sessions).toBe(2);
    // Drain calls each session at least once (returns 0 → exits drain)
    expect(l1).toHaveBeenCalledWith({ sessionKey: "session-a" });
    expect(l1).toHaveBeenCalledWith({ sessionKey: "session-b" });
  });

  it("(f) --dry-run does NOT call injected L1 runner", async () => {
    const projectRoot = makeTmpProject();
    await runInit({ projectRoot });
    process.env.OPENROUTER_API_KEY = "sk-test";

    const jsonlPath = path.join(
      projectRoot,
      ".claude/memory/conversations/2026-05-16.jsonl",
    );
    writeJsonl(jsonlPath, [
      { sessionKey: "s1", role: "user", content: "hi", recordedAt: "2026-05-16T10:00:00Z", timestamp: 1, id: "m1" },
    ]);

    const l1 = vi.fn().mockResolvedValue({ processedCount: 0 });
    const r = await runExtract({
      projectRoot,
      dryRun: true,
      l1RunnerOverride: l1,
    });

    expect(r.ok).toBe(true);
    expect(l1).not.toHaveBeenCalled();
    expect(r.summary?.sessions).toBe(1);
  });

  it("(g) --max-sessions=1 processes only first sessionKey", async () => {
    const projectRoot = makeTmpProject();
    await runInit({ projectRoot });
    process.env.OPENROUTER_API_KEY = "sk-test";

    const jsonlPath = path.join(
      projectRoot,
      ".claude/memory/conversations/2026-05-16.jsonl",
    );
    writeJsonl(jsonlPath, [
      { sessionKey: "sA", role: "user", content: "x", recordedAt: "2026-05-16T10:00:00Z", timestamp: 1, id: "m1" },
      { sessionKey: "sB", role: "user", content: "y", recordedAt: "2026-05-16T11:00:00Z", timestamp: 2, id: "m2" },
    ]);

    const l1 = vi.fn().mockResolvedValue({ processedCount: 0 });
    const r = await runExtract({
      projectRoot,
      maxSessions: 1,
      l1RunnerOverride: l1,
    });

    expect(r.ok).toBe(true);
    expect(r.summary?.sessions).toBe(1);
    expect(l1).toHaveBeenCalledTimes(1);
  });

  it("(h) drain loop: runner returns {50,50,0} → counts 100 l0_processed and 3 calls", async () => {
    const projectRoot = makeTmpProject();
    await runInit({ projectRoot });
    process.env.OPENROUTER_API_KEY = "sk-test";

    const jsonlPath = path.join(
      projectRoot,
      ".claude/memory/conversations/2026-05-16.jsonl",
    );
    writeJsonl(jsonlPath, [
      { sessionKey: "big", role: "user", content: "x", recordedAt: "2026-05-16T10:00:00Z", timestamp: 1, id: "m1" },
    ]);

    const l1 = vi
      .fn()
      .mockResolvedValueOnce({ processedCount: 50 })
      .mockResolvedValueOnce({ processedCount: 50 })
      .mockResolvedValueOnce({ processedCount: 0 });

    const r = await runExtract({ projectRoot, l1RunnerOverride: l1 });

    expect(r.ok).toBe(true);
    expect(l1).toHaveBeenCalledTimes(3);
    expect(r.summary?.l0_processed).toBe(100);
  });
});
