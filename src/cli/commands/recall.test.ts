import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { runRecall } from "./recall.js";
import { runInit } from "./init.js";
import { runCapture } from "./capture.js";

/**
 * Test plan (SPEC §5 Task 17):
 *  1. A captured turn is returned by recall --query <substring>.
 *  2. --limit N truncates the result count.
 *  3. Total output is bounded to ≤4000 chars (hook context budget).
 *  4. recall against empty memory returns ok=true with empty text — no
 *     throw, no API key required. (SPEC originally framed this as
 *     "missing OPENROUTER_API_KEY"; in v0.1 recall is keyword-only and
 *     never needs the LLM key. The empty-state branch is the relevant
 *     behavior to assert.)
 */

const tmpDirs: string[] = [];

function makeInitializedProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-recall-"));
  tmpDirs.push(root);
  return root;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

async function captureN(projectRoot: string, turns: Array<{ user: string; assistant: string }>): Promise<void> {
  for (const t of turns) {
    await runCapture({ projectRoot, stdin: JSON.stringify(t) });
  }
}

describe("runRecall", () => {
  it("returns a captured turn that matches the query substring", async () => {
    const projectRoot = makeInitializedProject();
    await runInit({ projectRoot });
    await captureN(projectRoot, [
      { user: "how do I use the foobar widget?", assistant: "use foobar.init()" },
    ]);

    const result = await runRecall({ projectRoot, query: "foobar", limit: 5 });

    expect(result.ok).toBe(true);
    expect(result.text).toContain("foobar");
    expect(result.matchCount).toBeGreaterThanOrEqual(1);
  });

  it("respects --limit by returning at most N matches", async () => {
    const projectRoot = makeInitializedProject();
    await runInit({ projectRoot });
    await captureN(projectRoot, [
      { user: "common keyword turn 1", assistant: "ack 1" },
      { user: "common keyword turn 2", assistant: "ack 2" },
      { user: "common keyword turn 3", assistant: "ack 3" },
      { user: "common keyword turn 4", assistant: "ack 4" },
      { user: "common keyword turn 5", assistant: "ack 5" },
    ]);

    const result = await runRecall({ projectRoot, query: "common", limit: 2 });

    expect(result.ok).toBe(true);
    expect(result.matchCount).toBeLessThanOrEqual(2);
  });

  it("caps total output text at 4000 chars", async () => {
    const projectRoot = makeInitializedProject();
    await runInit({ projectRoot });

    const longText = "X".repeat(500);
    const turns: Array<{ user: string; assistant: string }> = [];
    for (let i = 0; i < 30; i++) {
      turns.push({ user: `${longText} marker ${i}`, assistant: longText });
    }
    await captureN(projectRoot, turns);

    const result = await runRecall({ projectRoot, query: "marker", limit: 100 });

    expect(result.ok).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(4000);
  });

  it("returns ok=true with empty text against an empty memory", async () => {
    const projectRoot = makeInitializedProject();
    await runInit({ projectRoot });
    // No captures.

    const result = await runRecall({ projectRoot, query: "anything", limit: 5 });

    expect(result.ok).toBe(true);
    expect(result.matchCount).toBe(0);
    expect(result.text).toBe("");
  });
});
