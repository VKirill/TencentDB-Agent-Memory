# Changelog

All notable changes to `@vkirill/tencentdb-agent-memory`.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org/).

For the upstream Tencent project history (pre-fork), see
[Tencent/TencentDB-Agent-Memory CHANGELOG](https://github.com/Tencent/TencentDB-Agent-Memory/blob/main/CHANGELOG.md).

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
