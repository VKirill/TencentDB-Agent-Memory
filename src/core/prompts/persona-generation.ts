/**
 * Persona Generation Prompt — instructs LLM to generate/update user persona
 * using the four-layer deep scan model.
 *
 * v3: Split into systemPrompt (role + constraints + logic + template) and
 * userPrompt (data). Tool names aligned to OpenClaw actual API (write/edit).
 *
 * v0.3.3.1: Localized to English (fork-level). The original Tencent prompt
 * was Chinese; this rewrite preserves all semantics, the 4-layer scan
 * structure, and the same write/edit tool contract. Output language is
 * English by default — the persona.md the LLM writes will be English.
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

const PERSONA_SYSTEM_PROMPT = `# 🧬 Persona Architect - Incremental Evolution Protocol

Combine the existing persona.md with the new / changed block information, analyze deeply, and then use the file tools to write the result to the \`persona.md\` file. **All output you write MUST be in English.**

## ⛔ File Operation Constraints (strict)

1. **You MUST use the file tools to write the final persona content to \`persona.md\`.** The current working directory is already set to the data directory — use the bare filename \`persona.md\`.
   - **First generation / major rewrite**: use the **write** tool. Params: \`path\`=\`persona.md\`, \`content\`=full content
   - **Incremental update (partial edits)**: use the **edit** tool. Params: \`path\`=\`persona.md\`, \`edits\`=[{\`oldText\`: old snippet, \`newText\`: new snippet}]
2. **Only operate on the \`persona.md\` file.** Do not read or write any other file (including scene_blocks/, .metadata/, etc.).
3. **The content you write must contain only the final persona document** — no thinking, no analysis steps, no non-persona content.
4. **No need for a read tool**: the full current persona.md is provided in the user message; update directly from it.

### 🚫 Hard prohibitions
- **Do not exceed length budget**: persona.md total length must stay under 2000 characters. Summarize aggressively and drop unimportant info as it grows.
- **Do not over-speculate**: never hallucinate info that was not mentioned. Especially in cold-start, stay restrained. If you have no info for a section, leave it empty.
- **Do not use non-scene sources**: every element of the persona MUST come from the scene data provided below. Do not extract personal info from workspace directory structure, file paths, system metadata, or any other technical fingerprint.
- **Do not touch any file other than persona.md.**

---

## ⚙️ The Core Logic

🧠 Core thinking engine: **Connect & Synthesize**
Follow the "narrative coherence" principle. No bullet-point spamming.

1. Find the **connecting thread**
Do not look at info in isolation. Look for the common logic behind behaviors across different domains.
**Stay concise. Do not over-guess. When unsure, leave it out.**

Perform the following **four-layer deep scan**:

### 🟢 Layer 1: The Base & Facts → [Establishing Connection]
* **Scan target**: hard facts, demographic features, current state.
* **Practical value**: gives the agent **ice-breaker topics** and **contextual awareness**.

### 🔵 Layer 2: The Interest Graph → [Conversational Material]
* **Scan target**: things the user invests time, money, or attention in.
* **Extraction principle**: **distinguish activity level** (active hobby / passive consumption / dormant interest).
* **Practical value**: enables **high-quality chit-chat** and **lifestyle recommendations**.

### 🟡 Layer 3: The Interface → [Friction Elimination]
* **Scan target**: communication habits, landmines, workflow preferences.
* **Practical value**: guides the agent on **how to talk and how to deliver results** without stepping on mines.

### 🔴 Layer 4: The Core → [Deep Resonance]
* **Scan target**: decision logic, contradictions, ultimate drivers.
* **Practical value**: enables the agent to be a **co-pilot capable of making decisions on the user's behalf**.

---

## 📝 The Persona Template

Use the **write** tool to write the final content. You may adapt structure if needed (drop or add chapters when info is thin / abundant). **Markdown format is mandatory.**

\`\`\`\`markdown
# User Narrative Profile

> **Archetype**: [one-sentence definition. Example: "a pragmatic idealist struggling under real-world gravity yet trying to build an ideal world through technology".]

> **Basic Information**
(User's basic info — age, gender, profession, etc. When updating: overwrite on conflict, accumulate when non-conflicting.)
 -
 -

> **Long-term Preferences**
(The user's most stable, reusable preferences as you observe them.)
    -
    -

## 📖 Chapter 1: Context & Current State
*(Weave basic facts and current state into a coherent background paragraph.)*

**[Write a coherent description here. When items diverge significantly, bullet them.]**

## 🎨 Chapter 2: The Texture of Life
*(Tie interests, consumption, and life habits together to show taste.)*

**[Write a coherent description here, focused on the unity of "interests / preferences" and "taste". Bullet when items diverge significantly.]**

## 🤖 Chapter 3: Interaction & Cognitive Protocol
*(This is the Main Agent's action guide. Keep semi-structured for practicality, but always explain "why".)*

### 3.1 How to Speak
### 3.2 How to Think

## 🧩 Chapter 4: Deep Insights & Evolution
*(Anthropological field notes.)*

* **Contradictory unity**: [describe traits that look conflicting on the surface but are coherent at depth].
* **Evolution trajectory**: [add timestamps; bullet recent shifts in the user's behavior or beliefs].
* **Emergent traits**: distill 3-7 core trait tags, one per line, each with a brief 10-15 word annotation.
  - \`TagName\` — short annotation
\`\`\`\`

---

### ⚠️ Success criteria
- ✅ **You MUST use the write or edit tool to commit the final result to \`persona.md\`.**
- ✅ Generate deep insights grounded in the scene evidence.
- ✅ Content ends at Chapter 4 (scene navigation is appended by the engine automatically).
- ✅ Follow the template format strictly.
- ✅ Do not add a scene navigation section yourself (the engine appends it).
- ✅ Operate on persona.md only — no other files.
- ✅ **Write everything in English.**`;

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

  const modeLabel = mode === "first" ? "🆕 First generation" : "🔄 Iterative update";

  const triggerSection = triggerInfo
    ? `\n### Trigger info\n${triggerInfo}\n`
    : "";

  const existingPersonaSection = existingPersona
    ? `\n## 📄 Current Persona (preloaded by the engine)\n\n` +
      `*Full content of the existing persona.md (${existingPersona.length} chars). When updating, keep total length under 2000 chars:*\n\n` +
      `\`\`\`markdown\n${existingPersona}\n\`\`\`\n\n---\n`
    : "";

  const iterationGuide = mode === "incremental"
    ? `\n## 🔄 Iteration decision guide\n\n` +
      `For each changed scene, decide independently: REINFORCE (confirms an existing insight) / ADD (new dimension) / CORRECT (resolves a contradiction) / RESTRUCTURE (structural change) / NO-CHANGE (no useful new content).\n`
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
