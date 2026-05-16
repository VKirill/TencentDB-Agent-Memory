# v0.3.0 SPEC — Activate LLM Pipeline (Phase A: extract + env loading)

> Version: 0.3.0-draft · Date: 2026-05-16 · Owner: VKirill
> Branch (planned): `feat/v0.3.0-llm-pipeline`
> Predecessor: v0.2.2 (merged to main at `0cde271`)
> Phase split (user-confirmed): **v0.3.0 = Phase A only**. v0.3.1 (PM2 scheduler) and v0.3.2 (vector recall) are independently shippable, deferred to separate sessions.

---

## 1. Goal

User can run `claude-mem extract` in any project that has accumulated L0 turns and get real L1 facts (LLM-extracted structured memory) persisted to that project's SQLite `vectors.db`. Hook wrappers source `~/.claude/claude-mem.env` so API keys reach the `claude-mem` subprocess. Re-runs are idempotent (cursor-based).

```bash
# After install + session activity:
cd ~/some-project
claude-mem extract               # synchronous LLM call, ~3-10s
# extract: project=/home/.../some-project sessions=2 l0_total=14 l1_new=6 l1_skipped=8

sqlite3 .claude/memory/vectors.db 'SELECT COUNT(*) FROM memory_records'
# 6
```

## 2. Non-Goals (v0.3.0)

- ❌ PM2 scheduler (auto-extract every 30 min) → v0.3.1
- ❌ Vector recall via `TdaiCore.handleBeforeRecall` (recall stays keyword-only) → v0.3.2
- ❌ L2 scene blocks / L3 persona generation (L1 only)
- ❌ MCP server variant → indefinite
- ❌ npm publish → after v0.3.2 stabilizes

## 3. Architecture decisions (locked)

### A1. `extract` shape — direct L1 runner, bypass scheduler

`extract` constructs `ClaudeCodeHostAdapter` + `TdaiCore`, calls `core.initialize()` (which wires L1 runner via `pipeline-factory.createL1Runner`), enumerates **unique sessionKeys** from L0 JSONL lines (flat date-bucketed layout per L0 reality verified 2026-05-16), then for each sessionKey calls the wired L1 runner with `{sessionKey}`. Runner reads JSONL via `last_l1_cursor` (recordedAtMs in `<dataDir>/.metadata/checkpoint.json`) and processes only new turns.

**Rejected:** `scheduler.notifyConversation()` + `flushSession()` — needs in-memory buffer pre-population; wrong fit for batch over on-disk JSONL.

### A2. Env loading — `set -a` source pattern in wrappers

All 3 wrappers (`recall`, `stop`, `capture`) prepend:
```bash
if [ -f "$HOME/.claude/claude-mem.env" ]; then
  set -a
  . "$HOME/.claude/claude-mem.env"
  set +a
fi
```

`install.sh` copies `templates/claude-mem.env.example` to `~/.claude/claude-mem.env` (mode 0600) if absent. Never overwrites. Echoes instructions for user to fill in keys.

### A3. R1 fallback — pre-approved Sonnet for L0→L1

Phase A acceptance includes a real-LLM Hy3 smoke (Task A11): 5-10 fixture turns through L1 extractor. If valid-JSON rate <80% → automatically switch `config.extraction.model` to `anthropic/claude-sonnet-4.6` in CHANGELOG + commented alt in `templates/config.default.json`. (Pre-approved at v0.1.)

### A4. `extract` error semantics — explicit failure modes

| Situation | Behavior |
|---|---|
| No `.claude/memory/config.json` (no init done) | exit 1, stderr: "run `claude-mem init` first" |
| `OPENROUTER_API_KEY` not set (env nor config) | exit 1, stderr: "OPENROUTER_API_KEY not set in ~/.claude/claude-mem.env or environment" |
| `cfg.extraction.enabled === false` | exit 1, stderr: "extraction disabled in config.json" |
| No L0 turns yet | exit 0, stdout: "extract: l0_total=0 l1_new=0 (no L0 data)" |
| LLM call fails mid-batch | log to memory.log, continue to next session; final exit 0 if any session succeeded, exit 1 if ALL failed |
| `--dry-run` | exit 0, count un-extracted turns per sessionKey, NO LLM calls |

### A5. Integration tests — mock LLM by default

`tests/integration/extract.integration.test.ts` uses a stub `LLMRunner` returning fixed valid-JSON L1 fixtures. Real LLM call gated on `EXTRACT_E2E_REAL_LLM=1` (skipped in CI without key, matches v0.2 pattern).

## 4. Verified reality (planner walked the codebase)

| Assumption | Verification | Status |
|---|---|---|
| `TdaiCore + ClaudeCodeHostAdapter + ClaudeCodeLLMRunnerFactory` compose cleanly | `tdai-core.ts` `initialize()` wires `createL1Runner` via `wirePipelineRunners()`; `useStandaloneRunner` branch fires for our `hostType="standalone"` | ✅ |
| `createL1Runner` already batch-mode (cursor + chunk) | Reads via `readConversationMessagesGroupedBySessionId(sessionKey, dataDir, last_l1_cursor, logger, 50)`; cursor in `CheckpointManager` | ✅ |
| L0 layout: flat date-bucketed JSONL with sessionKey field-per-line | `l0-recorder.ts:287` writes to `conversations/YYYY-MM-DD.jsonl`; `:359` filters `lineSessionKey !== sessionKey` | ✅ verified inline |
| Idempotency free (cursor = recordedAtMs) | `pipeline-factory.ts` advances cursor via `maxRecordedAtMs` after extraction | ✅ |
| PM2 6.0.14 available | `/usr/bin/pm2` confirmed | ✅ (used in v0.3.1, not Phase A) |

## 5. TDD-ordered checklist — 14 commits

### Phase 0 — Pre-flight (2 commits)

| # | Action | Acceptance |
|---|---|---|
| **A1** | 🔴 `src/cli/commands/extract.test.ts` — 6 cases: (a) no-op on empty `conversations/`; (b) walks unique sessionKeys from flat JSONL; (c) re-run after first extract → `l1_new=0`; (d) `--dry-run` returns counts without LLM calls (mock asserts 0); (e) `--max-turns 5` stops after 5; (f) all-LLM-fail → exit 1, partial-fail → exit 0 with logged warnings | Tests red; missing module |
| **A2** | ➕ `claude-code-integration/templates/claude-mem.env.example` (~15 lines: placeholders + comment block + mode-0600 note) | File present |

### Phase 1 — Extract command implementation (4 commits)

| # | Action | Acceptance |
|---|---|---|
| **A3** | 🟢 `src/cli/commands/extract.ts` (~180 lines): `runExtract({projectRoot, dryRun, maxTurns})`. Steps: loadContextOrAutoInit → preflight checks (config, key, enabled flag) → construct `ClaudeCodeHostAdapter` + `TdaiCore` → `await core.initialize()` → enumerate unique sessionKeys from `<dataDir>/conversations/*.jsonl` → per-sessionKey: get wired L1 runner via `core.getInternalPipelineState()` (or expose a getter), call with `{sessionKey}` → aggregate counts → emit single-line stdout summary | A1 tests green |
| **A4** | ✏️ `src/cli/index.ts` — wire `extract` subcommand: `--dry-run` (boolean), `--max-turns <n>` (number, default 200). Inherits global `--platform`/`--auto-init`. Exit code logic per §3 A4. | E2E manual: `claude-mem extract --dry-run` in tmp dir = exits 0, prints `l0_total=0 l1_new=0` |
| **A5** | ➕ `tests/integration/extract.integration.test.ts` (~120 lines): tmp project, fixture L0 JSONL (3 turns) → run `runExtract` with mocked `LLMRunnerFactory` returning fixed valid L1 JSON → assert `vectors.db` has rows in `memory_records` table → stdout summary matches regex | Tests green |
| **A6** | ✏️ Cursor advancement verification: write small smoke test that runs `runExtract` twice on same fixture, asserts second run reports `l1_new=0` | Idempotency proven |

### Phase 2 — Wrapper env loading (4 commits)

| # | Action | Acceptance |
|---|---|---|
| **A7** | ✏️ `claude-code-integration/templates/recall-wrapper.sh` — insert `set -a` source block after `set -u` line; reference `~/.claude/claude-mem.env` | shellcheck clean |
| **A8** | ✏️ `claude-code-integration/templates/stop-wrapper.sh` — same env source block | shellcheck clean |
| **A9** | ✏️ `claude-code-integration/templates/capture-wrapper.sh` — same env source block (kept in repo per v0.2 CHANGELOG) | shellcheck clean |
| **A10** | ✏️ `claude-code-integration/install.sh` — after wrapper install, if `~/.claude/claude-mem.env` absent: copy from `templates/claude-mem.env.example`, `chmod 0600`, echo instructions. Never overwrites existing. | Re-install on machine with existing env file leaves it untouched |

### Phase 3 — Hy3 smoke + release (4 commits)

| # | Action | Acceptance |
|---|---|---|
| **A11** | 🧪 Manual Hy3 smoke (real LLM): write 5-10 representative L0 turn fixtures (PII-free synthesized dialogue, mix of code+chat), run extract against real Hy3 via OPENROUTER_API_KEY → measure valid-JSON rate. If ≥80%: keep Hy3 in config. If <80%: switch `extraction.model` to `anthropic/claude-sonnet-4.6` in `config.default.json` + document in CHANGELOG. | Smoke rate logged in CHANGELOG; config adjusted if needed |
| **A12** | ✏️ `claude-code-integration/README.md` — document env file path/format, `claude-mem extract` manual usage, smoke test result, expected per-session token cost | README renders correctly |
| **A13** | ✏️ `CHANGELOG.md` — `[0.3.0]` entry: Added (extract command, env file loading), Manual E2E results, Deferred (scheduler → 0.3.1, vector recall → 0.3.2) | CHANGELOG complete |
| **A14** | ✏️ Bump `package.json` 0.2.2→0.3.0, `src/cli/index.ts` version string. `npm run lint && npm run typecheck && npm test && npm run test:integration` → all green | Final acceptance: 5 gates v0.1+v0.2 still pass + new extract gate green |

**Total: 14 commits, ~620 net new + ~95 net modified lines across 5 new + 6 modified files.**

## 6. Acceptance criteria (all must pass before merge to main)

1. `npm test` → 8+1 (extract test) + 1 (extract.integration) suites green
2. `bash scripts/check-no-openclaw.sh` → exits 0 (no regression)
3. `npm run build` → produces `dist/index.mjs` cleanly
4. `claude-mem extract --dry-run` in fresh tmp dir → exits 0, prints `l0_total=0 l1_new=0`
5. E2E with real LLM: tmp project + 3 fixture turns + real OPENROUTER_API_KEY → `extract` writes L1 rows to `vectors.db`, re-run reports `l1_new=0`
6. Wrappers source env file: install on tmp HOME with env file containing `OPENROUTER_API_KEY=test` → wrapper invocation has `OPENROUTER_API_KEY=test` in subprocess (verified via wrapper that just `echo $OPENROUTER_API_KEY > /tmp/out`)
7. Existing v0.1+v0.2 acceptance gates (init/capture/recall/stats + install/uninstall round-trip) all still pass

## 7. Risks + mitigations

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | Hy3 produces <80% valid JSON | Med | A11 measures; R1 fallback pre-approved (Sonnet 4.6 for L0→L1) |
| R2 | `recordedAtMs` cursor mismatch (wrapper-written L0 lacks field) | Med | A6 explicitly tests cursor advances; fix at writer or reader if breaks |
| R3 | TdaiCore needs an exposed getter for the wired L1 runner OR we re-call factory ourselves with same options | Low | A3 picks the cleaner of two approaches at implementation time; fallback = construct L1 runner manually via `createL1Runner(opts)` exported from pipeline-factory |
| R4 | OpenRouter rate limit on Hy3 free tier (3 RPS) — extract over 20+ sessions may throttle | Low | Document; A11 only 5-10 fixtures, well under limit |
| R5 | SQLite WAL conflicts if user runs extract while scheduler (future) is running | Low | Document; WAL retry handles natively; v0.3.1 will add mutex if needed |
| R6 | LLM call fails mid-batch → partial L1 in DB | Med | §3 A4 specifies: per-session failure logged + continue; partial L1 is OK because cursor only advances on success |

## 8. Resolved decisions (user 2026-05-16)

All 5 planner open questions resolved as **A** (default recommendation):
1. ✅ **Phase split**: v0.3.0 = Phase A only this session
2. ✅ **Hy3 smoke**: include in A11 with real LLM
3. ✅ **R1 fallback**: auto-switch to Sonnet 4.6 if <80% valid-JSON
4. ✅ **No-key behavior**: hard error exit 1 with explicit message
5. ✅ **Test mocking**: mock LLM by default, `EXTRACT_E2E_REAL_LLM=1` opts into real calls

Q1 (L0 layout) resolved by orchestrator inline (flat date-bucketed JSONL, verified in `l0-recorder.ts:287/359`).

## 9. Codex review log

> Pending — `/codex:review` runs immediately after this SPEC commit (mandatory gate per Phase 2 orchestrator brief).
