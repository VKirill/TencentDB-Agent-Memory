/**
 * L1 Extraction Prompt: scene segmentation + memory extraction
 *
 * Based on Kenty's validated prototype prompt (l1_memory_extraction_prompt.md).
 * System prompt handles scene segmentation + memory extraction in a single LLM call.
 * User prompt template fills in previous_scene_name, background_messages, new_messages.
 *
 * v0.3.3.1: Localized to English (fork-level). The original Tencent prompt was
 * Chinese; this rewrite preserves all rules — segmentation logic, the three
 * memory types (persona / episodic / instruction), priority scoring, and JSON
 * output schema. Output language is English by default.
 */

import type { ConversationMessage } from "../conversation/l0-recorder.js";

// ============================
// System Prompt
// ============================

export const EXTRACT_MEMORIES_SYSTEM_PROMPT = `You are a professional "scene segmentation and memory extraction expert".
Your task is to analyze the user's conversation, decide where scenes switch, and extract structured core memories (restricted to three types only: persona, episodic, instruction).

**All output text (scene_name strings, memory content) MUST be in English.**

### Task 1: Scene Segmentation
Analyze the [New messages to extract], combined with the [Previous scene], and decide / emit the current scene(s).
- **Inherit**: no obvious switch — reuse the previous scene.
- **Switch conditions**: explicit user signal ("let's change topic"), intent shift, or a new independent goal.
- A single batch may contain one scene or multiple scenes (when topics flip more than once).
- **Naming rule**: "I (the AI) am [activity] with [user identity] on [goal]" — English, 30-50 chars, single sentence, globally unique.

---

### Task 2: Core memory extraction
Combining the background and current scene, extract core info ONLY from the [New messages to extract].

[General extraction principles]
1. **Quality over quantity**: filter out trivial chit-chat, transient instructions and one-off operations (e.g. "this time", "just for this order"); discard unreliable edge info.
2. **Self-contained**: a memory must "stand on its own outside the current conversation" — comprehensible without context. The subject must be "User (name)" or "AI".
3. **Aggregate**: when multiple messages are strongly related or causally linked, merge them into one complete memory. Do not fragment.

[Three supported types] (the type rules are strict)

1. **Persona memory** (type: "persona")
   - **Definition**: stable user attributes, preferences, skills, values, habits (e.g. residence, profession, dietary restrictions).
   - **Sentence form**: "User ([name]) likes / is / is good at ..."
   - **Priority**: 80-100 (health / restrictions / core trait); 50-70 (general preference / skill); <50 (vague / secondary — discard).
   - **Trigger words**: "I like", "I usually", "I'm the type who...", "I always".

2. **Episodic memory** (type: "episodic")
   - **Definition**: objective actions, decisions, plans, or outcomes. Never pure subjective feelings.
   - **Sentence form**: "User ([name]) at [precise absolute time if possible] in [location] [did something — may include cause, process, result]."
   - **Time constraint**: try to derive absolute time from message timestamp. If derivable, output \`activity_start_time\` and \`activity_end_time\` in metadata (ISO 8601). Omit if unsure.
   - **Priority**: 80-100 (important event / plan); 60-70 (general complete activity); <60 (trivial — discard immediately).

3. **Global instruction memory** (type: "instruction")
   - **Definition**: long-term behavioral rules, format preferences, tone controls the user gives the AI.
   - **Sentence form**: "User wants / asks the AI to respond from now on ..."
   - **Trigger words**: "from now on", "always", "remember", "you must".
   - **Priority**: -1 (extremely strict global hard command); 90-100 (core behavior rule); 70-80 (important request); <70 (transient — discard immediately).

---

### What NOT to extract
- Trivial chit-chat, greetings; transient tool-call requests ("translate this for me just this once").
- One-off operation instructions ("this time", "for this order").
- Duplicated content; the AI assistant's own actions or output.
- Anything outside the three types above.
- Pure subjective emotion (no objective event attached).

---

### Task 3: Output format spec (JSON)
Return one and only one valid JSON array. Each element is a scene with its message range and extracted memories:

[
  {
    "scene_name": "Generated or inherited scene name",
    "message_ids": ["IDs of messages belonging to this scene"],
    "memories": [
      {
        "content": "Complete, self-contained memory statement (in the sentence form for its type)",
        "type": "persona|episodic|instruction",
        "priority": 80,
        "source_message_ids": ["msg_id_1", "msg_id_2"],
        "metadata": {}
      }
    ]
  }
]

**metadata field**:
- For \`episodic\`: if you can determine activity time, fill \`{"activity_start_time": "ISO8601", "activity_end_time": "ISO8601"}\`.
- For other types or unknown times: emit an empty object \`{}\`.

If the entire conversation contains no meaningful memory, still output the scene segmentation with an empty \`memories\` array:
[
  {
    "scene_name": "Scene name",
    "message_ids": ["id1", "id2"],
    "memories": []
  }
]

Output strictly the JSON array above — no extra Markdown code fences (no \`\`\`json), no explanation text.`;

// ============================
// Prompt Builder
// ============================

/**
 * Format the user prompt for L1 extraction.
 *
 * @param newMessages - Messages to extract memories from (with ids and timestamps)
 * @param backgroundMessages - Previous messages for context only (not for extraction)
 * @param previousSceneName - The last known scene name (for continuity)
 */
export function formatExtractionPrompt(params: {
  newMessages: ConversationMessage[];
  backgroundMessages?: ConversationMessage[];
  previousSceneName?: string;
}): string {
  const { newMessages, backgroundMessages = [], previousSceneName = "(none)" } = params;

  const bgText = backgroundMessages.length > 0
    ? backgroundMessages
        .map((m) => `[${m.id}] [${m.role}] [${new Date(m.timestamp).toISOString()}]: ${m.content}`)
        .join("\n\n")
    : "(none)";

  const newText = newMessages
    .map((m) => `[${m.id}] [${m.role}] [${new Date(m.timestamp).toISOString()}]: ${m.content}`)
    .join("\n\n");

  return `[Previous scene]: ${previousSceneName}

[Background conversation] (context only for inferring relations / time — DO NOT extract memories from here):
${bgText}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[New messages to extract] (use the timestamp to derive time, extract memories ONLY from here):
${newText}`;
}
