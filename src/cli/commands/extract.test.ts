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

// ═════════ v0.3.3 — L2 + L3 chain (SPEC §5 Tasks 7-8, §6 acceptance) ══
//
// All cases use injected L1+L2+L3 runners (real LLM excluded — that lives
// in the manual smoke per SPEC Task 13).  Each case asserts both the
// summary fields (v0.3.3 ExtractSummary extension) AND that exit code
// stays 0 when L2/L3 misbehave (ADR-2 fail-soft).

function setupChainProject(sessionKeys: string[] = ["s1"]) {
  const projectRoot = makeTmpProject();
  process.env.OPENROUTER_API_KEY = "sk-test";
  // runInit done inline by caller (some cases want different cfg state)
  return { projectRoot, sessionKeys };
}

async function initWithSessions(
  projectRoot: string,
  sessionKeys: string[],
): Promise<void> {
  await runInit({ projectRoot });
  const jsonlPath = path.join(projectRoot, ".claude/memory/conversations/2026-05-16.jsonl");
  writeJsonl(
    jsonlPath,
    sessionKeys.map((k, i) => ({
      sessionKey: k,
      role: "user",
      content: "x",
      recordedAt: `2026-05-16T10:00:0${i}Z`,
      timestamp: i + 1,
      id: `m${i + 1}`,
    })),
  );
}

describe("runExtract — v0.3.3 L2+L3 chain (injected runners)", () => {
  it("(i) L2 runs after L1 when l0_processed > 0", async () => {
    const { projectRoot } = setupChainProject();
    await initWithSessions(projectRoot, ["sX"]);

    const l1 = vi.fn().mockResolvedValueOnce({ processedCount: 5 }).mockResolvedValue({ processedCount: 0 });
    const l2 = vi.fn().mockResolvedValue({ latestCursor: "2026-05-16T10:00:00Z" });
    const l3 = vi.fn().mockResolvedValue(undefined);

    const r = await runExtract({
      projectRoot,
      l1RunnerOverride: l1,
      l2RunnerOverride: l2,
      l3RunnerOverride: l3,
    });

    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(l2).toHaveBeenCalledTimes(1);
    expect(l2).toHaveBeenCalledWith("sX", undefined);
    expect(r.summary?.l2_scenes_processed).toBe(1);
    expect(r.summary?.failed_l2_sessions).toBe(0);
  });

  it("(j) L2 skipped when L1 produced zero records (no point in re-scanning)", async () => {
    const { projectRoot } = setupChainProject();
    await initWithSessions(projectRoot, ["sX"]);

    // L1 returns 0 immediately → l0Processed=0 → chain skipped
    const l1 = vi.fn().mockResolvedValue({ processedCount: 0 });
    const l2 = vi.fn();
    const l3 = vi.fn();

    const r = await runExtract({
      projectRoot,
      l1RunnerOverride: l1,
      l2RunnerOverride: l2,
      l3RunnerOverride: l3,
    });

    expect(r.ok).toBe(true);
    expect(l2).not.toHaveBeenCalled();
    expect(l3).not.toHaveBeenCalled();
    expect(r.summary?.l2_scenes_processed).toBe(0);
    expect(r.summary?.l3_attempted).toBe(false);
  });

  it("(k) L2 failure swallowed; exit code stays 0; counter incremented", async () => {
    const { projectRoot } = setupChainProject();
    await initWithSessions(projectRoot, ["sFail"]);

    const l1 = vi.fn().mockResolvedValueOnce({ processedCount: 3 }).mockResolvedValue({ processedCount: 0 });
    const l2 = vi.fn().mockRejectedValue(new Error("L2 boom"));
    const l3 = vi.fn().mockResolvedValue(undefined);

    const r = await runExtract({
      projectRoot,
      l1RunnerOverride: l1,
      l2RunnerOverride: l2,
      l3RunnerOverride: l3,
    });

    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0); // ADR-2: L2 failure does NOT bump exit code
    expect(r.summary?.failed_l2_sessions).toBe(1);
    expect(r.summary?.l2_scenes_processed).toBe(0); // increment is in success branch only
    // L3 still attempted despite L2 failure
    expect(l3).toHaveBeenCalledTimes(1);
    expect(r.summary?.l3_attempted).toBe(true);
  });

  it("(l) L3 attempted exactly once after L2 loop; l3_attempted=true", async () => {
    const { projectRoot } = setupChainProject();
    await initWithSessions(projectRoot, ["sA", "sB"]);

    const l1 = vi
      .fn()
      .mockImplementation(({ sessionKey }: { sessionKey: string }) => {
        // each session: one batch of 4 then drain stop
        // simple stateful per-call: use call count as proxy
        return Promise.resolve({ processedCount: sessionKey === "sA" ? 4 : 2 });
      });
    // Need to make drain terminate — use sequential mock
    l1.mockReset();
    l1.mockResolvedValueOnce({ processedCount: 4 })  // sA iter 1
      .mockResolvedValueOnce({ processedCount: 0 })  // sA iter 2 (stop)
      .mockResolvedValueOnce({ processedCount: 2 })  // sB iter 1
      .mockResolvedValueOnce({ processedCount: 0 }); // sB iter 2 (stop)

    const l2 = vi.fn().mockResolvedValue({ latestCursor: "c1" });
    const l3 = vi.fn().mockResolvedValue(undefined);

    const r = await runExtract({
      projectRoot,
      l1RunnerOverride: l1,
      l2RunnerOverride: l2,
      l3RunnerOverride: l3,
    });

    expect(r.ok).toBe(true);
    expect(l3).toHaveBeenCalledTimes(1); // ADR-3: once per extract
    expect(l2).toHaveBeenCalledTimes(2); // once per session
    expect(r.summary?.l3_attempted).toBe(true);
  });

  it("(m) L3 NOT attempted when chain skipped (all L1 failed)", async () => {
    const { projectRoot } = setupChainProject();
    await initWithSessions(projectRoot, ["sBad"]);

    const l1 = vi.fn().mockRejectedValue(new Error("L1 dead"));
    const l2 = vi.fn();
    const l3 = vi.fn();

    const r = await runExtract({
      projectRoot,
      l1RunnerOverride: l1,
      l2RunnerOverride: l2,
      l3RunnerOverride: l3,
    });

    // L1 failure → exit 1 (all sessions failed)
    expect(r.exitCode).toBe(1);
    expect(l2).not.toHaveBeenCalled();
    expect(l3).not.toHaveBeenCalled();
    expect(r.summary?.l3_attempted).toBe(false);
  });

  it("(n) L3 failure swallowed; l3_failed=true; exit code stays 0", async () => {
    const { projectRoot } = setupChainProject();
    await initWithSessions(projectRoot, ["sX"]);

    const l1 = vi.fn().mockResolvedValueOnce({ processedCount: 7 }).mockResolvedValue({ processedCount: 0 });
    const l2 = vi.fn().mockResolvedValue({ latestCursor: "c1" });
    const l3 = vi.fn().mockRejectedValue(new Error("L3 boom"));

    const r = await runExtract({
      projectRoot,
      l1RunnerOverride: l1,
      l2RunnerOverride: l2,
      l3RunnerOverride: l3,
    });

    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0); // ADR-2: L3 failure swallowed
    expect(r.summary?.l3_attempted).toBe(true);
    expect(r.summary?.l3_failed).toBe(true);
    expect(r.summary?.l3_persona_bytes).toBeUndefined();
  });

  it("(o) l3_persona_bytes populated when persona.md grows (mtime+size diff)", async () => {
    const { projectRoot } = setupChainProject();
    await initWithSessions(projectRoot, ["sX"]);

    const personaPath = path.join(projectRoot, ".claude/memory/persona.md");
    // pre-state: empty (file absent)
    const l1 = vi.fn().mockResolvedValueOnce({ processedCount: 5 }).mockResolvedValue({ processedCount: 0 });
    const l2 = vi.fn().mockResolvedValue({ latestCursor: "c1" });
    const l3 = vi.fn().mockImplementation(async () => {
      // Simulate L3 writing persona.md
      fs.writeFileSync(
        personaPath,
        "# Persona\n\n" + "Some generated content. ".repeat(50),
      );
    });

    const r = await runExtract({
      projectRoot,
      l1RunnerOverride: l1,
      l2RunnerOverride: l2,
      l3RunnerOverride: l3,
    });

    expect(r.ok).toBe(true);
    expect(r.summary?.l3_attempted).toBe(true);
    expect(r.summary?.l3_failed).toBe(false);
    expect(r.summary?.l3_persona_bytes).toBeGreaterThan(500);
  });

  it("(p) summary fields default to 0/false when chain doesn't run", async () => {
    const { projectRoot } = setupChainProject();
    await initWithSessions(projectRoot, ["sX"]);

    const l1 = vi.fn().mockResolvedValue({ processedCount: 0 }); // no L1 work
    const r = await runExtract({
      projectRoot,
      l1RunnerOverride: l1,
      // No l2/l3 overrides — but chain skipped due to l0_processed=0 anyway
    });

    expect(r.summary?.l2_scenes_processed).toBe(0);
    expect(r.summary?.failed_l2_sessions).toBe(0);
    expect(r.summary?.l3_attempted).toBe(false);
    expect(r.summary?.l3_failed).toBe(false);
    expect(r.summary?.l3_persona_bytes).toBeUndefined();
  });
});
