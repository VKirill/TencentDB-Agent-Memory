/**
 * recall-context.test.ts — unit tests for v0.3.5 persona + scene helpers.
 *
 * 6 cases per SPEC §6 TDD checklist:
 *  1. readPersonaContext with present persona.md → wrapped <persona-context> block
 *  2. readPersonaContext with absent file → returns null
 *  3. readPersonaContext exceeding maxBytes → truncated with suffix
 *  4. readSceneIndexContext with 3 scenes of different heat → sorted heat desc
 *  5. readSceneIndexContext with no scenes → returns null
 *  6. composeRecallOutput ordering: persona first, scene-index second, matches third
 *
 * Fixtures: real fs temp dirs (no import mocking). scene_index.json written
 * directly to simulate what syncSceneIndex would produce.
 */

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  readPersonaContext,
  readSceneIndexContext,
  composeRecallOutput,
  PERSONA_INJECTION_MAX_BYTES,
  SCENE_INDEX_MAX_BYTES,
} from "./recall-context.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-recall-ctx-"));
  tmpDirs.push(dir);
  return dir;
}

function writePersona(dataDir: string, content: string): void {
  fs.writeFileSync(path.join(dataDir, "persona.md"), content, "utf-8");
}

function writeSceneIndex(dataDir: string, entries: unknown[]): void {
  const metaDir = path.join(dataDir, ".metadata");
  fs.mkdirSync(metaDir, { recursive: true });
  fs.writeFileSync(path.join(metaDir, "scene_index.json"), JSON.stringify(entries), "utf-8");
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

describe("readPersonaContext", () => {
  it("case 1: returns wrapped block when persona.md is present", () => {
    const dir = makeTmpDir();
    writePersona(dir, "# My Persona\nI am a developer.");

    const result = readPersonaContext(dir);

    expect(result).not.toBeNull();
    expect(result!.startsWith("<persona-context>")).toBe(true);
    expect(result!.endsWith("</persona-context>")).toBe(true);
    expect(result!).toContain("# My Persona");
    expect(result!).toContain("I am a developer.");
  });

  it("case 2: returns null when persona.md is absent", () => {
    const dir = makeTmpDir();
    // No persona.md written

    const result = readPersonaContext(dir);

    expect(result).toBeNull();
  });

  it("case 3: truncates content when it exceeds maxBytes", () => {
    const dir = makeTmpDir();
    // Write content that is clearly longer than the small cap we use for testing
    const longContent = "A".repeat(200);
    writePersona(dir, longContent);

    const result = readPersonaContext(dir, 50);

    expect(result).not.toBeNull();
    expect(result!).toContain("…[truncated to fit injection budget]");
    // The whole thing (including tags) should not be excessively long
    // The content portion is capped at 50 bytes, but tags add overhead
    // Verify the truncation marker is present
    expect(result!.startsWith("<persona-context>")).toBe(true);
    expect(result!.endsWith("</persona-context>")).toBe(true);
  });
});

describe("readSceneIndexContext", () => {
  it("case 4: output sorted heat desc when 3 scenes with different heat values", async () => {
    const dir = makeTmpDir();
    writeSceneIndex(dir, [
      { filename: "low-heat.md", summary: "Low scene", heat: 1, created: "", updated: "" },
      { filename: "high-heat.md", summary: "High scene", heat: 10, created: "", updated: "" },
      { filename: "mid-heat.md", summary: "Mid scene", heat: 5, created: "", updated: "" },
    ]);

    const result = await readSceneIndexContext(dir);

    expect(result).not.toBeNull();
    expect(result!.startsWith("<scene-index>")).toBe(true);
    expect(result!.endsWith("</scene-index>")).toBe(true);
    // All 3 present
    expect(result!).toContain("high-heat.md");
    expect(result!).toContain("mid-heat.md");
    expect(result!).toContain("low-heat.md");
    // heat desc order: high before mid before low
    const hiIdx = result!.indexOf("high-heat.md");
    const midIdx = result!.indexOf("mid-heat.md");
    const lowIdx = result!.indexOf("low-heat.md");
    expect(hiIdx).toBeLessThan(midIdx);
    expect(midIdx).toBeLessThan(lowIdx);
  });

  it("case 5: returns null when scene index is empty or absent", async () => {
    const dir = makeTmpDir();
    // No scene_index.json written at all → readSceneIndex returns []

    const result = await readSceneIndexContext(dir);

    expect(result).toBeNull();
  });

  it("case 5b: returns null when scene_index.json exists but has empty array", async () => {
    const dir = makeTmpDir();
    writeSceneIndex(dir, []);

    const result = await readSceneIndexContext(dir);

    expect(result).toBeNull();
  });
});

describe("composeRecallOutput", () => {
  it("case 6: ordering is persona → scene-index → matches; empty sections omitted", () => {
    const persona = "<persona-context>\nPersona body.\n</persona-context>";
    const sceneIndex = "<scene-index>\n- scene.md (heat: 3) — Some scene\n</scene-index>";
    const matches = "match line 1\nmatch line 2";

    const result = composeRecallOutput({ persona, sceneIndex, matches });

    // All three sections present
    expect(result).toContain("<persona-context>");
    expect(result).toContain("<scene-index>");
    expect(result).toContain("<recall-matches>");
    expect(result).toContain("match line 1");

    // Ordering check
    const pIdx = result.indexOf("<persona-context>");
    const sIdx = result.indexOf("<scene-index>");
    const mIdx = result.indexOf("<recall-matches>");
    expect(pIdx).toBeLessThan(sIdx);
    expect(sIdx).toBeLessThan(mIdx);
  });

  it("case 6b: empty/null sections silently omitted", () => {
    const result = composeRecallOutput({ persona: null, sceneIndex: null, matches: "only matches" });

    expect(result).not.toContain("<persona-context>");
    expect(result).not.toContain("<scene-index>");
    expect(result).toContain("<recall-matches>");
    expect(result).toContain("only matches");
  });

  it("case 6c: all sections null/undefined → returns empty string", () => {
    const result = composeRecallOutput({});

    expect(result).toBe("");
  });
});
