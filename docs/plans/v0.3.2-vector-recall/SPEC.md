# v0.3.2 SPEC — Vector Recall (TdaiCore + Voyage embeddings)

> Version: 0.3.2-draft · Date: 2026-05-16 · Owner: VKirill
> Branch (planned): `feat/v0.3.2-vector-recall`
> Predecessor: v0.3.1 (PM2 scheduler + Hy3 smoke)
> **Single cycle, monolithic ship** — fallback decisions tightly coupled to vector path; split would hurt.

## 1. Goal

`claude-mem recall --query "..."` returns **semantic matches from L1 facts** (extracted by `claude-mem extract`) via Voyage embeddings + cosine similarity, while preserving v0.2 keyword grep fallback for all unsupported scenarios.

```bash
# After extract has run on a project with substantive sessions:
claude-mem recall --query "как мы решали проблему с rate-limit"
# Returns L1 facts about rate-limit handling decisions, even if those
# exact words weren't used in the original session.

# Without VOYAGE_API_KEY:
claude-mem recall --query "foo"  
# Silently falls back to keyword grep (v0.2 behavior).
```

## 2. Non-goals

- L0 vector search (L0 embeddings may be missing; keep L0 path keyword-only)
- Hybrid RRF merge inside recall.ts (`performAutoRecall` does it for in-process; CLI keeps simpler)
- L2 scene blocks / L3 persona injection → v0.3.3
- Reranking (Voyage rerank-2) → indefinite
- Cross-process embedding cache (Voyage at 150-250ms within budget; reconsider if p95 >1500ms)
- Hy3 truncation retry (orthogonal; from v0.3.1 deferred)

## 3. Architecture decisions (locked)

| ID | Decision | Rationale |
|---|---|---|
| **ADR-1** | Direct `vectorStore.searchL1Vector(emb, topK)`, NOT `TdaiCore.handleBeforeRecall` | `handleBeforeRecall` returns prepend-context XML envelope for in-process plugins; CLI has its own stdout formatter + MAX_OUTPUT_CHARS budget. Going through TdaiCore would require unwrapping or inherit L2/L3 logic deferred to v0.3.3. Same pipeline-factory pattern as `extract.ts` (proven, clean test seam, avoids openclaw-branch surface). |
| **ADR-2** | Upfront fallback decision tree (switch), not exception unwinding | 4 of 5 fallback conditions are knowable BEFORE embedding: `opts.vector === false`, `!cfg.embedding.apiKey`, `vectorStore.countL1() === 0`, `vectorStore.isDegraded()`. Only embed-failure is exception-driven. Decide upfront → linear happy path → no try/catch noise. |
| **ADR-3** | No cross-process embedding cache | Voyage `voyage-3-lite` 512d ≈ 150-250ms per embed. Below 2s hook budget without cache. Cache adds: serialization, eviction, hashing, test surface. Revisit in v0.3.3 only if p95 >1500ms. |
| **ADR-4** | `topK = max(opts.limit, 5)`, then truncate; threshold from `cfg.recall.scoreThreshold ?? 0.3` | Single source of truth in config, not CLI flags. Default 0.3 matches `performAutoRecall`. Users override via `config.json`. |
| **ADR-5** | Empty vector result → fall through to keyword grep | "Vector miss" often = "query phrasing miss"; L0 may have exact substring user remembers. Matches "I know I said this" mental model. One extra disk scan; cheap. |

## 4. Acceptance criteria

1. ✅ With `VOYAGE_API_KEY` + ≥1 L1 record → vector results formatted as L1 lines on stdout
2. ✅ Without `VOYAGE_API_KEY` (empty `cfg.embedding.apiKey`) → keyword fallback, exit 0, no stdout error
3. ✅ Vector path enabled, `l1_records` empty → silent keyword fallback, log `recall: L1 empty, falling back to keyword`
4. ✅ `--no-vector` flag → forces keyword, bypasses embed init
5. ✅ Embed API failure (HTTP 5xx, timeout) → keyword fallback, exit 0, log `recall: embedding failure, falling back`
6. ✅ p95 wall-clock (cold, 5 L1 records) ≤ 1500ms — measured via manual smoke ×20
7. ✅ Existing v0.2 keyword tests pass unchanged
8. ✅ Unit test: vector path with mocked `IMemoryStore` + `EmbeddingService` returns formatted L1 lines
9. ✅ Unit test: 4 fallback branches each hit keyword path
10. ✅ CHANGELOG `[0.3.2]` + version bumps + smoke result documented

## 5. File plan

| File | New/Modified | Lines | Purpose |
|---|---|---|---|
| `src/cli/commands/recall.ts` | Modified | +180/-10 | Add vector path, fallback decision tree, `--vector` plumbing; keep `composeBounded` + `formatTurn` for keyword |
| `src/cli/commands/recall-vector.ts` | New | ~120 | `runVectorRecall(ctx, query, opts) → Promise<string[]\|null>`. Null signals fall-back. Mirrors extract.ts helper style. |
| `src/cli/commands/recall-format.ts` | New | ~60 | `formatL1Match(result: L1SearchResult): string` — port subset of `formatMemoryLine` from `auto-recall.ts` (no L2/L3 in v0.3.2) |
| `src/cli/commands/recall-vector.test.ts` | New | ~200 | 7 cases: happy path + 4 pre-embed fallback branches + `--vector=false` short-circuit + vector-miss-empty (ADR-5 codex P2 fix) |
| `src/cli/commands/recall.test.ts` | Modified | +30/0 | Regression: keyword unchanged when vector inactive |
| `src/cli/index.ts` | Modified | +4/-1 | Register `--no-vector` flag on recall subcommand; thread into `runRecall({vector})` |
| `CHANGELOG.md` | Modified | +50/0 | `[0.3.2]` entry (Added / Changed / Verified / Migration) |
| `package.json` | Modified | +1/-1 | 0.3.1 → 0.3.2 |
| `src/cli/index.ts` (CLI version string) | already in above modify | — | Match package.json |

**Total:** 4 new + 4 modified files. ~826 LOC new + ~265 diff. ~440 LOC tests (53%).

## 6. TDD checklist — 9 commits

| # | Action | Acceptance |
|---|---|---|
| **1** | ➕ `src/cli/commands/recall-format.ts` — `formatL1Match(result)` minimal port from `auto-recall.formatMemoryLine`, drops L2/L3 cases | Unit test (in same commit): formats `[type] content (score)` correctly |
| **2** | 🔴 `src/cli/commands/recall-vector.test.ts` — 7 cases with mocked IMemoryStore + EmbeddingService: (a) 3 L1 matches → formatted lines; (b) no apiKey → null; (c) countL1==0 → null; (d) isDegraded → null; (e) embed throws → null; (f) `--vector=false` skipped before embed; (g) **vector miss (searchL1Vector returns []) → null** (codex round 1 P2 fix: ADR-5 requires empty result to flow to keyword fallback via runRecall, so runVectorRecall returns null exactly like the other fallback branches) | Test red; module missing |
| **3** | 🟢 `src/cli/commands/recall-vector.ts` — `runVectorRecall(ctx, query, {limit, vector?})` implementing 5-branch decision tree per ADR-2. Returns formatted lines or null | Tests #2 green |
| **4** | ✏️ `src/cli/commands/recall.ts` — extend `RunRecallOptions` with `vector?: boolean` (default true); call `runVectorRecall` first; on null fall through to existing keyword logic. Preserve composeBounded / MAX_OUTPUT_CHARS | Existing tests still green; vector path used when enabled |
| **5** | ✏️ `src/cli/commands/recall.test.ts` — +1 regression test: `runRecall({vector: false})` returns keyword output unchanged from v0.2 | Existing 4 cases + new = 5 green |
| **6** | ✏️ `src/cli/index.ts` — `--vector / --no-vector` Commander flag on recall subcommand (default true); thread into `runRecall({vector})` | `claude-mem recall --no-vector --query x` works |
| **7** | 🧪 Manual smoke ×20: cold-call recall on real project with L1 records via Voyage. Record p50/p95 wall-clock | p95 ≤ 1500ms; document in CHANGELOG |
| **8** | ✏️ `CHANGELOG.md` + version bumps (package.json + src/cli/index.ts version string) → 0.3.2 | `claude-mem --version` = 0.3.2 |
| **9** | 🎯 Final gates: `npm test && npm run build && bash scripts/check-no-openclaw.sh` all green | Ship gate |

## 7. Risks (planner abbreviated)

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | Voyage latency variance — 5-call smoke unreliable for p95 | Med | 20-call smoke before tag (similar to v0.3.1 Hy3 gate) |
| R2 | countL1 slow on huge `l1_records` | Low | SQLite COUNT(*) on indexed table sub-ms <100k rows; note in code |
| R3 | `LocalEmbeddingService.isReady() === false` triggers ~300MB model download | Low | Fallback tree treats `provider==="local" && !isReady` as keyword path |
| R4 | RunRecallOptions gains field | Low | Optional → backward-compatible |

## 8. Open questions — all defaulted

1. ✅ Threshold default `0.3` (matches performAutoRecall; user overrides via config)
2. ✅ Voyage timeout = `cfg.embedding.recallTimeoutMs` (reuse existing field per `auto-recall.ts:359`)
3. ✅ No mixed L0+L1 output (single source per turn; cleaner mental model)
4. ✅ Flag name = `--no-vector` (Commander idiom; `--vector` defaults true)
5. ✅ TdaiCore facade — documented in CHANGELOG `Deferred` as v0.3.3 follow-up

## 9. Codex review log

### Round 1 (2026-05-16) — 1 P2, fixed

| # | Finding | Fix |
|---|---|---|
| C1 (P2) | ADR-5 says empty vector result → keyword fallback, but no test case covered "embed succeeds, searchL1Vector returns []". Risk: implementation could return empty stdout for a query that had exact L0 match | Added 7th test case (g) to checklist task 2; ~200 LOC budget revised |

Per orchestrator policy: max 2 SPEC review rounds.
