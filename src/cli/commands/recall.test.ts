import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { SceneIndexEntry } from "../../core/scene/scene-index.js";

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

  it("v0.3.2 regression: vector:false forces keyword path (v0.2 behavior preserved)", async () => {
    const projectRoot = makeInitializedProject();
    await runInit({ projectRoot });
    await captureN(projectRoot, [
      { user: "vector-bypass test", assistant: "keyword should match this" },
    ]);

    // Even if VOYAGE_API_KEY exists in env, vector:false short-circuits
    // BEFORE initStores → no embed call, no Voyage cost, pure keyword grep.
    const result = await runRecall({
      projectRoot,
      query: "vector-bypass",
      limit: 5,
      vector: false,
    });

    expect(result.ok).toBe(true);
    expect(result.text).toContain("vector-bypass test");
    expect(result.matchCount).toBeGreaterThanOrEqual(1);
  });

  // ── v0.3.5 regression tests ──────────────────────────────────────────────

  it("v0.3.5: output contains <persona-context> and <scene-index> when both present", async () => {
    const projectRoot = makeInitializedProject();
    await runInit({ projectRoot });
    await captureN(projectRoot, [
      { user: "hello world query", assistant: "hello back" },
    ]);

    // Determine dataDir (mirrors loadContextOrAutoInit logic: <projectRoot>/.claude/memory)
    const dataDir = path.join(projectRoot, ".claude", "memory");

    // Write persona.md
    fs.writeFileSync(path.join(dataDir, "persona.md"), "# Test Persona\nThis is the persona.", "utf-8");

    // Write scene_index.json
    const metaDir = path.join(dataDir, ".metadata");
    fs.mkdirSync(metaDir, { recursive: true });
    const sceneEntries: SceneIndexEntry[] = [
      { filename: "my-scene.md", summary: "A test scene", heat: 5, created: "", updated: "" },
    ];
    fs.writeFileSync(path.join(metaDir, "scene_index.json"), JSON.stringify(sceneEntries), "utf-8");

    const result = await runRecall({
      projectRoot,
      query: "hello",
      limit: 5,
      vector: false,
    });

    expect(result.ok).toBe(true);
    expect(result.text).toContain("<persona-context>");
    expect(result.text).toContain("</persona-context>");
    expect(result.text).toContain("<scene-index>");
    expect(result.text).toContain("</scene-index>");
    expect(result.text).toContain("<recall-matches>");
    // Persona before scene-index before matches
    const pIdx = result.text.indexOf("<persona-context>");
    const sIdx = result.text.indexOf("<scene-index>");
    const mIdx = result.text.indexOf("<recall-matches>");
    expect(pIdx).toBeLessThan(sIdx);
    expect(sIdx).toBeLessThan(mIdx);
  });

  it("v0.3.5: includePersona:false + includeScenes:false → no persona/scene tags in output", async () => {
    const projectRoot = makeInitializedProject();
    await runInit({ projectRoot });
    await captureN(projectRoot, [
      { user: "test query nopersona", assistant: "ack" },
    ]);

    const dataDir = path.join(projectRoot, ".claude", "memory");

    // Write persona.md and scene_index.json — but they should be suppressed
    fs.writeFileSync(path.join(dataDir, "persona.md"), "# Should Not Appear", "utf-8");
    const metaDir = path.join(dataDir, ".metadata");
    fs.mkdirSync(metaDir, { recursive: true });
    fs.writeFileSync(
      path.join(metaDir, "scene_index.json"),
      JSON.stringify([{ filename: "hidden.md", summary: "hidden", heat: 1, created: "", updated: "" }]),
      "utf-8",
    );

    const result = await runRecall({
      projectRoot,
      query: "nopersona",
      limit: 5,
      vector: false,
      includePersona: false,
      includeScenes: false,
    });

    expect(result.ok).toBe(true);
    expect(result.text).not.toContain("<persona-context>");
    expect(result.text).not.toContain("<scene-index>");
    // matchCount is still just the L0/L1 match count
    expect(result.matchCount).toBeGreaterThanOrEqual(1);
  });
});
