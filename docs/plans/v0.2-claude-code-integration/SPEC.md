# v0.2 SPEC — Claude Code Integration (WP3 full + WP3.6 smoke + WP4)

> Version: 0.2.0-draft · Date: 2026-05-16 · Owner: VKirill
> Branch (planned): `feat/v0.2-claude-code-integration`
> Master SPEC: `/home/ubuntu/.claude/memory-fork-plan/SPEC.md`
> Predecessor: v0.1 SPEC at `docs/plans/v0.1-decouple-and-cli/SPEC.md` (must ship first; some tasks depend on v0.1 Task 21 LLM slug fix)
> **Status:** Draft from `@feature-planner` (background run, 2026-05-16). `/codex:review` pending. **3 open questions** must be answered before Phase B+C start.

---

## 1. Goal

Make `@vkirill/tencentdb-agent-memory` fully usable inside a Claude Code project:

1. **WP3 full** — `ClaudeCodeHostAdapter` + `ClaudeCodeLLMRunnerFactory` wired through CLI via `--platform claude-code` flag or `config.platform: "claude-code"` setting.
2. **WP3.6** — Hy3 JSON-reliability smoke test. 20 L0→L1 extraction prompts against real Hy3 via OpenRouter. Asserts valid-JSON rate ≥ 95%. On failure → activate pre-approved R1 fallback (L0→L1 switches to `anthropic/claude-sonnet-4.6`; L2/L3 stay on Hy3).
3. **WP4** — hook templates + non-destructive `install.sh` + `.env.example` + README + `uninstall.sh`. Goal: `bash install.sh` in any Claude Code project → 4 hooks fire → memory persists across sessions.

## 2. Non-Goals (v0.2)

- ❌ Migration from `claude-mem v12.7.5` data → v0.3
- ❌ MCP server variant → v0.3
- ❌ npm publish → v0.3
- ❌ Global cross-project memory at `~/.claude-mem-global/` → v0.3
- ❌ Cleanup of dead `src/core/store/tcvdb*.ts` (may opportunistically delete; mark optional in CHANGELOG if done)

## 3. Adapter design decisions

### A1. Adapter selection — **config-driven, with `--platform` override**

`.claude/memory/config.json` has `"platform": "claude-code" | "standalone"` (default `"standalone"`). CLI accepts `--platform <name>` for per-invocation override. **`CLAUDE_PROJECT_DIR` env presence is NOT used for auto-selection** (too magical, breaks debuggability between Claude Code shell and plain shell).

`install.sh` writes `"platform": "claude-code"` into config at install time — user gets right adapter without thinking.

### A2. Session/agent identity — **synthesize from `CLAUDE_PROJECT_DIR` + UTC day bucket**

```
sessionId = sha1(CLAUDE_PROJECT_DIR + "::" + yyyy-mm-dd).slice(0,16)
```

Fallback to `cwd` if `CLAUDE_PROJECT_DIR` unset. If hook payload provides `session_id` on stdin JSON, prefer it; synthesis is fallback. Day-granularity matches TDAI's L0→L1 batching semantics; turn-precise sessions aren't needed.

## 4. Hook command spec

All commands: cwd = `$CLAUDE_PROJECT_DIR`; PATH resolves `claude-mem` (preferred) or `${CLAUDE_PROJECT_DIR}/.claude/memory/.bin/claude-mem` fallback. All exit 0 unconditionally. Hard-bounded by Claude Code's 10s hook timeout.

| Hook | Command | Stdin format | Timeout | Failure mode |
|---|---|---|---|---|
| `SessionStart` | `claude-mem recall --query "$(basename "$CLAUDE_PROJECT_DIR")" --limit 5 --platform claude-code` | Hook JSON (ignored by recall; logged for debug) | 8000 ms | exit 0; empty stdout if backend dead; full error chain → `.claude/memory/memory.log` |
| `UserPromptSubmit` | `claude-mem recall --query - --limit 3 --platform claude-code` (reads query from stdin) | `{ "user_prompt": "...", "session_id": "..." }`. Command extracts `user_prompt` via inline node JSON parse (no jq dep). | 5000 ms | exit 0; empty stdout; never blocks |
| `PostToolUse` (matcher: `Edit\|Write\|MultiEdit`) | `claude-mem capture --platform claude-code &` (background, wrapper waits ≤500ms then disowns) | `{ "tool_name", "tool_input", "tool_response", "session_id" }`. Wrapper translates → `{user, assistant, metadata:{toolName, sessionId, tags:["code-change"]}}`. | wrapper <1s; capture continues in background | wrapper exit 0; bg errors → log only |
| `Stop` | `claude-mem capture --platform claude-code` (synchronous; session summary) | `{ "session_id", "stop_hook_active", "transcript"? }`. Wrapper translates → `{user: "session-end", assistant: "<transcript>", metadata:{tags:["session-summary"], sessionId}}`. | 8000 ms | exit 0; partial flush OK |

**Wrapper script:** `claude-code-integration/templates/hook-capture-wrapper.sh` (~30 lines, no jq dep — uses inline node one-liner). Keeps `capture`'s contract clean (any host); keeps `settings.json` commands single-line.

## 5. `install.sh` design

- **Idempotent.** Marker key `"_claude_mem_installed": "<version>"` in `.claude/settings.json`. Re-run upgrades in-place; never duplicates.
- **jq deep-merge** with `(event, matcher)`-tuple dedup. Existing same-matcher hook → stderr warning + skip that one hook (not whole install). `--force` to overwrite.
- **claude-mem v12.7.5 conflict detection** — pre-flight greps `"claude-mem"` outside marker. If found → exit 1 with explicit message. Override: `--allow-coexist`.
- **Requires jq.** Hard dep; if missing → print OS-specific install command and exit 1.
- **`.gitignore` append** of `.claude/memory/` (idempotent).
- **Bin symlink** `.claude/memory/.bin/claude-mem` → `$(which claude-mem)` for PATH-stability between shell and Claude Code's spawn env.

## 6. WP3.6 Hy3 smoke design

- **Standalone**: `scripts/smoke-hy3.mjs` invoked via `npm run smoke:hy3`. Not in `npm test`. CI skips when `OPENROUTER_API_KEY` unset (exit 0 + warning).
- **Dataset**: 20 `CompletedTurn` fixtures at `tests/fixtures/hy3-smoke/turns.json`. **Source — open Q2.**
- **Procedure**: per fixture, run L1 extraction prompt (reuse `src/core/prompts/l1-extraction.ts`) through `ClaudeCodeLLMRunnerFactory`. Sequential, 250 ms spacing (OpenRouter free-tier rate-limit).
- **Validation**: `JSON.parse` + minimal shape check vs L1 extraction schema.
- **Output**: JSON report `tests/output/hy3-smoke-report.json` with per-prompt `{id, ok, parseError?, latencyMs, tokensIn, tokensOut}` + aggregate `{validJsonRate, p50LatencyMs, totalCostUsd}`. Wall-clock budget 2 min.
- **Gate**: `validJsonRate >= 0.95`. On fail → exit 1, print activation snippet for fallback config; snippet also commented in `templates/config.default.json`.

## 7. TDD checklist — 13 commits

### Phase A — Claude Code adapter (5 commits)

| # | Action | Acceptance |
|---|---|---|
| 1 | 🔴 `src/adapters/claude-code/host-adapter.test.ts` — 4 cases: `getRuntimeContext()` returns `platform: "claude-code"`; `dataDir = <projectRoot>/.claude/memory`; sessionId synthesized when not provided; explicit sessionId overrides | Test red |
| 2 | 🟢 `src/adapters/claude-code/host-adapter.ts` — `ClaudeCodeHostAdapter extends StandaloneHostAdapter`; `synthesizeSessionId(projectDir, date)` helper | Tests green |
| 3 | 🔴 `src/adapters/claude-code/llm-runner.test.ts` — 3 cases: factory defaults to OpenRouter baseUrl; defaults to `tencent/hy3-preview`; respects `modelRef` override (full slug preserved — **depends on v0.1 Task 21 fix**) | Test red |
| 4 | 🟢 `src/adapters/claude-code/{llm-runner,index}.ts` + `src/adapters/index.ts` adds re-export | Tests green |
| 5 | 🔴+🟢 `src/cli/context.test.ts` +2 cases (config.platform dispatch + `--platform` flag) → implement dispatcher in `src/cli/context.ts` + global option in `src/cli/index.ts` | Tests green |

### Phase B — WP3.6 Hy3 smoke (2 commits, blocked on Q2)

| # | Action | Acceptance |
|---|---|---|
| 6 | Create `tests/fixtures/hy3-smoke/turns.json` (20 entries) + `README.md` — **blocked on Q2** | 20 entries, schema-valid |
| 7 | Create `scripts/smoke-hy3.mjs` + `npm run smoke:hy3` script. Run locally; produce report. If <95% → document fallback activation in CHANGELOG, verify commented alt-config | Smoke <2min; report present; CHANGELOG entry |

### Phase C — Hook templates + install (5 commits, blocked on Q3 for matcher decision)

| # | Action | Acceptance |
|---|---|---|
| 8 | `claude-code-integration/templates/settings.json.template` (4 hook entries) + `hook-capture-wrapper.sh` | Template parses; wrapper +x; works on stub claude-mem mock |
| 9 | `claude-code-integration/templates/.env.example` (3 vars) | File exists |
| 10 | `claude-code-integration/install.sh` per §5 design | Two runs → no duplicates; settings.json valid; second run no-op |
| 11 | `tests/integration/install-sh.test.ts` — 4 cases (fresh, idempotent, v12.7.5 conflict, unrelated keys preserved) | Tests green; temp-dir per case |
| 12 | `claude-code-integration/README.md` (~120 lines) + `uninstall.sh` (~30 lines) | README renders; uninstall removes only 4 installed hooks |

### Phase D — Manual E2E + release (1 commit)

| # | Action | Acceptance |
|---|---|---|
| 13 | Manual E2E per README "Verification": fresh project → `bash install.sh` → start `claude --debug` → confirm SessionStart recall appears in system context; do Edit; confirm L0 row in SQLite. Document in CHANGELOG. Tag `v0.2.0` (with user confirmation). | All 5 steps pass; CHANGELOG entry; tag pushed |

**Total: 13 commits, ~1090 lines new/changed across 15 new + 3 modified files.**

## 8. Open questions — BLOCKERS for Phase B+C

| # | Question | Suggested default | Blocks |
|---|---|---|---|
| **Q1** | Does v0.1's `templates/config.default.json` include a `platform` key? If not, v0.2 adds it additively. | Assume not present; v0.2 adds with default `"standalone"`, documents in CHANGELOG. Low risk. | Task A.5 |
| **Q2** | Hy3 smoke fixture dataset — **synthesize 20 fake turns** (fast, no PII, less realistic) or **extract 20 from real claude-mem v12.7.5 archive** (realistic, possible PII to redact)? | Need user input. Affects fidelity of R1 mitigation gate. | Task B.6 (blocks B.7) |
| **Q3** | `PostToolUse` matcher scope — `Edit\|Write\|MultiEdit` only, or include `Bash`? Bash 10× more rows in L0; many noise (`ls`, `cat`); but losing it loses "what agent actually did" signal. | `Edit\|Write\|MultiEdit` only in v0.2; `Bash` opt-in via config flag in v0.3 once token economics observed. | Task C.8 |

## 9. Reality-check (v0.2 vs v0.1 surface)

15 contract assumptions verified against v0.1 SPEC. One gap surfaced (additive, see Q1). All others ✅. `StandaloneHostAdapter` is constructible per assumption; `RuntimeContext.platform` is already settable; `seed` confirmed dropped; LLM slug fix landing in v0.1 Task 21 — Phase A Task 3+4 has explicit dependency.

## 10. Known tradeoffs (to fill after `/codex:review`)

> _Pending — `/codex:review` will run after v0.1 ships, before Phase A starts._
