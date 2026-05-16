/**
 * L1 Conflict Detection Prompt (Batch Mode)
 *
 * Based on Kenty's validated prototype prompt (l1_conflict_detection_prompt.md).
 * Batch-compares multiple new memories against a unified candidate pool,
 * supporting cross-type merge and multi-target operations.
 *
 * v0.3.3.1: Localized to English (fork-level). Original Tencent prompt was
 * Chinese; this rewrite preserves all decision rules and the JSON output schema.
 */

import type { MemoryRecord, ExtractedMemory } from "../record/l1-writer.js";

// ============================
// System Prompt
// ============================

export const CONFLICT_DETECTION_SYSTEM_PROMPT = `You are a memory conflict detector. Batch-compare the [New memories] against the [Unified candidate pool] of existing memories, and decide how to handle each new memory.

**All output strings (merged_content) MUST be in English.**

## Core rules

- **Cross-type merge**: memories with different \`type\` (persona / episodic / instruction) MAY be merged if they semantically describe the same fact / event.
- **Many-to-many merge**: a single new memory may replace / merge **multiple** existing memories from the candidate pool (specify via the \`target_ids\` array).
- After a merge, you MUST decide the best \`type\` for the new memory (\`merged_type\`).

## Decision logic

1. **Classify memory nature**:
   - **Stateful** (persona / instruction): preferences, traits, long-term settings, relatively stable facts, behavior rules.
   - **Eventful** (episodic): one-off experiences, objective records with a timestamp. Prefer to merge the cause/process/result of the same event.

2. **Decide if it's the same fact / event**: subject matches, topic aligns, timestamps are close, scene_name is similar.

3. **Choose an action**:
   - **"store"**: treat as new info; insert the current memory.
   - **"skip"**: existing memory is better; new one has no delta or is vaguer; ignore the current memory.
   - **"update"**: same fact / event, new memory is better in content or time (more specific, more recent, or corrects). Overwrite the old with the new, keeping any still-correct details from the old.
   - **"merge"**: same fact or same evolution arc, multiple memories complement each other without contradiction. Combine into one more-complete memory; minimize redundancy.

4. **Bias by category**:
   - Stateful: multiple descriptions of the same preference / trait → prefer **merge**. No delta → **skip**. Clear update → **update**.
   - Eventful: cause / process / result of one event, or different stages → prefer **merge** into a single complete narrative. Identical → **skip**.
   - Cross-type example: an episodic "User started podcasting in 2018" + a persona "User has podcast production experience" → MAY merge into one persona or one episodic (depending on the emphasis).

5. **Timestamp handling**:
   - For **merge** / **update**, \`merged_timestamps\` MUST contain the **union of timestamps from all relevant memories** (deduped, sorted).
   - This preserves the complete event timeline.

## Output format

Output a strict JSON array — one element per new memory decision. Nothing else:

[
  {
    "record_id": "the new memory's record_id",
    "action": "store|update|skip|merge",
    "target_ids": ["candidate record_id 1 to delete", "record_id 2"],
    "merged_content": "merged / updated memory content (required for merge / update)",
    "merged_type": "best type after merge: persona|episodic|instruction (required for merge / update)",
    "merged_priority": 85,
    "merged_timestamps": ["array of timestamps after merge — union of new + all merged-away old (required for merge / update)"]
  }
]

**Field notes**:
- \`target_ids\`: **array** of old memory IDs to delete / replace (one or many). Omit or leave empty for store / skip.
- \`merged_content\`: final memory text for merge / update. Omit for store / skip.
- \`merged_type\`: the type the merged memory belongs to. Decide based on the merged content's essence.
- \`merged_priority\`: new priority after merge / update (0-100 integer, required for merge / update). After merging, the info is more complete and certain — usually **bump priority modestly** (e.g. two priority-70 memories merged can rise to 80). Reference: 80-100 (core trait / important event), 60-79 (general preference / regular activity), <60 (secondary).
- \`merged_timestamps\`: array of timestamps after merge. Collect the new memory's + all merged-away old memories' timestamps, dedup, sort.`;

// ============================
// Prompt Builder
// ============================

/**
 * Candidate search result for a single new memory.
 */
export interface CandidateMatch {
  newMemory: ExtractedMemory & { record_id: string };
  candidates: MemoryRecord[];
}

/**
 * Format the batch conflict detection prompt using a unified candidate pool.
 *
 * Format (aligned with prototype):
 * 1. Unified candidate pool: de-duplicated list of all existing candidates across all new memories
 * 2. Per new memory: content + list of related candidate IDs from the pool
 *
 * This approach lets the LLM see the global picture and handle cross-memory dedup in one pass.
 *
 * @param matches - Array of new memories with their candidate matches
 */
export function formatBatchConflictPrompt(matches: CandidateMatch[]): string {
  // Step 1: Build unified candidate pool (de-duplicate across all new memories)
  const unifiedPool = new Map<string, MemoryRecord>();
  const perMemoryCandidateIds = new Map<string, string[]>();

  for (const m of matches) {
    const candidateIds: string[] = [];
    for (const c of m.candidates) {
      if (!unifiedPool.has(c.id)) {
        unifiedPool.set(c.id, c);
      }
      candidateIds.push(c.id);
    }
    perMemoryCandidateIds.set(m.newMemory.record_id, candidateIds);
  }

  // Step 2: Format unified pool as JSON
  const poolList = Array.from(unifiedPool.values()).map((c) => ({
    record_id: c.id,
    content: c.content,
    type: c.type,
    priority: c.priority,
    scene_name: c.scene_name,
    timestamps: c.timestamps,
  }));

  let poolSection: string;
  if (poolList.length === 0) {
    poolSection = "## Unified candidate pool\n\n(empty — no existing memories; all new memories go directly to store)";
  } else {
    const poolStr = JSON.stringify(poolList, null, 2);
    poolSection = `## Unified candidate pool (${poolList.length} existing memories)\n\n${poolStr}`;
  }

  // Step 3: Format each new memory with its related candidate IDs
  const memoryParts = matches.map((m, idx) => {
    const relatedIds = perMemoryCandidateIds.get(m.newMemory.record_id) ?? [];
    const relatedNote =
      relatedIds.length > 0
        ? JSON.stringify(relatedIds)
        : "[] (no similar candidates — store directly)";

    const memStr = JSON.stringify(
      {
        record_id: m.newMemory.record_id,
        content: m.newMemory.content,
        type: m.newMemory.type,
        priority: m.newMemory.priority,
        scene_name: m.newMemory.scene_name,
      },
      null,
      2,
    );

    return `### New memory #${idx + 1} (record_id: ${m.newMemory.record_id})\n${memStr}\n\n[Related candidate IDs] ${relatedNote}`;
  });

  const newMemoriesText = memoryParts.join(
    "\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n",
  );

  // Step 4: Assemble final prompt
  return `${poolSection}

${"═".repeat(50)}

## New memories to decide on (${matches.length} total)

${newMemoriesText}

Decide per-memory and output the decision JSON array. When a new memory's candidate list is empty, output action=store directly.`;
}
