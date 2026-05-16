/**
 * Unit tests for MCP server tool handlers — v0.4.0
 *
 * Tests the 4 tool handler functions directly (no server spawn).
 * All external dependencies are mocked via vi.mock.
 *
 * 8 test cases:
 *   1. memory_search happy path — runRecall returns matches → stripped text
 *   2. memory_search empty — runRecall returns empty → "no matches found"
 *   3. conversation_search happy path — vector=false, returns matches
 *   4. conversation_search empty — returns "no matches found"
 *   5. recall_persona with persona → body without XML wrapper
 *   6. recall_persona absent → "(no persona.md yet...)" sentinel
 *   7. recall_scenes with scenes → scene list without XML wrapper
 *   8. recall_scenes absent → "(no scene blocks yet...)" sentinel
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (hoisted — must be before imports that use the mocked modules) ──

vi.mock("../cli/commands/recall.js", () => ({
  runRecall: vi.fn(),
}));

vi.mock("../cli/context.js", () => ({
  loadContextOrAutoInit: vi.fn(),
}));

vi.mock("../cli/commands/recall-context.js", () => ({
  readPersonaContext: vi.fn(),
  readSceneIndexContext: vi.fn(),
}));

// ── Imports (after mocks) ──────────────────────────────────────────────────

import { runRecall } from "../cli/commands/recall.js";
import { loadContextOrAutoInit } from "../cli/context.js";
import { readPersonaContext, readSceneIndexContext } from "../cli/commands/recall-context.js";

import {
  handleMemorySearch,
  handleConversationSearch,
  handleRecallPersona,
  handleRecallScenes,
} from "./server.js";

// Typed mock helpers
const mockRunRecall = vi.mocked(runRecall);
const mockLoadContext = vi.mocked(loadContextOrAutoInit);
const mockReadPersona = vi.mocked(readPersonaContext);
const mockReadScenes = vi.mocked(readSceneIndexContext);

// Fake context object returned by loadContextOrAutoInit
const FAKE_CONTEXT = {
  dataDir: "/tmp/fake-mem",
  config: {},
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
} as unknown as Awaited<ReturnType<typeof loadContextOrAutoInit>>;

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadContext.mockResolvedValue(FAKE_CONTEXT);
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("handleMemorySearch", () => {
  it("1. happy path — returns match text with XML wrapper stripped", async () => {
    mockRunRecall.mockResolvedValue({
      ok: true,
      text: "<recall-matches>\nfact: user prefers TypeScript\n</recall-matches>",
      matchCount: 1,
    });

    const result = await handleMemorySearch({ query: "TypeScript", limit: 5 });

    expect(result).toBe("fact: user prefers TypeScript");

    // Verify runRecall was called with vector=true (semantic path)
    expect(mockRunRecall).toHaveBeenCalledWith(
      expect.objectContaining({ vector: true, includePersona: false, includeScenes: false }),
    );
  });

  it("2. empty — runRecall returns empty text → 'no matches found'", async () => {
    mockRunRecall.mockResolvedValue({ ok: true, text: "", matchCount: 0 });

    const result = await handleMemorySearch({ query: "nonexistent" });

    expect(result).toBe("no matches found");
  });
});

describe("handleConversationSearch", () => {
  it("3. happy path — returns turn text with XML wrapper stripped", async () => {
    const turnText = "[2026-01-01]\nuser: hello\nassistant: hi there";
    mockRunRecall.mockResolvedValue({
      ok: true,
      text: `<recall-matches>\n${turnText}\n</recall-matches>`,
      matchCount: 1,
    });

    const result = await handleConversationSearch({ query: "hello", limit: 3 });

    expect(result).toBe(turnText);

    // Verify keyword path: vector must be false
    expect(mockRunRecall).toHaveBeenCalledWith(
      expect.objectContaining({ vector: false, includePersona: false, includeScenes: false }),
    );
  });

  it("4. empty — returns 'no matches found'", async () => {
    mockRunRecall.mockResolvedValue({ ok: true, text: "", matchCount: 0 });

    const result = await handleConversationSearch({ query: "nothing" });

    expect(result).toBe("no matches found");
  });
});

describe("handleRecallPersona", () => {
  it("5. with persona — returns body without <persona-context> wrapper", async () => {
    const personaBody = "## User Profile\n- Prefers TypeScript\n- Marketing background";
    mockReadPersona.mockReturnValue(`<persona-context>\n${personaBody}\n</persona-context>`);

    const result = await handleRecallPersona();

    expect(result).toBe(personaBody);
    expect(mockReadPersona).toHaveBeenCalledWith(FAKE_CONTEXT.dataDir);
  });

  it("6. absent — returns sentinel '(no persona.md yet...)' message", async () => {
    mockReadPersona.mockReturnValue(null);

    const result = await handleRecallPersona();

    expect(result).toBe(
      "(no persona.md yet — run `claude-mem extract` after some conversation)",
    );
  });
});

describe("handleRecallScenes", () => {
  it("7. with scenes — returns scene list without <scene-index> wrapper", async () => {
    const sceneBody =
      "- 2026-01-01.md (heat: 3) — TypeScript discussion\n- 2026-01-02.md (heat: 1) — Marketing chat";
    mockReadScenes.mockResolvedValue(`<scene-index>\n${sceneBody}\n</scene-index>`);

    const result = await handleRecallScenes();

    expect(result).toBe(sceneBody);
    expect(mockReadScenes).toHaveBeenCalledWith(FAKE_CONTEXT.dataDir);
  });

  it("8. absent — returns sentinel '(no scene blocks yet...)' message", async () => {
    mockReadScenes.mockResolvedValue(null);

    const result = await handleRecallScenes();

    expect(result).toBe(
      "(no scene blocks yet — run `claude-mem extract` after some conversation)",
    );
  });
});
