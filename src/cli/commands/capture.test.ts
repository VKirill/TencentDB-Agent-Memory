import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { runCapture } from "./capture.js";
import { runInit } from "./init.js";

/**
 * Test plan (SPEC §5 Task 15):
 *  1. stdin JSON {user, assistant} writes L0 row to <dataDir>/conversations/.
 *  2. missing OPENROUTER_API_KEY still writes L0 + ok=true (capture is
 *     pre-pipeline; no LLM call needed at write time).
 *  3. malformed JSON → ok=false + error logged to memory.log (CLI wraps
 *     to exit 0 per hook discipline).
 */

const tmpDirs: string[] = [];

function makeInitializedProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-capture-"));
  tmpDirs.push(root);
  return root;
}

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
    if (originalValues[k] === undefined) delete process.env[k];
    else process.env[k] = originalValues[k];
  }
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("runCapture", () => {
  it("writes an L0 row to conversations/ from stdin JSON", async () => {
    const projectRoot = makeInitializedProject();
    await runInit({ projectRoot });

    const input = JSON.stringify({
      user: "hello from test",
      assistant: "hi back from test",
    });

    const result = await runCapture({ projectRoot, stdin: input });

    expect(result.ok).toBe(true);
    expect(result.l0Recorded).toBeGreaterThanOrEqual(1);

    const conversationsDir = path.join(projectRoot, ".claude", "memory", "conversations");
    expect(fs.existsSync(conversationsDir)).toBe(true);
    // l0-recorder writes per-session subdirs; just verify at least one JSONL exists
    const files = findFilesRecursive(conversationsDir).filter((p) => p.endsWith(".jsonl"));
    expect(files.length).toBeGreaterThanOrEqual(1);

    const allContent = files.map((f) => fs.readFileSync(f, "utf-8")).join("\n");
    expect(allContent).toContain("hello from test");
    expect(allContent).toContain("hi back from test");
  });

  it("ok=true even with missing OPENROUTER_API_KEY (capture is pre-LLM)", async () => {
    const projectRoot = makeInitializedProject();
    await runInit({ projectRoot });

    // OPENROUTER_API_KEY explicitly unset by beforeEach
    expect(process.env.OPENROUTER_API_KEY).toBeUndefined();

    const result = await runCapture({
      projectRoot,
      stdin: JSON.stringify({ user: "no key needed", assistant: "ok" }),
    });

    expect(result.ok).toBe(true);
    expect(result.l0Recorded).toBeGreaterThanOrEqual(1);
  });

  it("ok=false with error on malformed JSON; no throw", async () => {
    const projectRoot = makeInitializedProject();
    await runInit({ projectRoot });

    const result = await runCapture({
      projectRoot,
      stdin: "{not valid json",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    // Error written to memory.log (logger discipline)
    const logPath = path.join(projectRoot, ".claude", "memory", "memory.log");
    if (fs.existsSync(logPath)) {
      const log = fs.readFileSync(logPath, "utf-8");
      expect(log.toLowerCase()).toMatch(/json|parse|capture/);
    }
  });

  it("dedup: skips identical payload; appends different payload", async () => {
    const projectRoot = makeInitializedProject();
    await runInit({ projectRoot });

    const firstInput = JSON.stringify({
      user: "dedup test question",
      assistant: "dedup test answer",
    });

    // First call — should write normally.
    const result1 = await runCapture({ projectRoot, stdin: firstInput });
    expect(result1.ok).toBe(true);
    expect(result1.l0Recorded).toBeGreaterThanOrEqual(1);

    const conversationsDir = path.join(projectRoot, ".claude", "memory", "conversations");
    const getLineCount = () => {
      const files = findFilesRecursive(conversationsDir).filter((p) => p.endsWith(".jsonl"));
      return files.map((f) => fs.readFileSync(f, "utf-8").split("\n").filter((l) => l.trim().length > 0).length).reduce((a, b) => a + b, 0);
    };

    const linesAfterFirst = getLineCount();
    expect(linesAfterFirst).toBeGreaterThanOrEqual(1);

    // Second call with identical payload — should be skipped.
    const result2 = await runCapture({ projectRoot, stdin: firstInput });
    expect(result2.ok).toBe(true);
    expect(result2.l0Recorded).toBe(0);
    expect(getLineCount()).toBe(linesAfterFirst); // no new lines appended

    // Third call with a different payload — should append.
    const differentInput = JSON.stringify({
      user: "a different question",
      assistant: "a different answer",
    });
    const result3 = await runCapture({ projectRoot, stdin: differentInput });
    expect(result3.ok).toBe(true);
    expect(result3.l0Recorded).toBeGreaterThanOrEqual(1);
    expect(getLineCount()).toBeGreaterThan(linesAfterFirst); // new lines appended
  });
});

function findFilesRecursive(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findFilesRecursive(full));
    else out.push(full);
  }
  return out;
}
