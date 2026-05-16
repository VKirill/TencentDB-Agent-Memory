/**
 * Persona Generation Prompt — instructs LLM to generate/update user persona
 * as a coder profile (tech stack, infra, workflows, hard rules).
 *
 * v3: Split into systemPrompt (role + constraints + logic + template) and
 * userPrompt (data). Tool names aligned to OpenClaw actual API (write/edit).
 *
 * v0.3.3.1: Localized to English (fork-level). The original Tencent prompt
 * was Chinese; this rewrite preserves all semantics, the 4-layer scan
 * structure, and the same write/edit tool contract. Output language is
 * English by default — the persona.md the LLM writes will be English.
 *
 * v0.3.6: Rewrote PERSONA_SYSTEM_PROMPT to produce a coder profile instead
 * of Tencent's archetype/lifestyle template. 8 concrete sections (Stack,
 * Infrastructure, Workflow conventions, Hard rules, Active projects,
 * Communication preferences, Decision patterns, Open / pending). Cap bumped
 * 2000 → 3000 chars. No archetype, lifestyle, or psychological inference.
 */

export interface PersonaPromptParams {
  mode: "first" | "incremental";
  currentTime: string;
  totalProcessed: number;
  sceneCount: number;
  changedSceneCount: number;
  changedScenesContent: string;
  existingPersona?: string;
  triggerInfo?: string;
  /** @deprecated Kept for call-site compatibility; no longer used in prompt. */
  personaFilePath: string;
  /** @deprecated Kept for call-site compatibility; no longer used in prompt. */
  checkpointPath: string;
}

export interface PersonaPromptResult {
  systemPrompt: string;
  userPrompt: string;
}

// ============================
// System Prompt (stable: role + constraints + logic + template)
// ============================

const PERSONA_SYSTEM_PROMPT = `# 🛠️ Coder Profile Architect — Incremental Evolution Protocol

Combine the existing persona.md with the new / changed scene blocks. Distil concrete, actionable facts about how this developer works — tech stack, infrastructure, workflows, hard rules — and write the result to persona.md using the file tools. **All output in English.**

## ⛔ File Operation Constraints (strict)

1. **You MUST use the file tools to write the final persona content to \`persona.md\`.** The current working directory is already set to the data directory — use the bare filename \`persona.md\`.
   - **First generation / major rewrite**: use the **write** tool. Params: \`path\`=\`persona.md\`, \`content\`=full content
   - **Incremental update (partial edits)**: use the **edit** tool. Params: \`path\`=\`persona.md\`, \`edits\`=[{\`oldText\`: old snippet, \`newText\`: new snippet}]
2. **Only operate on the \`persona.md\` file.** Do not read or write any other file (including scene_blocks/, .metadata/, etc.).
3. **The content you write must contain only the final persona document** — no thinking, no analysis steps, no non-persona content.
4. **No need for a read tool**: the full current persona.md is provided in the user message; update directly from it.

### 🚫 Hard prohibitions
- **Cap: 3000 characters total.** Summarize aggressively and drop lower-priority facts as the file grows.
- **No personality archetypes, lifestyle observations, or "psychological" inferences.** Concrete, verifiable facts only.
- **No content from non-scene sources.** Do not extract info from workspace directory structure, file paths, system metadata, or any other technical fingerprint not present in the scene data.
- **Skip categories where you have no concrete evidence** — omit the header entirely (don't write \`## Stack\n(empty)\`).
- **Do not touch any file other than persona.md.**
- **Do not use the words**: "Archetype", "Texture of Life", "Anthropological", "narrative coherence" — those concepts are removed.

---

## ⚙️ What to capture (the only sections allowed)

Use exactly these 8 sections — omit any section you have no evidence for. Omit the header entirely when a section is empty.

### Stack
Languages, runtimes (with versions), frameworks, package managers, databases, key libraries. Bullet list. Most-used first.

### Infrastructure
Servers (IP / domain), DNS, deploy targets, monitoring, secrets management. Bullet list. Concrete identifiers only.

### Workflow conventions
Branching / commit / PR / testing / review patterns. How features get shipped (worktree per feature? per-task commit? test-verifier discipline?). Bullet list.

### Hard rules (do not violate)
Things the developer explicitly forbade or set as inviolable. E.g. file size caps, "never push to main without explicit ask", "always run X before Y". Bullet list. Each rule must be enforceable by an agent.

### Active projects
Currently-in-flight projects: name, repo / path, role of the developer, current state. Bullet list. Drop completed / abandoned.

### Communication preferences
Language (English / Russian / mixed?), verbosity (terse / detailed?), register (technical / plain?), formatting (markdown / prose?). Bullet list.

### Decision patterns
How trade-offs are evaluated: quality vs cost, speed vs correctness, build vs buy. Bullet list. Distil from observed choices, not stated values.

### Open / pending
What's currently being figured out, blockers, things deferred to "later". Bullet list. Drop items as they get resolved.

---

## 📝 Output template

\`\`\`markdown
# Coder Profile

> Last updated: {{CURRENT_TIME}}

## Stack
- ...

## Infrastructure
- ...

## Workflow conventions
- ...

## Hard rules
- ...

## Active projects
- ...

## Communication preferences
- ...

## Decision patterns
- ...

## Open / pending
- ...
\`\`\`

---

### ⚠️ Success criteria
- ✅ **You MUST use the write or edit tool to commit the final result to \`persona.md\`.**
- ✅ Only the 8 sections listed above may appear — no other section headers.
- ✅ Total character count stays under 3000. Summarize aggressively.
- ✅ **Write everything in English.**
- ✅ No archetype wording: "Archetype", "Texture of Life", "Anthropological", "narrative coherence" must not appear anywhere.
- ✅ Operate on persona.md only — no other files touched.`;

// ============================
// User Prompt builder (dynamic data)
// ============================

export function buildPersonaPrompt(params: PersonaPromptParams): PersonaPromptResult {
  const {
    mode,
    currentTime,
    totalProcessed,
    sceneCount,
    changedSceneCount,
    changedScenesContent,
    existingPersona,
    triggerInfo,
  } = params;

  const modeLabel = mode === "first" ? "🆕 First generation (coder profile)" : "🔄 Incremental update";

  const triggerSection = triggerInfo
    ? `\n### Trigger info\n${triggerInfo}\n`
    : "";

  const existingPersonaSection = existingPersona
    ? `\n## 📄 Current Persona (preloaded by the engine)\n\n` +
      `*Full content of the existing persona.md (${existingPersona.length} chars). When updating, keep total length under 3000 chars:*\n\n` +
      `\`\`\`markdown\n${existingPersona}\n\`\`\`\n\n---\n`
    : "";

  const iterationGuide = mode === "incremental"
    ? `\n## 🔄 Iteration decision guide\n\n` +
      `For each changed scene, decide independently: REINFORCE (confirms an existing fact) / ADD (new dimension) / CORRECT (resolves a contradiction) / RESTRUCTURE (structural change) / NO-CHANGE (no useful new content).\n`
    : "";

  const userPrompt = `**⏰ Update time**: ${currentTime}
**Mode**: ${modeLabel}
${triggerSection}
## 📊 Statistics
- **Total memories**: ${totalProcessed}
- **Total scenes**: ${sceneCount}
- **Changed scenes**: ${changedSceneCount} (since last update)

---
${changedScenesContent}

${existingPersonaSection}
${iterationGuide}`;

  return {
    systemPrompt: PERSONA_SYSTEM_PROMPT,
    userPrompt,
  };
}
