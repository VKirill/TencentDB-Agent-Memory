# v0.3.3 SPEC — L2 + L3 chained extract

> Version: 0.3.3-draft · Date: 2026-05-16 · Owner: VKirill
> Branch (planned): `feat/v0.3.3-l2-l3-chain`
> Predecessor: v0.3.2 (vector recall)
> **Phase split:** v0.3.3 = L2+L3 chain in extract. v0.3.4 = persona injection + vector L2 enhancement (separate ship per planner recommendation: persona-injection code has no real fixture until v0.3.3 has populated `persona.md`).

## 1. Goal

`claude-mem extract` after L1 drain automatically runs L2 scene extraction per session, then conditionally runs L3 persona generation if `PersonaTrigger.shouldGenerate()` fires. Single CLI invocation populates `scene_blocks/*.md` + `persona.md` end-to-end.

## 2. Non-goals

- Persona injection into SessionStart → v0.3.4
- Vector recall returning L2 scenes alongside L1 hits → v0.3.4
- New CLI subcommands (`claude-mem persona`, `claude-mem scenes`) — `extract` chains all three
- `--layer L1,L2,L3` flag — speculative; defer to v0.4 if asked
- Changing `PersonaTrigger` semantics — use as-is (5 trigger conditions in `persona-trigger.ts:42-92`)
- Hy3 truncation retry (carried)

## 3. Architecture decisions (locked)

| ID | Decision | Rationale |
|---|---|---|
| **ADR-1** | Always-on L1→L2→L3 chain (no `--layer` flag) | Simpler UX; PersonaTrigger already gates L3; L2 gated by "L1 produced records"; speculative configurability rejected per karpathy §2 |
| **ADR-2** | Fail-soft per layer; exit code follows L1 only | L1 is the money operation (durable records). L2/L3 derivative — retry on next scheduler tick. Avoids PM2 retry storms on transient LLM hiccups. Quality regressions surface via summary counters. |
| **ADR-3** | L2 per-sessionKey loop; L3 once per extract | L2 signature is `(sessionKey, cursor?)`. L3 reads checkpoint (not session-scoped). Per-session L3 would waste budget + risk write conflicts on `persona.md`. |
| **ADR-4** | **L2 cursor persisted via CheckpointManager** (codex round 1 P2 fix). | Original ADR said pass `undefined` for v0.3.3 — codex correctly identified this causes full re-scan of L1 history every extract → repeated cost + tool-call timeouts. Fix: persist `latestCursor` returned by L2 runner via `CheckpointManager.markL2ExtractionComplete(sessionKey, cursor)` (or equivalent existing API). Next run reads cursor, passes to `createL2Runner({sessionKey, cursor})`. Incremental L2 — only processes L1 records after last cursor. |
| **ADR-5** | Single shared L2/L3 LLM runner instance per extract | Build `StandaloneLLMRunnerFactory(...).createRunner({enableTools: true})` once, reuse. Saves ~50ms × N sessions. Matches L1 pattern. |

## 4. Reality check

| Assumption | Verification | Status |
|---|---|---|
| `createL2Runner` + `createL3Runner` exist in `pipeline-factory.ts` | Yes — lines 434+, 586+ | ✅ |
| `PersonaTrigger.shouldGenerate()` exists, returns `{should, reason}` | Yes — `persona-trigger.ts` | ✅ |
| L2/L3 use `enableTools: true` (write/read `scene_blocks/`) | Yes per createL2Runner/createL3Runner docstrings | ✅ |
| `cfg.persona.{model, maxScenes, sceneBackupCount, triggerEveryN, backupCount}` exists | **Need to verify** in implementation Task 4 | ⚠️ |
| PM2 scheduler 5-min kill timer may conflict with L2/L3 worst case 8min | **Risk R1 — needs check Task 12** | ⚠️ |

## 5. TDD checklist — 16 commits

| # | Action | Acceptance |
|---|---|---|
| **1** | Create `src/cli/commands/extract-l2l3-wiring.ts` skeleton — export `buildL2L3Runners(opts)` signature + types | Module exists, no impl |
| **2** | 🔴 `src/cli/commands/extract-l2l3-wiring.test.ts` — 4 cases: returns `{l2Runner, l3Runner, llmRunner}`, llmRunner has enableTools=true, vectorStore propagated, model defaulted from `cfg.persona.model` | Tests red |
| **3** | 🟢 Implement `extract-l2l3-wiring.ts`: build `StandaloneLLMRunnerFactory.createRunner({enableTools: true, modelRef: cfg.persona.model})`; wire into `createL2Runner` + `createL3Runner` | Tests #2 green |
| **4** | Verify `src/config.ts` exports `cfg.persona.*` with defaults; add if missing (open Q1) | persona fields available |
| **5** | ✏️ `extract.ts` extend `ExtractSummary` with: `l2_scenes_processed: number`, `failed_l2_sessions: number`, `l3_attempted: boolean`, `l3_failed: boolean`, `l3_persona_bytes?: number` (codex round 1 P2 fix: original `l3_persona_generated: boolean` can't be derived from L3Runner's `() => Promise<void>` contract — instead infer via persona.md mtime/size BEFORE+AFTER L3 call) | Type extended |
| **6** | ✏️ `extract.ts` extend `RunExtractOptions` with `l2RunnerOverride?: L2RunnerFn`, `l3RunnerOverride?: L3RunnerFn` test seams | Type extended |
| **7** | ✏️ `extract.ts` after L1 drain: build L2/L3 runners (skip if both overrides present), iterate sessions calling l2Runner WITH `last_l2_cursor` from CheckpointManager (codex round 1 P2 fix — incremental, not full re-scan); on L2 success persist returned `latestCursor` via checkpoint update; try/catch per session, increment counters | L2 wired with cursor; incremental on re-runs |
| **8** | ✏️ `extract.ts` after L2 loop: read persona.md size+mtime (fs.stat, treat missing as size=0, mtime=0). Build L3 runner, try/catch call. Re-read persona.md size+mtime AFTER. `l3_attempted = true`. `l3_failed = true` if try/catch caught error. `l3_persona_bytes = post.size` if post.mtime > pre.mtime AND post.size > pre.size (file actually changed). | L3 outcome inferred from filesystem (codex P2 fix) |
| **9** | ✏️ `formatExtractSummary` emit new fields on single stdout line | Format extended |
| **10** | ✏️ `extract.test.ts` +8 cases: L2 runs after L1, L2 skipped on empty L1, L2 fail swallowed, L3 fires on trigger=true, L3 skipped on trigger=false, L3 fail swallowed, exit code still 0 on L2/L3 fail, summary fields populated | 8 new tests green |
| **11** | `npm test` — full suite green (60 baseline + ~12 new = ~72) | All green |
| **12** | Check PM2 `scheduler.cjs` kill timer (R1). If 300s (5min), bump to 900s (15min); one-line constant change | DEFAULT_EXTRACT_TIMEOUT_MS = 15 * 60 * 1000 |
| **13** | Real-LLM smoke: project with ≥10 L1 records → `claude-mem extract` → verify `scene_blocks/*.md` ≥1 and `persona.md` body ≥500 chars | Smoke documented in CHANGELOG |
| **14** | Capture L2/L3 wall-clock from logs; compute monthly Hy3 estimate | Cost in CHANGELOG |
| **15** | ✏️ `CHANGELOG.md` v0.3.3 entry + bump `package.json` 0.3.2→0.3.3 + `src/cli/index.ts` version | `claude-mem --version` = 0.3.3 |
| **16** | 🎯 Final gates: `npm test && npm run build && bash scripts/check-no-openclaw.sh` | Ship gate |

**Total: 16 commits, ~480 LOC added, ~5 modified across 3 new + 3 modified files.**

## 6. Acceptance criteria

1. ✅ `claude-mem extract` runs L1 → L2 → (conditional L3) in one process
2. ✅ L2 runs only if L1 produced new records
3. ✅ L3 runs only if `PersonaTrigger.shouldGenerate().should === true`
4. ✅ L2/L3 failure does NOT abort next layer or change exit code
5. ✅ Existing L1-only tests still pass (no L1 regression)
6. ✅ `l2RunnerOverride` + `l3RunnerOverride` test seams work
7. ✅ Summary extended with L2/L3 fields
8. ✅ Real-LLM smoke: ≥1 scene_block file AND persona.md body ≥500 chars
9. ✅ Cost estimate in CHANGELOG
10. ✅ PM2 scheduler timeout bumped if needed (R1 mitigation)

## 7. Risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | L2/L3 worst case 8min vs PM2 scheduler 5-min kill timer | Med | Task 12 — bump scheduler kill to 15min |
| R2 | `cfg.persona` may lack fields → runner build fails | Low | Task 4 verifies + adds defaults |
| R3 | Hy3 may not support tool-call API → silent empty L2/L3 | Med | Smoke (Task 13) catches; fallback to Sonnet documented (R1 pre-approval from v0.1) |

## 8. Open questions (all defaulted)

1. ✅ `cfg.persona` shape verification — Task 4 inline check
2. ✅ Smoke gate strategy — manual quality inspection on selfystudio fixtures (defer formal smoke to v0.4)
3. ✅ Cost ground truth — captured during Task 14 smoke

## 9. Codex review log

### Round 1 (2026-05-16) — 2 P2, both fixed

| # | Finding | Fix |
|---|---|---|
| C1 (P2) | ADR-4 deferred L2 cursor to v0.3.4 → full L1 re-scan every extract → repeated tool-call cost/timeouts | Rewrote ADR-4: persist `latestCursor` via CheckpointManager, pass to next run. Task 7 updated to read+persist cursor. |
| C2 (P2) | `l3_persona_generated: boolean` cannot be derived from L3Runner's `() => Promise<void>` contract — runner returns void for success, trigger=false, no-changes, and write-failure alike | Replaced summary fields with: `l3_attempted`, `l3_failed`, `l3_persona_bytes?`. Task 8 infers outcome from persona.md mtime+size BEFORE/AFTER L3 call. No upstream contract change. |

Per orchestrator policy: max 2 SPEC review rounds.
