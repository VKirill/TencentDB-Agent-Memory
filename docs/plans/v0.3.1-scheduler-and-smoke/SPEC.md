# v0.3.1 SPEC — PM2 Scheduler + 20-prompt Hy3 Smoke

> Version: 0.3.1-draft · Date: 2026-05-16 · Owner: VKirill
> Branch (planned): `feat/v0.3.1-scheduler-and-smoke`
> Predecessor: v0.3.0 (extract + env loading)
> **Phase recommendation:** single ship — Phase A (scheduler) + Phase B (smoke) zero code overlap, share release cadence.

## 1. Goal

```bash
echo "$HOME/projects/some-project" >> ~/.claude/claude-mem-projects.txt
pm2 start ~/.claude/hooks/claude-mem/scheduler.cjs --name claude-mem-scheduler
pm2 save
# … 30 min later …
sqlite3 ~/projects/some-project/.claude/memory/vectors.db 'SELECT COUNT(*) FROM l1_records'
# > 0 — L1 facts auto-extracted, no manual invocation
```

```bash
OPENROUTER_API_KEY=sk-or-... npm run smoke:hy3
# 20 prompts, 18 valid JSON, rate=90% → exit 0
```

## 2. Non-goals (v0.3.1)

- Vector recall → v0.3.2
- Auto-discovery of project dirs by walking `$HOME` → rejected (D2)
- systemd/cron alternatives → rejected (D1, PM2 already required)
- Parallel extract across projects → rejected (rate-limit storms)
- Hot-reload of interval var → out of scope (PM2 restart to change)

## 3. Architecture decisions (locked)

| ID | Decision | Rationale |
|---|---|---|
| **D1** | PM2-supervised daemon (NOT systemd/cron) | User CLAUDE.md mandates PM2; auto-restart + log rotation + user-scope free |
| **D2** | Explicit allowlist file `~/.claude/claude-mem-projects.txt`, hot-reload per tick | Avoids walking NFS/sshfs/git-submodule trees; user-controlled scope |
| **D3** | Serial per-project execution with per-project lockfile `<project>/.claude/memory/.extract.lock` | Avoids rate-limit storms; stale-lock reclaim (pid dead + age>10min) |
| **D4** | Per-project extract timeout 5 min (env-configurable `CLAUDE_MEM_EXTRACT_TIMEOUT_MS`) | Prevents one stuck LLM call from blocking the whole tick |
| **D5** | Graceful SIGTERM — drain current project, exit ≤60s | PM2 expects clean shutdown |
| **D6** | Smoke standalone (NOT `npm test`); skip-on-no-key in CI | 5-min wall-clock + real $ cost — wrong fit for vitest |

## 4. Reality check (planner verified)

| Assumption | Status |
|---|---|
| PM2 globally on user box | ✅ `/usr/bin/pm2 6.0.14` |
| `extract` already loads `~/.claude/claude-mem.env` itself | ✅ `extract.ts:92-112` — scheduler doesn't need to re-source |
| Hy3 prompts reusable from `src/core/prompts/l1-extraction.ts` | ✅ `formatExtractionPrompt` + `EXTRACT_MEMORIES_SYSTEM_PROMPT` exported |
| Synthesized fixtures (PII-safe) — confirmed in v0.2 SPEC Q2 | ✅ inherits decision |
| No new npm deps needed | ✅ stdlib only for scheduler; smoke imports from `dist/` |

## 5. TDD checklist — 15 commits

### Phase A — Scheduler (8 commits)

| # | Action | Acceptance |
|---|---|---|
| **A1** | 🔴 `claude-code-integration/scheduler.test.cjs` — 5 `node --test` cases: parseAllowlist strips `#`+blank+non-abs; acquireLock fresh→true; acquireLock held-fresh→false; acquireLock stale (pid dead + age>10min)→reclaim+true; releaseLock idempotent | Tests red; module missing |
| **A2** | 🟢 `claude-code-integration/scheduler.cjs` (~150 LOC): exports `{parseAllowlist, acquireLock, releaseLock, runOnce, main}`. `runOnce(allowlistPath)` reads allowlist → for each path: acquire lock → **spawn `claude-mem extract` with `cwd: <projectPath>`** (codex P2 fix — extract.ts uses `process.cwd()` for projectRoot; without cwd override, scheduler runs all extracts against its own cwd) + 5min kill timer → release lock → log result line. `main()` sets `setInterval` ticker (default 30min, env override) + SIGTERM handlers; runs first tick immediately on boot. | A1 green; per-project cwd verified in A3 |
| **A3** | 🧪 Manual E2E: 2 fixture projects, allowlist, `CLAUDE_MEM_INTERVAL_MIN=1 node scheduler.cjs &` for 2 min, kill, assert per-project `scheduler.log` shows extract attempts | Per-project log regex match |
| **A4** | ✏️ `install.sh` — new v0.3.1 block: (a) copy scheduler.cjs to `$HOOKS_DIR/scheduler.cjs` +x; (b) `touch ~/.claude/claude-mem-projects.txt` 0644 if absent; (c) `command -v pm2` detection → print exact `pm2 start …` command OR PM2 install instructions (no cron fallback — D1 rejects it; codex P2 fix). | Re-install on machine with existing scheduler+allowlist leaves both untouched |
| **A5** | ✏️ `uninstall.sh` — remove scheduler.cjs; warn user to `pm2 delete claude-mem-scheduler && pm2 save` manually; DO NOT delete allowlist (user data) | Round-trip clean |
| **A6** | ✏️ `claude-code-integration/README.md` — "Auto-extract scheduler" section: allowlist format, PM2 commands, interval env, lock semantics, log location | Renders correctly |
| **A7** | ➕ `claude-code-integration/templates/claude-mem-projects.txt.example` (~15 lines: header + 2 commented examples) | Template present |
| **A8** | ✏️ `package.json files[]` — explicit `"claude-code-integration/scheduler.cjs"` | `npm pack --dry-run` includes scheduler.cjs |

### Phase B — Hy3 smoke (7 commits)

| # | Action | Acceptance |
|---|---|---|
| **B1** | ➕ `tests/fixtures/hy3-smoke/turns.json` (~140 lines): 20 PII-free synthesized `{user, assistant}` turns. Mix: code debug, library docs, infra config, personal prefs (locale/stack), task updates. Each ≥200 chars. RU+EN mix per user's stack. | Valid JSON; 20 entries |
| **B2** | ➕ `scripts/smoke-hy3.mjs` (~170 LOC): (1) preflight — no key → warn+exit 0; (2) load fixtures; (3) per-turn: build L1 prompt via `formatExtractionPrompt` (codex P1 fix: requires `index.ts` re-export — see B2a below); (4) sequential walk, 500ms spacing; (5) `JSON.parse` + shape check — **top-level array `[{scene_name, message_ids, memories}]`** (codex P1 fix: Tencent prompt returns array, not `{scenes: [...]}` object — verified in `src/core/record/l1-extractor.ts:parseExtractionResult`); (6) write `tests/output/hy3-smoke-report.json` (per-prompt + aggregate); (7) exit 1 if rate <0.8 with R1 activation snippet | Manual run with real key produces report + correct exit; shape check accepts valid Hy3 responses |
| **B2a** | ✏️ `index.ts` — add re-exports for `formatExtractionPrompt` and `EXTRACT_MEMORIES_SYSTEM_PROMPT` from `./src/core/prompts/l1-extraction.js`. **Without this, smoke script import from `dist/` fails** (codex P1 root cause: tsdown only builds `index.ts`, public re-exports don't include prompts). Tiny diff, zero behavior change for existing consumers. | `dist/index.mjs` exports both symbols |
| **B3** | ✏️ `package.json scripts` — add `"smoke:hy3": "node scripts/smoke-hy3.mjs"` | `npm run smoke:hy3` finds script |
| **B4** | ✏️ `.gitignore` — add `tests/output/` (report is per-run, not source-controlled) | `git status` clean after smoke run |
| **B5** | 🧪 Run `OPENROUTER_API_KEY=… npm run smoke:hy3` against real Hy3. Record rate in CHANGELOG. If <80% → switch `templates/config.default.json` extraction.model to `anthropic/claude-sonnet-4.6` + re-run smoke | Rate ≥80% OR R1 fallback activated |
| **B6** | ✏️ `CHANGELOG.md` `[0.3.1]` entry + bump `package.json` 0.3.0→0.3.1 + `src/cli/index.ts` version. Final gates: `npm test && npm run build && bash scripts/check-no-openclaw.sh` all green | Ship gate |

**Total: 15 commits (8 Phase A + 7 Phase B incl B2a re-export), ~565 LOC new + ~125 LOC modified across 5 new + 8 modified files.**

## 6. Acceptance criteria (final ship gate)

1. `npm test` → green (45+ tests baseline preserved)
2. `npm run build` → dist clean
3. `bash scripts/check-no-openclaw.sh` → exits 0
4. Scheduler E2E (A3): 2 fixture projects + 1-min interval + 2-min run → both project logs show extract attempts
5. Hy3 smoke E2E (B5): real key + 20-prompt run → rate logged in CHANGELOG; R1 fallback in config if <80%
6. Install round-trip: existing scheduler+allowlist untouched on re-install
7. Uninstall preserves allowlist (user data); removes scheduler.cjs

## 7. Risks + mitigations (planner table abbreviated)

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | Scheduler daemon crashes silently | LOW | PM2 auto-restart + uncaughtException handler |
| R2 | Allowlist with stale paths | LOW | runOnce skips non-existent with WARN |
| R3 | Extract subprocess hangs LLM stall | MED | D4 5-min kill timer per project |
| R4 | OpenRouter rate limit on aggressive cadence | LOW | Serial execution + 500ms smoke spacing |
| R5 | Smoke report leaks API key in git | MED | `.gitignore tests/output/` + report contains no key |
| R6 | Sonnet 4.6 fallback cost | LOW | ~$0.30/project/month worst case at 30-min cadence (budget-infinite per user) |

## 8. Open questions — all defaulted

All 8 planner OQs taken as **default** (no user input needed):
1. Lockfile location: project-local
2. Default interval: 30 min
3. Hot-reload interval: NO (boot-time only)
4. Allowlist sort: file order
5. Prompt import: from `dist/` (single source of truth)
6. `extract.ts` lockfile awareness: NO (scheduler-only in v0.3.1)
7. Per-project log: append-only with user-managed rotation
8. Fixture language: RU+EN mix

## 9. Codex review log

### Round 1 (2026-05-16) — 4 findings (2 P1 + 2 P2), all fixed

| # | Finding | Fix |
|---|---|---|
| C1 (P1) | `dist/index.mjs` doesn't re-export `formatExtractionPrompt`/`EXTRACT_MEMORIES_SYSTEM_PROMPT` → smoke import fails | Added Task B2a: extend `index.ts` re-exports |
| C2 (P1) | Hy3 response is top-level array `[{scene_name, …}]`, NOT object `{scenes: [...]}`. My validation would reject valid responses → artificial low rate → false R1 trigger | Updated B2 shape check |
| C3 (P2) | scheduler spawn missed `cwd: <projectPath>` — `extract.ts` uses `process.cwd()` for projectRoot, so all extracts would target scheduler's cwd | A2 now specifies `spawn(..., {cwd: projectPath})` |
| C4 (P2) | A4 mentioned "cron fallback instructions" but D1 explicitly rejects cron → self-contradiction | Dropped cron mention; install.sh prints PM2-only |

Round 2 codex runs after this commit. Per orchestrator policy: max 2 SPEC review rounds.

### Round 2 (2026-05-16) — 1 P2, fixed

| # | Finding | Fix |
|---|---|---|
| C5 (P2) | B2a added as standalone task → Phase B count was 6 (now 7), total was 14 (now 15). Risk: executor marks plan done with B2a skipped | Updated all counts: §5 header "15 commits", Phase B subhead "7 commits", final total line |

Per orchestrator policy: max 2 rounds. SPEC final. Worktree + Phase A start next.
