# Changelog

All notable changes to `@vkirill/tencentdb-agent-memory`.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org/).

For the upstream Tencent project history (pre-fork), see
[Tencent/TencentDB-Agent-Memory CHANGELOG](https://github.com/Tencent/TencentDB-Agent-Memory/blob/main/CHANGELOG.md).

---

## [0.4.3] — 2026-05-17

Critical bug fix: MCP registration now writes to the correct file (`~/.claude.json`).

### Fixed

- **CRITICAL: MCP server written to wrong file** in v0.4.0-v0.4.2. `install.sh` wrote
  `mcpServers.tencentdb-memory` to `~/.claude/settings.json` (Claude Code's hooks-only
  file) instead of `~/.claude.json` (the canonical MCP registry file at HOME root that
  Claude Code's `/mcp` UI and tool dispatch actually read). Effect: every user who
  installed v0.4.0/v0.4.1/v0.4.2 had a non-functional MCP registration — Claude Code
  couldn't see our server and `mcp__tencentdb-memory__*` tool calls silently failed,
  even though `claude-mem mcp serve` booted correctly via stdio.
- **Atomic write** to `~/.claude.json` via tmp-file + rename (prevents corruption on
  Ctrl-C or disk full during write to this critical file).
- **Registration includes `"type": "stdio"` field** — matches the convention of all
  other working MCP entries (context7, gitnexus, etc.) and makes the registration
  explicit.

### Changed

- MCP registration location: `~/.claude/settings.json` → `~/.claude.json` (HOME root).
  The hooks (SessionStart, UserPromptSubmit, Stop) remain in `~/.claude/settings.json`
  as before — that file is correct for hooks.
- `install.sh` now auto-migrates botched installs: removes `tencentdb-memory` AND legacy
  `claude-mem` stale entries from `~/.claude/settings.json` after writing to the correct
  file. Both cleanup keys are handled (covers v0.4.0, v0.4.1, v0.4.2 upgrade paths).
- `uninstall.sh` now removes MCP entries from BOTH `~/.claude.json` and
  `~/.claude/settings.json` for backward compatibility (covers users uninstalling any
  of v0.4.0-v0.4.3).
- `INSTALL.md` / `README.md` / `README.ru.md` verification snippets updated to
  reference `~/.claude.json` instead of `~/.claude/settings.json`.

### Migration

Re-run `install.sh` — it migrates automatically:

```bash
bash $(npm root -g)/@vkirill/tencentdb-memory-claude-code/claude-code-integration/install.sh
```

The script will:
1. Write `tencentdb-memory` to `~/.claude.json` (preserving all other MCP entries)
2. Remove the stale `tencentdb-memory` entry from `~/.claude/settings.json`
3. Remove the legacy `claude-mem` entry from `~/.claude/settings.json` (if present)

After install, restart Claude Code so it re-reads `~/.claude.json`. Verify:

```bash
python3 -c "import json; print(json.load(open('$HOME/.claude.json'))['mcpServers'].get('tencentdb-memory','NOT REGISTERED'))"
# → {'type': 'stdio', 'command': '/home/you/.npm-global/bin/claude-mem', 'args': ['mcp', 'serve']}
```

### Verified

- 91/91 tests passing (no MCP server code changed).
- `npm run build` + `npm run lint:gate` clean.
- `claude-mem --version` = `0.4.3`.
- Fresh install: `~/.claude.json` receives `tencentdb-memory` entry; `~/.claude/settings.json` stays clean.
- Migration from v0.4.2 (stale entry in `settings.json`): stale entry removed, correct entry added to `~/.claude.json`, sibling MCP entries preserved.
- Idempotency: re-run on already-correct install prints "already registered, skipping" and does not churn the file.

---

## [0.4.2] — 2026-05-17

Namespace-collision fix: rename MCP server identifier `claude-mem` → `tencentdb-memory`.

### Fixed
- **MCP server name collision** with the unrelated `thedotmack/claude-mem` Claude Code plugin
  (5 cached versions found at `~/.claude/plugins/cache/thedotmack/claude-mem/`). When both
  plugins registered MCP under similar prefixes the `/mcp` UI shadowed our server, causing tool
  calls to silently not reach us. Server `name` field in `Server({name: ...})` is now
  `"tencentdb-memory"`. The `mcpServers` registration key in `~/.claude/settings.json` is also
  renamed to `tencentdb-memory`.
- **install.sh migration** (ADR-3): on upgrade from v0.4.0/v0.4.1, the old `claude-mem` MCP key
  is automatically removed before registering the new `tencentdb-memory` key. No orphan
  registrations after re-running `install.sh`.
- **uninstall.sh** (ADR-4): now removes both `tencentdb-memory` (current) AND `claude-mem`
  (legacy) MCP keys — clean regardless of which version installed.

### Migration

**Users who reference our MCP tools in custom agents or slash commands must rename the prefix:**

```
# Before (v0.4.0 / v0.4.1):
mcp__claude-mem__memory_search
mcp__claude-mem__conversation_search
mcp__claude-mem__recall_persona
mcp__claude-mem__recall_scenes

# After (v0.4.2):
mcp__tencentdb-memory__memory_search
mcp__tencentdb-memory__conversation_search
mcp__tencentdb-memory__recall_persona
mcp__tencentdb-memory__recall_scenes
```

Update any `~/.claude/agents/*.md` files or CLAUDE.md tool references accordingly.
The CLI binary `claude-mem` is unchanged — all bash invocations still work as-is.

Re-run `install.sh` to migrate your `~/.claude/settings.json` automatically.

### Verified
- 91/91 tests passing (server.test.ts tests handler functions only — no name assertion).
- `npm run build` + `npm run lint:gate` clean.
- `claude-mem --version` = `0.4.2`.
- MCP `initialize` response: `serverInfo.name = "tencentdb-memory"`.
- Fresh install: `settings.json` contains only `tencentdb-memory` key, no `claude-mem` key.
- Upgrade from v0.4.1 (legacy `claude-mem` key present): key removed, `tencentdb-memory` added,
  no duplicates.

---

## [0.4.1] — 2026-05-16

UX patch: eliminate the manual allowlist-append step from install.

### Changed
- **SessionStart hook** now has TWO commands: first auto-registers the
  current project to `~/.claude/claude-mem-projects.txt` (idempotent via
  `grep -qxF || echo`), second runs `claude-mem recall` as before. Effect:
  PM2 scheduler picks up new projects automatically after first Claude Code
  session in them — no manual `echo "$HOME/project" >> ...` needed.
- **`install.sh`**: extended the `isOurs` jq guard to also match
  `claude-mem-projects.txt` literal so re-running install over an existing
  v0.4.0 entry replaces it cleanly (no duplicate SessionStart entries).
- `package.json` + `src/cli/index.ts`: 0.4.0 → 0.4.1.

### Verified
- 91/91 tests still passing (no `src/` code touched).
- Install dry-run on tmp HOME produces SessionStart entry with 2 hooks
  (auto-register first, recall second).
- Idempotency: triple-call of auto-register hook on same project leaves
  exactly 1 line in allowlist.
- Reinstall over v0.4.0 entry produces 1 matcher with 2 hooks (not 4).

### Migration
- Existing users: re-run `install.sh` after upgrading; the old single-hook
  SessionStart entry is replaced with the new 2-hook version automatically.
- README step 4 ("add projects to allowlist manually") is now optional —
  documented for users who want to pre-register projects before first
  Claude Code session there. Step 4 deletion in README is cosmetic only.

---

## [0.4.0] — 2026-05-16

**Major release**: MCP server + repo rebrand + README/INSTALL rewrite. The
`MEMORY_TOOLS_GUIDE` injected into Claude's context now points to tools that
actually exist, closing the last real Tencent-design gap.

### Added
- **MCP server** (`src/mcp/server.ts`, ~250 LOC) with 4 callable tools via
  stdio transport:
  - `memory_search` — vector / keyword search over L1 facts
  - `conversation_search` — keyword search over raw L0 turns
  - `recall_persona` — return current persona.md content
  - `recall_scenes` — list scene blocks with summaries
- **`claude-mem mcp serve`** CLI subcommand starts the MCP server.
- **`src/mcp/server.test.ts`** — 8 unit tests (happy + empty path per tool).
- **install.sh MCP wiring** — idempotently registers
  `mcpServers.claude-mem` in `~/.claude/settings.json`.
- **README.md** rewritten from scratch — project overview, quick start,
  architecture diagram, MCP tools table, config reference, troubleshooting.
- **INSTALL.md** new — step-by-step guide covering prerequisites, API keys,
  hook wiring, PM2 daemon, smoke verification, upgrade, uninstall.
- New dependency: `@modelcontextprotocol/sdk@^1.29.0`.

### Changed
- **Repo renamed** on GitHub: `VKirill/TencentDB-Agent-Memory` →
  `VKirill/TencentDB-Memory-Claude-Code`. Old URLs auto-redirect.
- **npm package renamed**: `@vkirill/tencentdb-agent-memory` →
  `@vkirill/tencentdb-memory-claude-code`. Bin name stays `claude-mem`
  (no user-facing CLI churn).
- Version bumped 0.3.6 → **0.4.0** (major: new feature surface + package
  rename).
- `claude-mem mcp serve` is a long-running stdio process — Claude Code
  spawns it lazily when it needs to call a memory tool.

### Verified
- Unit suite: **91 passing** (83 from v0.3.6 + 8 new MCP cases).
- Build OK, lint:gate clean, `claude-mem --version` = `0.4.0`.
- MCP smoke: `tools/list` over stdio returns 4 tools with correct schemas.
- Real-LLM smoke from previous releases unchanged (persona.md regenerates
  in coder shape; SessionStart injects `<persona-context>` / `<scene-index>`).

### Migration
- **Existing installs**: `npm i -g github:VKirill/TencentDB-Memory-Claude-Code#v0.4.0`
  (old `npm i -g github:VKirill/TencentDB-Agent-Memory#vX.Y.Z` still works
  via GitHub auto-redirect, but use the new URL going forward).
- Re-run `install.sh` to register the MCP server in your settings.json.
- Restart Claude Code after the install so it picks up the new MCP entry.
- No data migration needed — `.claude/memory/` schema unchanged.

### Known issues
- MCP SDK `Server` class shows TypeScript deprecation warning at SDK
  v1.29.0 — non-blocking, fix tracked for next minor when SDK API stabilizes.

---

## [0.3.6] — 2026-05-16

`PERSONA_SYSTEM_PROMPT` rewritten from Tencent's archetype/lifestyle template
to an actionable **coder profile** — concrete tech stack, infra, workflows,
and hard rules instead of personality observations.

### Changed
- **`src/core/prompts/persona-generation.ts`** — full rewrite of
  `PERSONA_SYSTEM_PROMPT` constant:
  - New role header: `🛠️ Coder Profile Architect — Incremental Evolution Protocol`
  - 8 concrete sections replacing the old 4-layer scan + lifestyle chapters:
    **Stack**, **Infrastructure**, **Workflow conventions**, **Hard rules**,
    **Active projects**, **Communication preferences**, **Decision patterns**,
    **Open / pending**
  - Character cap bumped **2000 → 3000** (tech facts are denser than archetype prose)
  - Hard prohibitions explicitly ban: "Archetype", "Texture of Life",
    "Anthropological", "narrative coherence" wording
  - Empty section handling: omit header entirely (no `## Stack\n(empty)` markers)
  - `buildPersonaPrompt` cosmetic tweaks: mode label updated
    ("First generation (coder profile)" / "Incremental update"), user-prompt
    cap reference 2000 → 3000, iteration guide says "fact" not "insight"
- **`package.json`** + **`src/cli/index.ts`** — version 0.3.5 → 0.3.6

### Verified
- **83 tests** green (no test breakage — existing tests assert on signatures,
  not prompt content).
- **Build** (`tsdown`) clean, no TypeScript errors.
- **lint:gate** (`check-no-openclaw.sh`) passes.
- **Real smoke** on `~/.claude/.claude/memory/` (full wipe + cursor reset +
  Sonnet 4.6 extract): persona.md generated with coder profile shape — "Stack"
  and "Workflow conventions" headers present, size ≤3500B, zero forbidden
  words ("archetype", "texture of life", "anthropological", "narrative coherence").

---

## [0.3.5] — 2026-05-16

`claude-mem recall` now prepends a `<persona-context>` block with the full
persona.md content and appends a `<scene-index>` block listing scene files
sorted by heat (desc). Existing L1/keyword matches are wrapped in
`<recall-matches>`. The SessionStart hook picks up stable identity context
and thematic scenes on every session start without any hook-script change.

### Added
- **`src/cli/commands/recall-context.ts`** (new, ~130 LOC) — three helpers:
  `readPersonaContext` (reads persona.md, caps at 6000 bytes, wraps in
  `<persona-context>`), `readSceneIndexContext` (reads scene_index.json via
  `readSceneIndex()`, sorts by heat desc, drops low-heat entries on 2000-byte
  overflow, wraps in `<scene-index>`), `composeRecallOutput` (assembles all
  three sections in order, omits null/empty sections silently, joins with
  `"\n\n"`). Constants `PERSONA_INJECTION_MAX_BYTES=6000`,
  `SCENE_INDEX_MAX_BYTES=2000` exported for consumer use.
- **`src/cli/commands/recall-context.test.ts`** (new, ~180 LOC) — 9 unit
  tests covering: persona present/absent/truncated, scene index sorted heat
  desc / empty array / absent file, composeRecallOutput ordering and null
  section omission. Uses real fs temp dirs (no import mocking).
- **`src/cli/index.ts`** — `--no-persona` and `--no-scenes` Commander flags
  on the `recall` subcommand, mirroring the existing `--no-vector` pattern.
  Threaded into `runRecall` as `includePersona`/`includeScenes`.

### Changed
- **`src/cli/commands/recall.ts`** — `RunRecallOptions` extended with
  `includePersona?` and `includeScenes?` (both default true). After the
  vector/keyword match path resolves `matchesText`, calls
  `readPersonaContext`+`readSceneIndexContext` and composes final output via
  `composeRecallOutput`. `MAX_OUTPUT_CHARS` reduced from 4000 to 3967 to
  keep the total `<recall-matches>…</recall-matches>` (33 chars tag overhead)
  within the 4000-char hook injection budget that existing tests assert.
- **`src/cli/commands/recall.test.ts`** — +2 regression tests: (1) runRecall
  with persona.md + scene_index.json present → output contains all three XML
  tags in correct order; (2) `includePersona:false + includeScenes:false` →
  no persona/scene tags in output.

### Verified
- **83 tests** green (72 baseline + 9 new recall-context + 2 new regression).
- **Build** (`tsdown`) clean, no TypeScript errors.
- **lint:gate** (`check-no-openclaw.sh`) passes.
- **Real smoke** on `~/.claude/.claude/memory/` (persona.md present,
  2 scene files, L1 vector store populated): output starts with
  `<persona-context>` (4922-byte persona), contains `<scene-index>` listing
  both scene files sorted heat desc (2→1), contains `<recall-matches>` with
  L1 vector results for query "orchestrator" — all three sections present
  and correctly ordered.

---

## [0.3.4] — 2026-05-16

Full English localization of the four LLM prompts (L1 extraction, L1 dedup,
L2 scene extraction, L3 persona generation) and all user-visible auxiliary
strings. The Tencent upstream prompts were entirely in Chinese; this fork
release rewrites them in English while preserving every rule, decision
tree, JSON schema, and template structure unchanged.

### Why
Previous releases (≤0.3.3) produced Chinese output (persona.md filenames
and content in Chinese, scene_blocks/\*.md with Chinese titles) because
the LLM mirrors its prompt language. For English-speaking deployments
this made the generated memory artifacts unreadable to operators and
unusable as context for English-language agents.

### Changed
- **`src/core/prompts/persona-generation.ts`** — full English rewrite.
  PERSONA_SYSTEM_PROMPT now instructs the LLM in English, including
  the 4-layer scan (Base & Facts / Interest Graph / Interface / Core),
  write+edit tool constraints, and the persona.md template.
  The user prompt builder emits English mode labels, statistics, and
  iteration guidance.
- **`src/core/prompts/scene-extraction.ts`** — full English rewrite.
  Scene consolidation architect role, tier warnings (Red/Orange/Yellow),
  UPDATE / MERGE / CREATE workflow, deletion via \`[DELETED]\` marker,
  and the scene-file Markdown template — all in English. Added an
  explicit rule that scene filenames must use English (kebab-case).
- **`src/core/prompts/l1-extraction.ts`** — full English rewrite.
  Scene segmentation + memory extraction rules, persona / episodic /
  instruction type definitions, priority scoring, and JSON output
  schema all in English. Default placeholders ("(none)") in English.
- **`src/core/prompts/l1-dedup.ts`** — full English rewrite.
  Conflict-detection rules, action set (store/skip/update/merge),
  timestamp merge semantics, and JSON output schema in English.
- **`src/core/scene/scene-extractor.ts`** — translated dynamic strings:
  3-tier scene-count warnings, "(no existing scenes yet)" fallback,
  capacity counter header ("Current scene count: N / M"), heat / updated
  labels in scene summary.
- **`src/core/scene/scene-navigation.ts`** — NAV_FOOTER, heat/updated
  labels, and the navigation intro line all in English.
- **`src/core/persona/persona-generator.ts`** — changed-scenes section
  header and analysis directive in English.
- **`src/core/persona/persona-trigger.ts`** — all 4 trigger reason
  strings translated (cold start, recovery, first scene, threshold).
- **`src/core/hooks/auto-recall.ts`** — \`MEMORY_TOOLS_GUIDE\` (injected
  into the agent's system context at session start) fully translated.
  This is the single most user-impactful translation: previously this
  Chinese block was injected into every conversation context.
- **`src/core/record/l1-extractor.ts`** — \`"unknown scene"\` fallback.
- **`src/core/store/tcvdb.ts`** — 3 table description strings translated.

### Kept Chinese (intentional, not localization gaps)
- **`src/utils/sanitize.ts`**: prompt-injection regex patterns target
  Chinese attack phrases ("忽略所有指令" = "ignore all instructions").
  Removing these would degrade security for Chinese-language inputs.
- **`src/core/store/sqlite.ts`**: Chinese stopwords for the jieba
  tokenizer. These are a vocabulary, not a localization. Useful when
  the corpus contains Chinese text.
- **`src/utils/memory-cleaner.ts`**: source-code comments (not
  user-visible).

### Verified
- **Real-LLM smoke** on the same populated project (\`~/.claude/.claude/memory/\`,
  88 L0 turns, 1 session) with full memory wipe + cursor reset to
  re-extract from scratch. Result with English prompts (Sonnet 4.6):
  - 2 scene blocks created (\`server-infrastructure-and-deployment.md\`,
    \`orchestrator-architecture-and-code-quality.md\`) — **English filenames**
  - persona.md: **4922 bytes, 100% English**, archetype line "A disciplined
    systems builder who encodes quality and order directly into his tooling"
  - **0 Chinese characters** in any output file (\`grep [\\x{4e00}-\\x{9fff}]\` = 0)
  - Wall clock: 122s for L1+L2+L3 chain (vs 79s on v0.3.3 — extra time
    reflects denser English token output, not regression)
- Unit suite: **72 / 72** still passing — prompt strings are not unit-tested
  for content (the prompts are LLM inputs, not asserted-on data structures).
- \`npm run build\` ✅, \`npm run lint:gate\` ✅.

### Migration
- **Existing persona.md / scene_blocks/ in Chinese will keep being read
  as-is** — the LLM tolerates mixed-language history. On the next L2/L3
  pass, new updates are added in English. The Chinese sections age out
  naturally as scenes get rewritten or merged.
- **To force a full English regeneration**: delete \`persona.md\` and
  \`scene_blocks/\*\`, wipe \`vectors.db\`, reset \`runner_states.*.last_l1_cursor\`
  to 0 in \`.metadata/recall_checkpoint.json\`, then run \`claude-mem extract\`.
- No code-level API changes. \`buildPersonaPrompt\` / \`buildSceneExtractionPrompt\`
  / \`formatExtractionPrompt\` / \`formatBatchConflictPrompt\` signatures
  unchanged.

---

## [0.3.3] — 2026-05-16

Full L1 → L2 → L3 chain in `claude-mem extract`. Single CLI invocation
extracts L1 facts, derives L2 scene blocks per session, and conditionally
generates the L3 persona — completing the four-layer architecture
(L0 capture in the runtime hook layer; L1 batch extraction added in
v0.3.0; this release closes the L2/L3 gap).

### Added
- **`buildL2L3Runners`** (`src/cli/commands/extract-l2l3-wiring.ts`, ~110 LOC):
  Single shared LLM runner (enableTools=true, required for scene/persona
  file ops) reused across L2 (N sessions) + L3 (1 call) per ADR-5. Model
  resolution: `cfg.persona.model` → `cfg.llm.model`. 4 unit tests with
  mocked `pipeline-factory` + `StandaloneLLMRunnerFactory`.
- **L2 cursor persistence** via `CheckpointManager.getPipelineState` +
  `mergePipelineStates` — incremental L2 extraction per session, no full
  L1 re-scan on each scheduler tick. (Codex round 1 P2 fix: ADR-4 was
  originally going to defer cursor to v0.3.4; codex correctly identified
  the cost spike from repeated re-scans and the SPEC was updated before
  any code was written.)
- **5 new `ExtractSummary` fields**: `l2_scenes_processed`,
  `failed_l2_sessions`, `l3_attempted`, `l3_failed`, `l3_persona_bytes?`.
  L3 outcome inferred via `fs.stat` diff on persona.md before+after the
  L3 call — since `L3Runner` contract is `() => Promise<void>`, strictly-
  increased mtime+size is the only signal that an actual write happened
  (vs. no-op / silent failure). (Codex round 1 P2 fix: original
  `l3_persona_generated: boolean` was not inferable from the upstream
  contract.)
- **2 new `RunExtractOptions` test seams**: `l2RunnerOverride`,
  `l3RunnerOverride` — mirror the v0.3.0 `l1RunnerOverride` pattern.
- **8 new orchestration tests** in `extract.test.ts`: L2 runs/skips/fails,
  L3 runs/skips/fails, exit code stays 0 on L2/L3 failure (ADR-2 fail-soft),
  persona bytes inferred from filesystem when mock L3 runner writes file.

### Changed
- **PM2 scheduler kill timer**: `DEFAULT_EXTRACT_TIMEOUT_MS` 5min → 15min
  in `claude-code-integration/scheduler.cjs`. With L1+L2+L3 chained,
  worst-case extract on busy projects (10+ sessions) can exceed 5min —
  the old cap would SIGTERM mid-L3 and trigger kill→retry storms.
- **`formatExtractSummary`** stdout extended:
  `l2_scenes=N failed_l2=N [l3=wrote-Nb|noop|fail]`.

### Verified
- **Real-LLM smoke** on populated project (`~/.claude/.claude/memory/`,
  84 L0 turns, 1 session). With `extraction.model:
  anthropic/claude-sonnet-4.6` (R1 fallback — Hy3 returned 0 facts from
  this fixture, validating the earlier 80%-valid-JSON gate's tail),
  v0.3.3 chain produced:
  - 3 L1 facts in `vectors.db`
  - 1 file in `scene_blocks/` (2300 bytes, Chinese title — Sonnet's L2
    output language matches the dominant content language)
  - 1 `persona.md` of **3364 bytes** (SPEC gate: ≥500 chars ✅)
  - L2 cursor PERSISTED — `pipeline_states.default.last_extraction_updated_time`
    set to ISO timestamp (codex C1 fix validated end-to-end)
  - Wall clock: **79s** for L1+L2+L3 on 50 turns.
- **Cost**: ~$0.10–0.30 per chained extract on 50 turns using Sonnet 4.6.
  Hy3 native costs roughly 1/10th when fact-extraction succeeds; staying
  on Hy3 by default, R1 fallback via single config edit.
- Unit suite: **72 passing** (64 baseline + 8 new chain cases).
  Scheduler `node --test`: 6/6 still green after timer bump.

### Codex review
- **Round 1 (SPEC review)** — 2 P2 findings, both fixed before any code:
  - C1: ADR-4 had deferred L2 cursor → would cause full re-scan every
    scheduler tick → repeated cost. Fix: persist via CheckpointManager.
  - C2: `l3_persona_generated: boolean` not derivable from `L3Runner`'s
    `() => Promise<void>` contract. Fix: 3-field set inferred from
    `fs.stat` diff.

### Migration
- No breaking API changes. `RunExtractOptions` gained 2 optional override
  fields; existing callers pass unchanged.
- New `ExtractSummary` fields default to `0` / `false` for L1-only paths,
  so any external consumers reading the summary keep working.
- **Cosmetic**: stdout extract summary line is longer now — automation
  parsing it should match by `key=value` pairs, not column positions.

---

## [0.3.2] — 2026-05-16

Semantic vector recall via Voyage embeddings + L1 records.

### Added
- **`runVectorRecall`** (`src/cli/commands/recall-vector.ts`, ~130 LOC):
  5-branch upfront fallback decision tree per ADR-2 — each returns null
  to signal "fall back to keyword". Linear happy path: Voyage embed →
  `vectorStore.searchL1Vector` → filter by `cfg.recall.scoreThreshold ?? 0.3`
  → slice to limit → format. 7 unit tests cover happy path + 6 fallbacks
  (codex round 1 P2 fix added ADR-5 vector-miss case).
- **`formatL1Match`** (`src/cli/commands/recall-format.ts`, ~70 LOC):
  CLI-local L1 formatter `[type|scene] content (score)`. 7 unit tests.
- **`--no-vector` CLI flag** (Commander idiom): defaults vector=true,
  `--no-vector` forces v0.2 keyword path. Useful for debugging + speed-
  critical scenarios.
- **`vector?: boolean`** in `RunRecallOptions` (backward-compatible).

### Changed
- **`recall.ts` integrates vector path as primary**: `tryVectorPath` runs
  FIRST; on null result, flows through to existing v0.2 keyword grep.
  `composeBounded` + `MAX_OUTPUT_CHARS` preserved for both paths.
- **Cost-aware pre-check** in `tryVectorPath`: stat `vectors.db` BEFORE
  `initStores`. If file missing or <50KB (schema-only) → skip initStores.
  Drops cold-call latency on empty L1 from **~2000ms → ~400ms** (4.6×).

### Verified
- **Unit tests**: 60 total, all green (added 7 vector + 7 format + 1
  regression). 11 test files.
- **Manual smoke** on selfystudio (32 L0, L1 empty after extract): 5
  cold-call vector path samples = **343-437ms** (p50 ~379ms, p95 ~437ms)
  — well under 1500ms gate. Keyword baseline 319ms.
- **`runRecall` end-to-end**: vector path engaged → cheap pre-check
  rejected → keyword fallback returned matching turn. Exit 0.

### Codex review
- 1 SPEC review round, 1 P2 (ADR-5 test coverage), resolved.

### Deferred
- v0.3.3: L2 scene blocks + L3 persona generation + persona injection
- 20-call smoke against populated L1 — needs more session-history
  accumulation; current smoke uses empty L1 (proves fallback path)
- Hy3 truncation retry (carried from v0.3.1)

### Migration from v0.3.1
```bash
cd /path/to/TencentDB-Agent-Memory
git pull && npm install --ignore-scripts && npm run build
bash claude-code-integration/install.sh   # idempotent
# Vector recall auto-engages once L1 records exist:
claude-mem extract                          # populate L1
claude-mem recall --query "..."             # semantic search
claude-mem recall --no-vector --query "..." # force keyword
```

---

## [0.3.1] — 2026-05-16

PM2 auto-extract scheduler + 20-prompt Hy3 reliability gate.

### Added
- **PM2 scheduler** (`claude-code-integration/scheduler.cjs`): ticks every
  `CLAUDE_MEM_INTERVAL_MIN` minutes (default 30), reads
  `~/.claude/claude-mem-projects.txt` allowlist with hot-reload, spawns
  `claude-mem extract` serially per project with `cwd: <projectPath>`,
  5-min hard kill timer, per-project lockfile with stale reclaim
  (dead PID or age >10min), graceful SIGTERM drain ≤60s. Node stdlib only.
- **Scheduler unit tests** via `node --test` (6 cases — parseAllowlist,
  acquireLock fresh/held/stale, releaseLock idempotent).
- **Allowlist template** (`claude-code-integration/templates/claude-mem-projects.txt.example`).
- **20-prompt Hy3 reliability smoke** (`scripts/smoke-hy3.mjs`): 20 PII-free
  fixture turns through real OpenRouter Hy3, valid-JSON shape check,
  writes report to `tests/output/hy3-smoke-report.json`, exits 1 if
  rate <80%.
- **`npm run smoke:hy3`** script (CI-safe: skipped without `OPENROUTER_API_KEY`).
- `tests/output/` in `.gitignore`.

### Changed
- **install.sh v0.3.1 block**: copies scheduler.cjs to
  `~/.claude/hooks/claude-mem/scheduler.cjs` (0755), creates empty
  `~/.claude/claude-mem-projects.txt` (0644) from template if absent,
  detects PM2 → prints exact `pm2 start … --name claude-mem-scheduler`
  command OR PM2 install instructions. Opt-in; does NOT auto-start.
- **uninstall.sh**: warns user about running PM2 process; preserves allowlist.
- **index.ts** re-exports `EXTRACT_MEMORIES_SYSTEM_PROMPT` and
  `formatExtractionPrompt` (smoke script imports from `dist/` for single
  source of truth — codex round 1 P1 fix).

### Verified
- **Real Hy3 20-prompt smoke**: 16/20 valid = **80.0%** (exactly on gate).
  4 failures all `JSON.parse: Unexpected end of JSON input` — Hy3 truncated
  mid-output on longer prompts. Latency p50=21.9s, p95=43.3s. R1 fallback
  NOT activated. Total 6.5 min wall-clock, ~$0 (Hy3 free tier).
  **Open observation for v0.3.2:** truncation pattern suggests max_tokens
  bump or retry-on-truncation worth considering.
- **Scheduler E2E** (programmatic `runOnce`): 3 allowlist entries (2 real
  + 1 non-existent + 1 relative-skipped) → 2 OK + 1 WARN-skip. Per-project
  `scheduler.log` written with ISO timestamps. cwd propagation verified.
- **Install fresh tmp HOME**: scheduler.cjs (0755), allowlist (0644) with
  template content, PM2 hint with full absolute path.

### Codex review
- 2 SPEC review rounds, 5 findings (2 P1 + 3 P2), all resolved before
  implementation. See `docs/plans/v0.3.1-scheduler-and-smoke/SPEC.md §9`.

### Deferred
- v0.3.2: vector recall via `TdaiCore.handleBeforeRecall`
- v0.3.3: L2 scene blocks + L3 persona generation
- Hy3 truncation retry mitigation (observed in v0.3.1 smoke)

### Migration from v0.3.0
```bash
cd /path/to/TencentDB-Agent-Memory
git pull && npm install --ignore-scripts && npm run build
bash claude-code-integration/install.sh
# install.sh now creates ~/.claude/claude-mem-projects.txt + scheduler.cjs
echo "$HOME/projects/my-app" >> ~/.claude/claude-mem-projects.txt
pm2 start ~/.claude/hooks/claude-mem/scheduler.cjs --name claude-mem-scheduler
pm2 save
```

---

## [0.3.0] — 2026-05-16

LLM pipeline activation (Phase A). `claude-mem extract` now manually
triggers L1 LLM extraction over accumulated L0 turns. Hooks pass API
keys via `~/.claude/claude-mem.env`.

### Added
- **`claude-mem extract` CLI command** (`src/cli/commands/extract.ts`,
  ~290 lines):
  - Idempotent batch L1 runner — drains each sessionKey until cursor
    catches up (50 iter hard cap)
  - JSONL→SQLite L0 backfill: capture writes JSONL; runner reads SQLite
    `l0_conversations`; extract bridges via `vectorStore.upsertL0`
    (idempotent on `id`)
  - Direct pipeline-factory wiring (`initStores` + `createL1Runner`) —
    bypasses TdaiCore's openclaw-branch surface, cleaner test seam
  - Preflight: missing config / missing OPENROUTER_API_KEY /
    extraction.enabled=false → exit 1 with explicit stderr
  - Flags: `--dry-run` (enumerate without LLM), `--max-sessions N`
    (cap), `--auto-init` (inherits global)
  - Exit code propagates real success/failure (NOT 0-always like
    hooks) — extract is a deliberate command
- **Env file loading in wrappers**: all 3 wrappers (`recall`, `capture`,
  `stop`) prepend `set -a; . "$HOME/.claude/claude-mem.env"; set +a`.
  install.sh creates the file (mode 0600) from
  `templates/claude-mem.env.example` if absent; never overwrites
  existing user-edited keys.
- `tests/integration/` test dir support (`test:integration` npm
  script, vitest glob update)

### Verified
- Real Hy3 smoke (4-turn React Q&A, OPENROUTER_API_KEY from env):
  - Hy3 valid JSON rate: **100%** (1/1 LLM calls, well above 80% gate)
  - Wall-clock: 14.2 s per L1 extraction
  - Drain loop verified end-to-end (cursor advances, drain exits at 0)
  - R1 fallback (Sonnet 4.6) NOT activated — Hy3 reliable on this fixture
  - Note: 4 short turns → 1 scene name, 0 individual L1 facts.
    Behavior is correct — Hy3 doesn't extract memories from thin
    dialogues. Real long sessions will yield more.

### Deferred to v0.3.1
- PM2 scheduler for automatic periodic extract across project allowlist
- Bigger fixture Hy3 smoke (20-prompt validation) — current 1-call
  smoke proves the pipeline, not the steady-state quality

### Deferred to v0.3.2
- Vector recall via `TdaiCore.handleBeforeRecall` (replaces keyword
  grep in `recall.ts`) — depends on accumulated L1 data

### Skipped from SPEC
- A5 (full integration test with mocked LLM through real pipeline-
  factory) and A6 (cursor advancement smoke) — both covered by
  A1 unit tests (cases c/e/h with `l1RunnerOverride` injection) +
  A11 real-LLM E2E. Avoids duplicating coverage.

### Changed
- `package.json version`: 0.2.2 → 0.3.0
- CLI version string: 0.2.2 → 0.3.0
- `ExtractSummary.l1_new` field renamed to `l0_processed` (more
  accurate — counts runner's input messages, not L1 facts written)

### Codex review
- 2 SPEC review rounds, 8 findings (4 P2 + 1 P1 + 3 P2), all
  resolved in SPEC before implementation. See SPEC §9.

### Migration from v0.2.x

```bash
# 1. Pull v0.3.0 and rebuild
cd /path/to/TencentDB-Agent-Memory
git pull
npm install --ignore-scripts && npm run build

# 2. Re-run install.sh to refresh wrappers + create env file
bash claude-code-integration/install.sh

# 3. Edit env file and add real keys
$EDITOR ~/.claude/claude-mem.env
#   OPENROUTER_API_KEY=sk-or-...
#   VOYAGE_API_KEY=pa-...

# 4. Test extract on a project that already has v0.2 capture history
cd ~/some-project
claude-mem extract            # backfills SQLite from existing JSONL, then runs Hy3
sqlite3 .claude/memory/vectors.db 'SELECT COUNT(*) FROM l1_records'
```

---

## [0.2.2] — 2026-05-16

Cosmetic patch — readable summaries in recall output.

### Fixed
- **Nested role-label collision** in stop-wrapper output. v0.2.1
  formatted inner turns as `"user: text"` / `"assistant: text"`. recall.ts
  then wraps the L0 message in its own `"user: …\nassistant: …"` frame,
  producing `"assistant: user: …"` and `"assistant: assistant: …"` in
  injected context — readable but visually confusing.
- v0.2.2 uses `«U»` / `«A»` marker prefixes inside summary content.
  Recall wrap still adds `assistant:` outer label, so output reads as:
  ```
  user: session-end
  assistant: «U» Как починить useEffect?
              «A» useEffect требует массив зависимостей.
              «A» Готово, обновил компонент.
  ```
  Distinct visual layer for outer (recall frame) vs inner (turn structure).

### Unchanged
- All v0.2.1 fixes preserved (JSONL parse, dropped PostToolUse,
  dynamic version read).

---

## [0.2.1] — 2026-05-16

Hotfix: memory quality. v0.2.0 stored unusable garbage in long-term memory.

### Fixed
- **`stop-wrapper.sh` now parses transcript JSONL properly.** v0.2.0
  raw-tailed `transcript_path` (4 KiB), which always landed on Claude
  API metadata (`tool_use` blocks, `usage`, `cache_creation_input_tokens`)
  instead of the actual conversation. v0.2.1 walks the JSONL newest-first,
  extracts ONLY `type:"text"` blocks from user/assistant messages, drops
  `tool_use`/`tool_result`/`thinking`, formats as a readable dialog
  capped at 4 KiB. Sessions captured under v0.2.0 should be wiped — they
  pollute recall context with API noise.
- **PostToolUse hook removed from `settings.json.template`.** Capturing
  raw `tool_input`/`tool_result` envelopes as user/assistant turns
  produced opaque JSON dumps that are noise in memory and useless for
  recall. v0.2.1 ships SessionStart + UserPromptSubmit + Stop only.
  `capture-wrapper.sh` kept in repo for future v0.3 reuse with a
  smarter format. install.sh removes stale `capture-wrapper.sh` on
  upgrade.

### Migration from v0.2.0
```bash
# 1. Pull v0.2.1 (or reinstall from tag)
cd /path/to/TencentDB-Agent-Memory
git pull
npm run build

# 2. Re-run install.sh to refresh settings.json + wrappers
bash claude-code-integration/install.sh

# 3. (optional but recommended) wipe v0.2.0 garbage in each project:
find ~ -name ".claude/memory/conversations" -type d -exec rm -rf {} + 2>/dev/null
# OR per-project: rm -rf <project>/.claude/memory/conversations
```

### Unchanged
- All other v0.2.0 hooks, wrappers, marker shape, --auto-init, --platform,
  install/uninstall idempotency.

---

## [0.2.0] — 2026-05-16

Claude Code integration: global install, per-project memory, auto-init on first use.

### Added
- `ClaudeCodeHostAdapter` + `ClaudeCodeLLMRunnerFactory` in `src/adapters/claude-code/`
- Global `--auto-init` and `--platform <name>` CLI flags
- `loadContextOrAutoInit()` helper — silent bootstrap of `.claude/memory/` on first use
- `claude-code-integration/install.sh` — global, idempotent installer for
  `~/.claude/settings.json` hooks + 3 wrappers to `~/.claude/hooks/claude-mem/`
- `claude-code-integration/uninstall.sh` — clean removal (preserves per-project data)
- 3 hook wrappers translating Claude Code envelope shapes → claude-mem stdin:
  `recall-wrapper.sh`, `capture-wrapper.sh` (backgrounded), `stop-wrapper.sh`
- `settings.json.template`, `.env.example`, integration README (~140 lines)
- `package.json files[]` now includes `claude-code-integration/`
- `runInit` accepts `silent?: boolean`

### Deferred to v0.3
- Hy3 JSON-reliability smoke test (WP3.6) — v0.2 CLI never calls LLM at runtime
- Vector recall via `TdaiCore.handleBeforeRecall` (ClaudeCodeHostAdapter
  plumbed but not exercised in v0.2 — v0.2 recall is keyword-only)
- install.sh vitest integration tests (manual E2E verified instead)
- Migration from claude-mem v12.7.5
- MCP server variant
- npm publish

### Manual E2E (verified 2026-05-16)
- `npm link` → `claude-mem --version` = 0.2.0
- `bash install.sh` in tmp HOME → 4 hooks in settings.json + 3 wrappers, marker set
- Simulated Claude Code hook payloads → wrappers → L0 turns written;
  recall finds matching content; stats reports counts
- `uninstall.sh` round-trip cleanly removes everything install added

### Codex review
- `/codex:review` on v0.2 SPEC: 2 rounds, 5 findings (3 P1, 2 P2),
  all resolved in SPEC before implementation. See SPEC §10.

---

## [0.1.0] — 2026-05-16

Initial fork from upstream `v0.3.4`.

### Added
- Standalone CLI (`bin/claude-mem.mjs`) with four subcommands:
  `init`, `capture`, `recall`, `stats`
- `commander` ^14.0.1 dependency for CLI wiring
- `vitest` smoke test scaffolding (`src/__smoke__/sanity.test.ts`)
- Grep gate `scripts/check-no-openclaw.sh` with whitelist
- Project-local state at `<cwd>/.claude/memory/` (config + DB + logs)
- OpenRouter (`tencent/hy3-preview`) as default LLM provider
- Voyage AI (`voyage-3-lite`, 512-d) as default embedding provider
- `NOTICE.md` with upstream attribution
- `docs/plans/v0.1-decouple-and-cli/SPEC.md` implementation SPEC
- Root re-export shim `index.ts` for library consumers
- `src/utils/clean-context-runner.ts` stub (preserves import surface
  for `src/core/*` legacy fallback branches; throws on instantiation —
  never reached in standalone mode)

### Changed
- Package renamed: `@tencentdb-agent-memory/memory-tencentdb` → `@vkirill/tencentdb-agent-memory`
- Build pipeline simplified: `npm run build` now runs only `tsdown`
- Description, author, keywords retargeted at Claude Code use case

### Removed
- OpenClaw plugin runtime coupling (`src/adapters/openclaw/`,
  `src/offload/`, `src/gateway/`, `index.ts` 837-line OpenClaw shell)
- Hermes Python sidecar (`hermes-plugin/`, `docker/`)
- OpenClaw plugin manifest (`openclaw.plugin.json`,
  `package.json.openclaw` block, `peerDependencies.openclaw`)
- `postinstall` script that patched OpenClaw runtime
- Auxiliary CLI bins: `migrate-sqlite-to-tcvdb`, `export-tencent-vdb`,
  `read-local-memory` (logic for the last folded into `recall`)
- `seed` CLI subcommand (returns in v0.3 with claude-mem migration)
- CI manifest validation job (`.github/workflows/pr-ci.yml` `manifest:`)
- `SKILL-MIGRATION.md`, `SKILL-DIAGNOSTIC-EXPORT.md` (upstream-specific)

### Deprecated (slated for v0.2)
- Tencent VectorDB store backend (`src/core/store/tcvdb*.ts`,
  `@tencentdb-agent-memory/tcvdb-text` dep) — code remains but
  unreachable when `storeBackend: "sqlite"` (the v0.1 default)

### Fixed
- `StandaloneLLMRunnerFactory.createRunner()` was stripping the
  `provider/` prefix from model slugs (e.g. `tencent/hy3-preview` →
  `hy3-preview`), breaking OpenRouter calls. Preserves full slug when
  pattern matches OpenRouter shape. (Task 21 / v0.1.)

### Known issues
- Hy3 JSON-reliability smoke test (R1 mitigation) deferred to v0.2.
  Pre-approved fallback: switch L0→L1 to `anthropic/claude-sonnet-4.6`
  if valid-JSON rate < 95% on 20-prompt sample. Documented in
  `templates/config.default.json` as commented alternative.
- `src/core/*` retains 13 files with cosmetic `openclaw` mentions
  (comments + type-union literals) — whitelisted in
  `scripts/openclaw-whitelist.txt`. To be cleaned in v0.2 upstream
  rebase cycle.
- `src/utils/pipeline-factory.ts` retains `openclawConfig: unknown`
  parameter for contract compatibility with `src/core/seed/seed-runtime.ts`
  and `src/core/tdai-core.ts` (whitelisted). Standalone-mode runtime
  always passes `undefined` and uses `llmRunner` instead.

### Acceptance gates — ALL ✅ 2026-05-16
- [x] `npm install && npm run build && npm test` — 28 tests across 7 files, green
- [x] `bash scripts/check-no-openclaw.sh` — exits 0 (253→0 non-whitelisted refs)
- [x] `node bin/claude-mem.mjs init` in tmp dir → creates `.claude/memory/{config.json,.gitignore}`
- [x] `echo '{"user":"hi","assistant":"hello"}' | claude-mem capture` → L0 JSONL (2 messages)
- [x] `claude-mem stats` → `L0 turns: 1, L0 messages: 2, last capture: <ISO ts>`
- [x] `claude-mem recall --query <substring>` → returns matching turn (verified Task 18 e2e)

v0.1 SHIPPED. Branch `feat/v0.1-decouple-and-cli` ready for PR / merge / leave.
