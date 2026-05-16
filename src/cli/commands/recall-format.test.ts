import { describe, expect, it } from "vitest";
import { formatL1Match, formatL1SearchResult } from "./recall-format.js";

describe("formatL1Match", () => {
  it("formats type + scene + content + score", () => {
    expect(
      formatL1Match({
        type: "persona",
        scene_name: "我（AI）在和用户讨论React",
        content: "User prefers TypeScript strict mode",
        score: 0.8421,
      }),
    ).toBe("[persona|我（AI）在和用户讨论React] User prefers TypeScript strict mode (0.84)");
  });

  it("trims content over 200 chars with ellipsis", () => {
    const long = "x".repeat(250);
    const result = formatL1Match({
      type: "episodic",
      scene_name: "scene",
      content: long,
      score: 0.5,
    });
    expect(result.length).toBeLessThanOrEqual(230); // CONTENT_MAX 200 + 30 wrapper chars budget
    expect(result).toContain("…");
  });

  it("trims long scene to tail (30 chars with leading ellipsis)", () => {
    const longScene = "a".repeat(60);
    const result = formatL1Match({
      type: "instruction",
      scene_name: longScene,
      content: "x",
      score: 0.9,
    });
    expect(result).toMatch(/\[instruction\|…a+\]/);
  });

  it("handles empty scene → '?'", () => {
    expect(
      formatL1Match({ type: "persona", scene_name: "", content: "x", score: 0.5 }),
    ).toBe("[persona|?] x (0.50)");
  });

  it("handles non-finite score → '?'", () => {
    expect(
      formatL1Match({ type: "persona", scene_name: "s", content: "x", score: NaN }),
    ).toBe("[persona|s] x (?)");
  });

  it("collapses whitespace in content", () => {
    expect(
      formatL1Match({
        type: "episodic",
        scene_name: "s",
        content: "multi\n\nline   spaced",
        score: 0.5,
      }),
    ).toBe("[episodic|s] multi line spaced (0.50)");
  });

  it("formatL1SearchResult adapts full IMemoryStore L1SearchResult", () => {
    const full = {
      record_id: "r1",
      content: "Decided to use SQLite for memory",
      type: "instruction",
      priority: 3,
      scene_name: "scene-architecture-decision",
      score: 0.71,
      timestamp_str: "2026-05-16",
      timestamp_start: "2026-05-16T10:00:00Z",
      timestamp_end: "2026-05-16T10:05:00Z",
      session_key: "sk",
      session_id: "si",
      metadata_json: "{}",
    };
    expect(formatL1SearchResult(full)).toBe(
      "[instruction|scene-architecture-decision] Decided to use SQLite for memory (0.71)",
    );
  });
});
