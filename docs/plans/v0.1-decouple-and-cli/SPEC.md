# v0.1 SPEC — Decouple from OpenClaw + Standalone CLI

> Version: 0.1.0-draft · Date: 2026-05-16 · Owner: VKirill
> Branch: `feat/v0.1-decouple-and-cli`
> Master SPEC: `/home/ubuntu/.claude/memory-fork-plan/SPEC.md` (multi-version reference)
> This document: implementation-grade scope for **v0.1 only**. v0.2 + v0.3 are separate SPECs.

---

## 1. Goal

Produce a fork that:

1. Builds and tests cleanly with **zero OpenClaw / Hermes references** in code, scripts, and configs (excluding whitelisted dead-branch in `src/core/tdai-core.ts:425-490` and cosmetic comment/string mentions in `src/core/{conversation/l0-recorder,record/l1-extractor,store/factory}.ts` — preserved as part of "do-not-touch-core" invariant; covered by whitelist). **Tencent VectorDB code (`src/core/store/tcvdb*.ts`, `TcvdbConfig`, `@tencentdb-agent-memory/tcvdb-text` dep) is left dead in v0.1 and deleted in v0.2 per master SPEC §3 phasing** — runtime default `storeBackend: "sqlite"` ensures it never executes.
2. Exposes a working **standalone CLI** with four commands: `init`, `capture`, `recall`, `stats`.
3. Wires **OpenRouter Hy3** (`tencent/hy3-preview`) as the LLM provider via config — no hardcoded provider, no new SDK.
4. Wires **Voyage AI** (`voyage-3-lite`, 512d) as the embedding provider via config — same.
5. Stores all state in `<project>/.claude/memory/` (project-local, gitignorable).
6. Keeps `src/core/*` **untouched** (whitelisted in grep gate; covers dead `hostType === "openclaw"` branch in `tdai-core.ts:425-490` plus cosmetic `openclaw` mentions in `l0-recorder.ts`, `l1-extractor.ts`, `store/factory.ts`).

## 2. Non-Goals (v0.1)

- ❌ Claude Code hook templates, `install.sh`, `settings.json` snippets → **v0.2**
- ❌ Hy3 JSON-reliability smoke test (20 prompts, R1 mitigation) → **v0.2**
- ❌ Migration from `claude-mem v12.7.5` → **v0.3**
- ❌ MCP server variant → **v0.3**
- ❌ npm publish → **v0.3**
- ❌ Cross-project `~/.claude-mem-global/` memory → deferred
- ❌ `seed` CLI command (carries `openclawConfig: unknown` plumbing through `executeSeed`) → returns in v0.3

## 3. Architecture decisions (locked, no re-debate)

| Decision | Value |
|---|---|
| Package name | `@vkirill/tencentdb-agent-memory` |
| Version | `0.1.0` |
| Node engines | `>=22.16` (upstream) |
| Module format | ESM-only |
| Build tool | `tsdown` (upstream) |
| Test framework | `vitest` (to be scaffolded — none exists in upstream) |
| LLM provider | OpenRouter via OpenAI-compatible SDK (`baseUrl: https://openrouter.ai/api/v1`) |
| LLM model (default) | `tencent/hy3-preview` (full slug, see §6 Q6 — code fix in Task 21) |
| Embedding provider | Voyage AI (`baseUrl: https://api.voyageai.com/v1`) |
| Embedding model | `voyage-3-lite`, 512d |
| Vector store | SQLite + `sqlite-vec` (upstream default) |
| State dir | `<cwd>/.claude/memory/` |
| Config file | `.claude/memory/config.json` (env vars read at runtime, never persisted) |
| Logging | Append to `.claude/memory/memory.log`; never to stdout |
| Exit codes | All CLI commands exit `0` even on backend failure (hook-friendly) |
| License | MIT (preserve upstream; add NOTICE.md attribution) |
| Grep gate | `bash scripts/check-no-openclaw.sh` exits 0; whitelist file allows `src/core/tdai-core.ts:425-490` dead branch |

## 4. Verified reality vs original master SPEC

Planner walked the actual fork tree at `/home/ubuntu/projects/TencentDB-Agent-Memory/` and surfaced the following deltas. Resolutions are baked into the checklist (§5):

| Delta | Original SPEC | Reality | Resolution in v0.1 |
|---|---|---|---|
| `src/offload/` (~30 files, ~5000 lines) | not mentioned | exists, OpenClaw-hook code | **DELETE** in WP1.7b |
| `src/gateway/` (3 files, ~400 lines, HTTP server) | not mentioned | exists, Hermes sidecar | **DELETE** in WP1.7c |
| `src/utils/{clean-context-runner,ensure-hook-policy,pipeline-factory}` | "verify-only" | 4 files coupled to OpenClaw | **DELETE** 2 + surgical strip on `pipeline-factory.ts` |
| Existing `bin/` dir | implied present | does not exist | **CREATE** in WP2.9 |
| Root `tsconfig*.json` | implied present | only `scripts/*/tsconfig.json` exist | WP1.11 is a no-op (dirs deleted in 1.6/1.7) |
| Root `src/index.ts` | "modify" | does not exist | **CREATE** in WP2.10 |
| Root `index.ts` | "verify" | 837-line OpenClaw plugin shell | **REPLACE** with tiny re-export shim (WP1.9) |
| Upstream tests | "must keep passing" | no `*.test.ts`, no `vitest.config.ts` | **CREATE** scaffolding (Task 1) |
| `StandaloneLLMRunnerFactory.createRunner` | "config-only for OpenRouter" | strips `tencent/` prefix → breaks OpenRouter | **ONE-LINE FIX** in WP3-minimal Task 21 |
| `tdai-core.ts:425-490` dead branch | "treat core as black-box" | runtime branch on `hostType === "openclaw"` | **WHITELIST** in grep gate; do not modify core |

## 5. TDD-ordered checklist — 22 commits

> One task = one commit. Each commit must pass: `npm test` + grep gate (where applicable). RED→GREEN→COMMIT is strict from Task 11 onward.

### Phase 0 — Test scaffolding & gate (2 commits)

| # | Action | Acceptance |
|---|---|---|
| 1 | ➕ `vitest.config.ts` (ESM, node env, `src/**/*.test.ts` glob), add `"test": "vitest run"` to `package.json` scripts, add one smoke test `src/__smoke__/sanity.test.ts` (`expect(1+1).toBe(2)`) | `npm test` exits 0 |
| 2 | ➕ `scripts/check-no-openclaw.sh` (greps `src/`, allows whitelist file `scripts/openclaw-whitelist.txt` initially containing: `src/core/tdai-core.ts`, `src/core/conversation/l0-recorder.ts`, `src/core/record/l1-extractor.ts`, `src/core/store/factory.ts` — file-level allowance preserves "do not touch core" invariant). Add `"lint:no-openclaw": "bash scripts/check-no-openclaw.sh"` script | Script exists; runs on `main` and currently reports ~24 hits (expected failure — clears in Task 10) |

### Phase 1 — WP1: deletions & rename (8 commits)

| # | Action | Acceptance |
|---|---|---|
| 3 | ❌ Top-level OpenClaw/Hermes artefacts: `hermes-plugin/`, `docker/`, `openclaw.plugin.json`, `scripts/openclaw-after-tool-call-messages.patch.sh`, `scripts/memory-tencentdb-ctl.sh`, `scripts/install_hermes_memory_tencentdb.sh`, `scripts/README.memory-tencentdb-ctl.md`, `scripts/setup-offload.sh`, `scripts/bugfix-20260423/`, `SKILL-MIGRATION.md`, `SKILL-DIAGNOSTIC-EXPORT.md` | `find . -name hermes-plugin` empty; no Hermes refs at top level |
| 4 | ❌ OpenClaw-coupled `src/` dirs: `src/adapters/openclaw/`, `src/offload/` (~30 files), `src/gateway/` (3 files), `src/utils/clean-context-runner.ts`, `src/utils/ensure-hook-policy.ts` | `grep -rn openclaw src/` drops from 24 to ~6 |
| 5 | ✏️ Surgical strip OpenClaw branches from `src/utils/pipeline-factory.ts` only. **Do NOT touch any file under `src/core/`** — cosmetic mentions in `l0-recorder.ts`, `l1-extractor.ts`, `store/factory.ts`, `tdai-core.ts` are all whitelisted (Task 2). | `grep -rn openclaw src/` returns only hits inside whitelisted files |
| 6 | ✏️ Replace root `index.ts` (837 lines OpenClaw plugin shell) with re-export shim: `export * from "./src/adapters/standalone/index.js"; export { TdaiCore } from "./src/core/tdai-core.js";` | `npx tsdown` succeeds; `dist/index.mjs` < 1KB or appropriate |
| 7 | ✏️ `package.json` full rewrite. **Identity:** `name → "@vkirill/tencentdb-agent-memory"`, `version → "0.1.0"`, update `description` (drop OpenClaw), `keywords` (drop `openclaw`, `openclaw-plugin`). **Scripts:** simplify `build → "tsdown"` (drop `build:scripts` chain); DELETE all of `build:scripts`, `build:migrate-sqlite-to-vdb`, `build:export-tencent-vdb`, `build:read-local-memory`, `migrate-sqlite-to-tcvdb`, `export-tencent-vdb`, `read-local-memory`, `postinstall`. **Deps:** remove `peerDependencies.openclaw` + `peerDependenciesMeta.openclaw`; keep `@tencentdb-agent-memory/tcvdb-text` (dead code in v0.1 per Goal 1; deleted in v0.2). **Bin:** DELETE all 3 stale entries (`migrate-sqlite-to-tcvdb`, `export-tencent-vdb`, `read-local-memory`); ADD `"claude-mem": "./bin/claude-mem.mjs"`. **Files[]:** rewrite to `["dist/", "bin/", "index.ts", "src/", "README.md", "CHANGELOG.md", "NOTICE.md", "LICENSE", "templates/", "!src/**/*.test.ts", "!src/**/*.spec.ts", "!src/**/__tests__/"]` (drop all hermes/openclaw/script-dist entries). **OpenClaw block:** remove `openclaw` top-level config block if present. | `npm install` runs clean, no postinstall noise; `npm run build` runs only `tsdown` (no `tsc` for deleted script dirs); `npm pack --dry-run` lists only kept paths |
| 8 | ✏️ `tsdown.config.ts`: drop `openclaw` external rule; keep `entry: ["./index.ts"]` | `npm run build` produces `dist/` cleanly |
| 9 | ➕ `NOTICE.md` (cites upstream 0.3.4 MIT) + ✏️ `README.md` rewrite (~80 lines, points at `docs/` for usage) + ✏️ `CHANGELOG.md` reset (`## 0.1.0 — 2026-05-16`) | `grep -i openclaw README.md` empty; LICENSE preserved verbatim |
| 10 | ➖ **Gate commit**: `bash scripts/check-no-openclaw.sh` exits 0. (Whitelist file already has the `tdai-core.ts:425-490` allowance from Task 2.) | WP1 done; grep gate green |

### Phase 2 — WP2 + minimal WP3 (12 commits, TDD pairs)

| # | Action | Acceptance |
|---|---|---|
| 11 | 🔴 RED: `src/cli/context.test.ts` — 4 cases: `loadContext({projectRoot})` returns `ClaudeCliContext` with concrete types (`config: MemoryTdaiConfig`, `stateDir`, `dataDir`, `logger`); throws on missing `.claude/memory/config.json`; merges env vars (`OPENROUTER_API_KEY`, `VOYAGE_API_KEY`) onto config; logger writes to `<stateDir>/memory.log` and never to stdout | Test file exists; `npm test` fails on missing module |
| 12 | 🟢 GREEN: ➕ `src/cli/context.ts` (`ClaudeCliContext` interface + `loadContext()` impl) + ➕ `templates/config.default.json` (OpenRouter Hy3 + Voyage 512d, env-var placeholders) | `npm test` green for context tests |
| 13 | 🔴 RED: `src/cli/commands/init.test.ts` — 4 cases: fresh init creates `.claude/memory/{state,logs}/` + `config.json` from template + `.gitignore`; idempotent without `--force`; `--force` overwrites; bad cwd → exit 0 + log error | Test red |
| 14 | 🟢 GREEN: ➕ `src/cli/commands/init.ts` + ➕ `bin/claude-mem.mjs` shim (`#!/usr/bin/env node`, imports built dist) + ➕/✏️ `src/cli/index.ts` Commander wiring (full replacement of `registerMemoryTdaiCli` callback) | `node bin/claude-mem.mjs init` works in tmp dir; tests green |
| 15 | 🔴 RED: `src/cli/commands/capture.test.ts` — 3 cases: stdin JSON `{user,assistant}` writes L0 row via mocked `LLMRunner`; missing `OPENROUTER_API_KEY` still writes L0 + exit 0; malformed JSON → exit 0 + logs error | Test red |
| 16 | 🟢 GREEN: ➕ `src/cli/commands/capture.ts` (wires `StandaloneHostAdapter` + `TdaiCore.handleTurnCommitted`) | Tests green; capture works against real SQLite in test |
| 17 | 🔴 RED: `src/cli/commands/recall.test.ts` — 3 cases: pre-seeded L1 row returned by `recall --query`; `--limit N` truncates result count; output bounded to ≤4000 chars total; missing API key → exit 0, empty result | Test red |
| 18 | 🟢 GREEN: ➕ `src/cli/commands/recall.ts` (uses `TdaiCore.handleBeforeRecall` + format helpers; inline what was in upstream's `bin/read-local-memory.mjs` since `bin/` is dropped) | Tests green |
| 19 | 🔴 RED: `src/cli/commands/stats.test.ts` — 2 cases: empty DB → zeroed report exit 0; non-empty DB → counts > 0 for L0 | Test red |
| 20 | 🟢 GREEN: ➕ `src/cli/commands/stats.ts` (reads via `IMemoryStore.getStats()` if exists; else thin read-only helper +~30 lines) | Tests green |
| 21 | ✏️ Fix `StandaloneLLMRunnerFactory.createRunner()` in `src/adapters/standalone/llm-runner.ts:296-303`: keep full `provider/model` slug when matches OpenRouter shape (e.g. `^[a-z0-9-]+/[a-z0-9.-]+$`). Add unit test `llm-runner.test.ts` (3 cases: `tencent/hy3-preview` preserved; `anthropic/claude-sonnet-4.6` preserved; bare `gpt-4` unchanged) | Tests green; OpenRouter integration smoke (if `OPENROUTER_API_KEY` set in env) returns 200 |
| 22 | ➕ `src/index.ts` (library re-exports: `TdaiCore`, `StandaloneHostAdapter`, types). Verify no test broken. | Final commit; `npm run build && npm test` green; `bash scripts/check-no-openclaw.sh` green |

**Total deliverables:** 22 commits · ~600 lines new code · ~6000 lines deletions · 4 working CLI commands.

## 6. Risks (carried from master + new)

| # | Risk | Severity | v0.1 mitigation |
|---|---|---|---|
| R1 | Hy3 JSON instability (full smoke test = v0.2) | High | Pre-approved fallback to `anthropic/claude-sonnet-4.6` for L0→L1; documented in CHANGELOG; commented alt config in template. Not validated in v0.1 (no smoke test until v0.2). |
| R6 | `sqlite-vec 0.1.7-alpha` × Node 24 | Low | Smoke verified by `vitest` startup (Task 1). |
| R-NEW | Replacing 837-line root `index.ts` with shim may break consumers that import from package root | Low | v0.1 has no external consumers (not published, no install scripts yet). Shim re-exports the symbols documented for v0.2. |
| R-NEW | Whitelisting `tdai-core.ts:425-490` is a maintenance burden if upstream changes those lines | Low | Whitelist by file (not line range) in v0.1; line-range comment in CHANGELOG. Re-evaluate on next upstream rebase. |

## 7. Acceptance for v0.1 (final gate before declaring done)

All five must pass before PR / merge / leave:

1. `npm install && npm run build && npm test` — green on Node 22 and Node 24
2. `bash scripts/check-no-openclaw.sh` — exits 0
3. `node bin/claude-mem.mjs init` in a fresh tmp dir creates `.claude/memory/{state,logs,config.json,.gitignore}`
4. `echo '{"user":"hi","assistant":"hello"}' | node bin/claude-mem.mjs capture` writes an L0 row to SQLite (verifiable via sqlite3 CLI)
5. `node bin/claude-mem.mjs stats` prints non-zero L0 count after step 4

Hooks-driven E2E and Hy3 reliability smoke are **NOT** acceptance criteria for v0.1 — they belong to v0.2.

## 8. Known tradeoffs (from `/codex:review` round 1, 2026-05-16)

| # | Finding | Disposition |
|---|---|---|
| C1 | Original Goal 1 promised zero Tencent-VectorDB refs; SPEC didn't actually delete tcvdb code → goal-reachability conflict | **Narrowed Goal 1** to OpenClaw/Hermes only. tcvdb cleanup explicitly deferred to v0.2 per master SPEC. `storeBackend: "sqlite"` runtime default ensures dead code never executes. |
| C2 | `package.json` script chain `build:scripts` calls `tsc` on deleted `scripts/*/tsconfig.json` dirs → `npm run build` would explode | **Expanded Task 7** to delete `build:scripts` chain + all 7 stale `scripts`/`bin` entries. `npm run build` reduces to `tsdown`. Acceptance criterion added: `npm pack --dry-run` clean. |
| C3 | Goal 6 "do not touch core" contradicted Task 5 cosmetic edits to 3 `src/core/*` files | **Resolved on the do-not-touch side:** Task 5 narrowed to `src/utils/pipeline-factory.ts` only; whitelist (Task 2) expanded to allow all 4 affected `src/core/*` files at file level. Inviolate invariant: zero edits to `src/core/`. |

Round-2 codex review pending after these edits land.
