/**
 * recall-format — CLI-local formatter for L1 search results.
 *
 * v0.3.2 formats vector recall hits as a single readable line per
 * memory. NOT to be confused with the hooks/auto-recall pipeline,
 * which has its own L2/L3 awareness — CLI is deliberately L1-only
 * until v0.3.3 wires scene blocks + persona.
 *
 * Format: `[type|scene] content (score)`
 *   type     — persona | episodic | instruction (from L1 schema)
 *   scene    — scene_name short-tail (last 30 chars; full scenes are
 *              Chinese and can be 50+ chars per Tencent's L1 prompt)
 *   content  — memory text, truncated to 200 chars
 *   score    — cosine similarity rounded to 2 decimals
 */

import type { L1SearchResult } from "../../core/store/types.js";

const CONTENT_MAX = 200;
const SCENE_TAIL = 30;

export interface FormattableL1 {
  type: string;
  scene_name: string;
  content: string;
  score: number;
}

/**
 * Format a single L1 search hit as one line. Exported separately so
 * tests can construct lightweight L1-like objects without depending
 * on the full L1SearchResult shape (record_id, timestamps, etc.).
 */
export function formatL1Match(m: FormattableL1): string {
  const scene = trimScene(m.scene_name);
  const content = trimContent(m.content);
  const score = formatScore(m.score);
  return `[${m.type}|${scene}] ${content} (${score})`;
}

/** Convenience adapter for full L1SearchResult from the store. */
export function formatL1SearchResult(r: L1SearchResult): string {
  return formatL1Match({
    type: r.type,
    scene_name: r.scene_name,
    content: r.content,
    score: r.score,
  });
}

function trimContent(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat.length <= CONTENT_MAX) return flat;
  return flat.slice(0, CONTENT_MAX - 1) + "…";
}

function trimScene(s: string): string {
  const flat = (s || "").trim();
  if (!flat) return "?";
  if (flat.length <= SCENE_TAIL) return flat;
  return "…" + flat.slice(-(SCENE_TAIL - 1));
}

function formatScore(n: number): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "?";
  return n.toFixed(2);
}
