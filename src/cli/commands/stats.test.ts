import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { runStats } from "./stats.js";
import { runInit } from "./init.js";
import { runCapture } from "./capture.js";

/**
 * Test plan (SPEC §5 Task 19):
 *  1. Empty memory: ok=true, l0TurnCount = 0, all aggregate fields zeroed.
 *  2. After N captures: l0TurnCount === N, totalBytes > 0.
 */

const tmpDirs: string[] = [];

function makeInitializedProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-stats-"));
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

describe("runStats", () => {
  it("returns zeroed report against an empty memory", async () => {
    const projectRoot = makeInitializedProject();
    await runInit({ projectRoot });

    const result = await runStats({ projectRoot });

    expect(result.ok).toBe(true);
    expect(result.l0TurnCount).toBe(0);
    expect(result.l0MessageCount).toBe(0);
    expect(result.conversationsDirBytes).toBe(0);
    expect(result.lastCaptureAt).toBeUndefined();
  });

  it("returns non-zero counts after captures", async () => {
    const projectRoot = makeInitializedProject();
    await runInit({ projectRoot });

    await runCapture({
      projectRoot,
      stdin: JSON.stringify({ user: "first", assistant: "1" }),
    });
    await runCapture({
      projectRoot,
      stdin: JSON.stringify({ user: "second", assistant: "2" }),
    });
    await runCapture({
      projectRoot,
      stdin: JSON.stringify({ user: "third", assistant: "3" }),
    });

    const result = await runStats({ projectRoot });

    expect(result.ok).toBe(true);
    expect(result.l0TurnCount).toBe(3);
    // 3 turns × 2 messages each = 6 L0 messages
    expect(result.l0MessageCount).toBe(6);
    expect(result.conversationsDirBytes).toBeGreaterThan(0);
    expect(typeof result.lastCaptureAt).toBe("string");
  });
});
