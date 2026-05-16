/**
 * Scene navigation: generates a summary navigation section appended to persona.md.
 *
 * The navigation includes **absolute** file paths so the agent can directly
 * use read_file for on-demand scene loading (progressive disclosure).
 */

import path from "node:path";
import type { SceneIndexEntry } from "./scene-index.js";

const NAV_HEADER = "---\n## 🗺️ Scene Navigation (Scene Index)";

const NAV_FOOTER = `📌 How to use:
- Path is the absolute path to the scene block — use read_file to load the full content directly.
- Heat: cumulative number of times this scene was hit by memories — higher = more important.
- Summary: condensed key points of the scene.`;

/**
 * Build a fire-emoji string based on heat value (visual priority cue for the agent).
 */
function heatEmoji(heat: number): string {
  if (heat >= 1000) return " 🔥🔥🔥🔥🔥";
  if (heat >= 500) return " 🔥🔥🔥🔥";
  if (heat >= 200) return " 🔥🔥🔥";
  if (heat >= 100) return " 🔥🔥";
  if (heat >= 50) return " 🔥";
  return "";
}

/**
 * Generate the scene navigation Markdown section.
 *
 * @param entries - Scene index entries
 * @param dataDir - Absolute path to the plugin data directory; when provided,
 *                  scene paths are rendered as absolute paths so the agent can
 *                  call read_file directly without path concatenation.
 */
export function generateSceneNavigation(entries: SceneIndexEntry[], dataDir?: string): string {
  if (entries.length === 0) return "";

  const sorted = [...entries].sort((a, b) => b.heat - a.heat);

  const blocks = sorted.map((e) => {
    const scenePath = dataDir
      ? path.join(dataDir, "scene_blocks", e.filename)
      : `scene_blocks/${e.filename}`;
    const pathLine = `### Path: ${scenePath}`;
    const heatLine = `**Heat**: ${e.heat}${heatEmoji(e.heat)}${e.updated ? ` | **Updated**: ${e.updated}` : ""}`;
    const summaryLine = `Summary: ${e.summary}`;
    return `${pathLine}\n${heatLine}\n${summaryLine}`;
  });

  return `${NAV_HEADER}\n*Index of current scene memories. Use read_file on demand to fetch full content.*\n\n${blocks.join("\n\n")}\n\n${NAV_FOOTER}`;
}

/**
 * Strip the scene navigation section from persona content.
 */
export function stripSceneNavigation(personaContent: string): string {
  const idx = personaContent.indexOf(NAV_HEADER);
  if (idx === -1) return personaContent;
  return personaContent.slice(0, idx).trimEnd();
}
