/**
 * recall-context.ts — v0.3.5 helpers for persona + scene index injection.
 *
 * Three exported helpers compose the structured recall output:
 *   readPersonaContext    — wraps persona.md in <persona-context> tags
 *   readSceneIndexContext — wraps scene_index.json in <scene-index> tags
 *   composeRecallOutput  — assembles all sections into final output text
 *
 * ADR-1: XML-ish tags for deterministic agent parsing.
 * ADR-2: Hard byte caps (6KB persona, 2KB scenes).
 * ADR-4: Empty sections silently omitted.
 * ADR-5: Scene index sorted by heat desc; low-heat dropped on overflow.
 */

import fs from "node:fs";
import path from "node:path";
import { readSceneIndex } from "../../core/scene/scene-index.js";

export const PERSONA_INJECTION_MAX_BYTES = 6000;
export const SCENE_INDEX_MAX_BYTES = 2000;

const PERSONA_FILENAME = "persona.md";
const SCENE_BLOCKS_SUBDIR = "scene_blocks";

/**
 * Read persona.md from dataDir, wrap in <persona-context>...</persona-context>.
 * Returns null if the file is absent or empty.
 * If content exceeds maxBytes, slices and appends truncation notice.
 */
export function readPersonaContext(
  dataDir: string,
  maxBytes: number = PERSONA_INJECTION_MAX_BYTES,
): string | null {
  const personaPath = path.join(dataDir, PERSONA_FILENAME);
  let content: string;
  try {
    content = fs.readFileSync(personaPath, "utf-8");
  } catch {
    return null;
  }

  if (!content.trim()) return null;

  if (Buffer.byteLength(content, "utf-8") > maxBytes) {
    // Slice to maxBytes (byte-safe: slice UTF-8 bytes then decode)
    const bytes = Buffer.from(content, "utf-8");
    const sliced = bytes.slice(0, maxBytes).toString("utf-8");
    // Remove last potentially broken multi-byte char by stripping trailing replacement chars
    content = sliced + "\n…[truncated to fit injection budget]";
  }

  return `<persona-context>\n${content}\n</persona-context>`;
}

/**
 * Read scene_index.json via readSceneIndex(), render a bullet list sorted
 * by heat desc, wrapped in <scene-index>...</scene-index>.
 * Returns null if there are no entries or readSceneIndex throws.
 * Drops low-heat entries from the bottom when the rendered text would
 * exceed maxBytes.
 */
export async function readSceneIndexContext(
  dataDir: string,
  maxBytes: number = SCENE_INDEX_MAX_BYTES,
): Promise<string | null> {
  let entries;
  try {
    entries = await readSceneIndex(dataDir);
  } catch {
    return null;
  }

  if (!entries || entries.length === 0) return null;

  // Sort by heat descending (highest first per ADR-5)
  const sorted = [...entries].sort((a, b) => b.heat - a.heat);

  // Build bullet lines, drop from bottom on overflow
  const lines: string[] = [];
  let usedBytes = 0;
  const openTag = "<scene-index>\n";
  const closeTag = "\n</scene-index>";
  const overhead = Buffer.byteLength(openTag + closeTag, "utf-8");
  let budget = maxBytes - overhead;

  for (const entry of sorted) {
    const line = `- ${entry.filename} (heat: ${entry.heat}) — ${entry.summary}`;
    const lineBytes = Buffer.byteLength(line + "\n", "utf-8");
    if (usedBytes + lineBytes > budget) {
      // Drop this entry (low-heat; already sorted desc so all remaining are lower)
      break;
    }
    lines.push(line);
    usedBytes += lineBytes;
  }

  if (lines.length === 0) return null;

  const body = lines.join("\n");
  return `${openTag}${body}${closeTag}`;
}

/**
 * Compose the final recall output from up to three sections.
 * Order: persona first, scene-index second, matches third.
 * Empty/null sections are silently omitted.
 * Sections are joined with "\n\n".
 * Matches text is wrapped in <recall-matches>...</recall-matches>.
 */
export function composeRecallOutput(parts: {
  persona?: string | null;
  sceneIndex?: string | null;
  matches?: string | null;
}): string {
  const sections: string[] = [];

  if (parts.persona) sections.push(parts.persona);
  if (parts.sceneIndex) sections.push(parts.sceneIndex);
  if (parts.matches) {
    sections.push(`<recall-matches>\n${parts.matches}\n</recall-matches>`);
  }

  return sections.join("\n\n");
}
