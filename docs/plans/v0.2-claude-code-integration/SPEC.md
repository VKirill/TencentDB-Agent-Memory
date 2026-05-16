# v0.2 SPEC — Claude Code Integration (Global Install + Per-Project Auto-Init)

> Version: 0.2.0-draft (rev2) · Date: 2026-05-16 · Owner: VKirill
> Branch (planned): `feat/v0.2-claude-code-integration`
> Predecessor: v0.1 (merged to main at `9d31f51`)
> **Architecture pivot (user request 2026-05-16):** install once globally; memory accumulates per-project automatically.

---

## 1. Goal (revised)

User experience:

```bash
# One-time, machine-wide:
npm i -g github:VKirill/TencentDB-Agent-Memory
bash $(npm root -g)/@vkirill/tencentdb-agent-memory/claude-code-integration/install.sh

# Then forever, in every project:
cd ~/any-project
claude          # starts Claude Code; hooks fire automatically;
                # memory auto-inits in ./.claude/memory/ if absent;
                # subsequent sessions in the same project accumulate context
```

No per-project `bash install.sh` needed. No `claude-mem init` needed. Just `cd <project> && claude`.

Concrete deliverables:
1. **`ClaudeCodeHostAdapter` + `ClaudeCodeLLMRunnerFactory`** — wire `--platform claude-code` adapter selection (kept from rev1).
2. **Auto-init in capture/recall/stats** — when invoked with `--auto-init` flag (hooks pass it), commands silently bootstrap `.claude/memory/` if absent. Manual terminal use without the flag still errors per v0.1 contract.
3. **WP3.6 Hy3 smoke** (20 synthesized prompts, ≥95% valid-JSON, R1 fallback pre-approved) — gates v0.2 release.
4. **WP4 global install.sh** — merges hook block into `~/.claude/settings.json` (not per-project). Idempotent. Detects existing claude-mem v12.7.5 conflicts.
5. **WP4 hooks pass `$CLAUDE_PROJECT_DIR`** to commands; commands operate on that dir's `.claude/memory/`.
6. **Uninstall.sh** removes global hooks; leaves per-project memory dirs intact (user wipes manually).

## 2. Non-Goals (v0.2)

- ❌ Per-project `install.sh` — replaced by global install
- ❌ Migration from `claude-mem v12.7.5` data → v0.3
- ❌ MCP server variant → v0.3
- ❌ npm publish (still GitHub-URL install) → v0.3
- ❌ Cross-project shared memory at `~/.claude-mem-global/` → v0.3
- ❌ Cleanup of dead `src/core/store/tcvdb*.ts` → may delete opportunistically; not gated

## 3. Architecture decisions (locked)

### A1. Adapter selection — **config-driven + `--platform` override** (unchanged from rev1)

`.claude/memory/config.json` has `"platform": "claude-code" | "standalone"` (default `"standalone"`). CLI `--platform <name>` overrides per invocation. Auto-init writes `"platform": "claude-code"` when the `--auto-init` flag is set.

### A2. Session/agent identity — **synthesize from `CLAUDE_PROJECT_DIR` + UTC day bucket** (unchanged)

```
sessionId = sha1(CLAUDE_PROJECT_DIR + "::" + yyyy-mm-dd).slice(0, 16)
```

Fallback to `cwd` if `CLAUDE_PROJECT_DIR` unset. If hook payload provides `session_id` on stdin, prefer it.

### A3. **NEW** — Auto-init semantics

- New global CLI flag: `--auto-init`. When present AND the target `.claude/memory/config.json` is missing, the command silently runs `runInit({projectRoot, force: false})` first, then proceeds with the requested action.
- **Without** `--auto-init`: capture/recall/stats fail-fast on missing config (preserves v0.1 contract for terminal users).
- **With** `--auto-init`: silent creation. Log "auto-init: created .claude/memory in <path>" to `memory.log` (NOT stdout — hooks have stdout discipline).
- `init` command itself stays unchanged: explicit, prints to stdout.
- Concurrency: two parallel hooks could race on first init. Mitigation: `runInit` is already idempotent (mkdir recursive, file existence check). Acceptable race window.

### A4. **NEW** — Global hooks layout

Hooks live at `~/.claude/settings.json` (Claude Code global settings), NOT at `<project>/.claude/settings.json`. Per Claude Code's hook resolution: global hooks fire for every session in every project.

Each hook command receives `$CLAUDE_PROJECT_DIR` from Claude Code's env — the command then operates on `<CLAUDE_PROJECT_DIR>/.claude/memory/`. Project boundary preserved, no global memory pollution.

### A5. **NEW** — `claude-mem` PATH discovery

After `npm i -g`, the bin lives at `$(npm bin -g)/claude-mem`. Hooks must find it even when Claude Code spawns a shell that doesn't load the user's interactive PATH. Mitigation:
- Install script captures `which claude-mem` at install time and writes the **absolute path** into the global settings.json hook command. No PATH lookup at hook runtime.
- If `claude-mem` moves (npm upgrade), user re-runs `bash <pkg>/claude-code-integration/install.sh` — idempotent re-write.

## 4. Hook command spec (revised for global + wrapper-mediated)

All commands: cwd inherited from Claude Code (likely `$CLAUDE_PROJECT_DIR`). All exit 0 always. Bounded by 10s timeout.

**Critical contract issue addressed (codex round 1, P1.2 + P2):** Claude Code's hook stdin payloads are JSON envelopes that DO NOT match `capture`/`recall`'s expected stdin shapes. Every hook that consumes stdin MUST go through a translation step (the wrapper script). We do NOT change `capture`/`recall` to accept hook-shaped JSON — that would pollute the library contract used by terminal/library consumers.

| Hook | Hook stdin from Claude Code | Final command in settings.json | Notes |
|---|---|---|---|
| `SessionStart` | `{ "session_id", ... }` (ignored) | `<ABS_BIN> recall --query "$(basename "$CLAUDE_PROJECT_DIR")" --limit 5 --platform claude-code --auto-init` | Stdin not consumed (uses project dir name as query). Auto-init bootstraps `.claude/memory/` on first session in a new project. Recall on empty memory → "" → no stdout pollution. |
| `UserPromptSubmit` | `{ "user_prompt": "...", "session_id": "..." }` | `<ABS_BIN_DIR>/../hooks/claude-mem/recall-wrapper.sh` (script reads stdin, extracts `user_prompt` via inline node, pipes to `<ABS_BIN> recall --query - --limit 3 --platform claude-code --auto-init`) | Wrapper script handles the JSON envelope. Without wrapper, recall would search for the entire JSON string and never match. |
| `PostToolUse` (matcher: `Edit\|Write\|MultiEdit`) | `{ "tool_name", "tool_input", "tool_response", "session_id" }` | `<ABS_BIN_DIR>/../hooks/claude-mem/capture-wrapper.sh` (script translates to `{user, assistant, metadata:{toolName,sessionId,tags:["code-change"]}}` via inline node, pipes to `<ABS_BIN> capture --platform claude-code --auto-init`); wrapper backgrounds the capture with `&` and returns ≤500ms | Wrapper translates hook JSON → capture stdin shape. Backgrounded so the hook returns immediately. |
| `Stop` | `{ "session_id", "stop_hook_active", "transcript"? }` | `<ABS_BIN_DIR>/../hooks/claude-mem/stop-wrapper.sh` (script translates to `{user:"session-end", assistant:"<transcript-or-empty>", metadata:{tags:["session-summary"], sessionId}}`, pipes to `<ABS_BIN> capture --platform claude-code --auto-init`); synchronous | Wrapper translates session-end envelope → capture's `{user, assistant}` shape. |

`<ABS_BIN>` = output of `which claude-mem` at install time, baked into settings.json. `<ABS_BIN_DIR>` = `dirname` of that.

**Wrapper scripts** (3 files, ~30-40 lines each, all in `claude-code-integration/templates/`):
- `recall-wrapper.sh` — extracts `user_prompt` from stdin JSON, pipes to recall
- `capture-wrapper.sh` — translates PostToolUse envelope, pipes to capture (backgrounded)
- `stop-wrapper.sh` — translates Stop envelope, pipes to capture (synchronous)

All wrappers use inline `node -e "..."` for JSON parsing. No `jq` runtime dep (jq is only an install-time dep for `install.sh` merging settings.json).

Wrappers installed by `install.sh` to `~/.claude/hooks/claude-mem/` (chmod +x).

## 5. `install.sh` design (revised — global, not per-project)

- **Target:** `~/.claude/settings.json` (Claude Code's global settings).
- **Idempotent.** Marker key `"_claude_mem_installed": "<version>"` under the top-level `_claude_mem` object. Re-run upgrades hook commands + marker in place.
- **Captures absolute bin path** via `which claude-mem` (or `command -v`). Aborts if not found with explicit install instruction.
- **jq deep-merge** over existing settings, dedup by `(event, matcher)` tuple. Same-matcher hook → stderr warn + skip that one hook (not whole install).
- **claude-mem v12.7.5 conflict detection** — pre-flight greps `~/.claude/settings.json` for `"claude-mem"` outside the marker. If found → exit 1 with explicit message. Override: `--allow-coexist`.
- **No per-project `.gitignore`** writes (install is global). Each project's `init` (manual or auto) writes its own `.gitignore`.
- **Requires jq.** Hard dep; if missing → print OS-specific install command and exit 1.
- **Wrapper script install:** `install.sh` copies `templates/hook-capture-wrapper.sh` to `~/.claude/hooks/claude-mem/hook-capture-wrapper.sh` (creates dir if absent, `chmod +x`). Hook command refers to it via absolute path.

## 6. WP3.6 Hy3 smoke design

- **Standalone**: `scripts/smoke-hy3.mjs` invoked via `npm run smoke:hy3` (from the cloned repo, not from a user project).
- **Dataset (Q2 resolved 2026-05-16): SYNTHESIZED** — 20 hand-crafted turn fixtures in `tests/fixtures/hy3-smoke/turns.json`. PII-safe, deterministic, representative of code-edit + Q&A + debugging conversation patterns.
- **Procedure**: per fixture → L1 extraction prompt via `ClaudeCodeLLMRunnerFactory` → `JSON.parse` + shape check vs L1 schema.
- **Gate**: `validJsonRate >= 0.95`. On fail → exit 1 + activate R1 fallback (switch L0→L1 to `anthropic/claude-sonnet-4.6`; L2/L3 stay on Hy3); commented alt-config in `templates/config.default.json`.
- Skipped in CI without `OPENROUTER_API_KEY` (exit 0 + warning).

## 7. TDD checklist — 14 commits

### Phase A — Adapter + auto-init (6 commits)

| # | Action | Acceptance |
|---|---|---|
| A1 | 🔴 `src/adapters/claude-code/host-adapter.test.ts` — 4 cases: `getRuntimeContext()` returns `platform: "claude-code"`; `dataDir = <projectRoot>/.claude/memory`; sessionId synthesized from `CLAUDE_PROJECT_DIR + day`; explicit sessionId overrides | Test red |
| A2 | 🟢 `src/adapters/claude-code/{host-adapter,llm-runner,index}.ts` + add `src/adapters/index.ts` re-export | Tests green |
| A3 | 🔴 `src/cli/commands/init.test.ts` +1 case: `runInit({projectRoot, force: false, silent: true})` returns ok with no stdout (auto-init mode) | Test red |
| A4 | 🟢 add `silent` flag to `runInit` (no message in result.message when true) + `--auto-init` global option in Commander wiring; each command checks for missing config + invokes `runInit({silent: true})` when `--auto-init` is on | Manual e2e: `claude-mem capture --auto-init` in fresh tmp dir writes L0 row + .claude/memory layout silently |
| A5 | 🔴 `src/cli/context.test.ts` +2 cases: `loadContext` returns ClaudeCodeHostAdapter when `config.platform === "claude-code"`; `--platform` flag override beats config | Test red |
| A6 | 🟢 dispatcher in `src/cli/context.ts` (which adapter to instantiate); global `--platform` option | Tests green |

### Phase B — WP3.6 Hy3 smoke (2 commits)

| # | Action | Acceptance |
|---|---|---|
| B1 | ➕ `tests/fixtures/hy3-smoke/turns.json` (20 synthesized turns) + `README.md` (provenance + intended use) | 20 entries, schema-valid |
| B2 | ➕ `scripts/smoke-hy3.mjs` + `npm run smoke:hy3` script + report writer | Smoke runs locally <2 min; report at `tests/output/hy3-smoke-report.json`; CHANGELOG entry with measured rate; if <95% → activate R1 fallback in CHANGELOG note |

### Phase C — Global install + hooks (5 commits)

| # | Action | Acceptance |
|---|---|---|
| C1 | ➕ `claude-code-integration/templates/settings.json.template` (4 hooks with `<ABS_BIN>` + `<ABS_BIN_DIR>` placeholders + `--auto-init` flag) + 3 wrappers: `recall-wrapper.sh`, `capture-wrapper.sh`, `stop-wrapper.sh` (~30-40 lines each, inline node JSON parse, no jq dep) | Template parses as JSON; wrappers +x; `node`-based JSON parse verified against canonical hook payloads |
| C2 | ➕ `claude-code-integration/templates/.env.example` (OPENROUTER_API_KEY, VOYAGE_API_KEY, optional CLAUDE_MEM_LOG_LEVEL) | File present |
| C3 | **✏️ `package.json` files[]: add `claude-code-integration/`** + ➕ `claude-code-integration/install.sh` (global, captures `which claude-mem`, merges into `~/.claude/settings.json` via jq, dedup by event+matcher tuple, installs wrappers to `~/.claude/hooks/claude-mem/`, chmod +x). **CRITICAL (codex round 1, P1.1):** without the files[] update, `npm i -g github:...` ships a package without install.sh and the documented install flow fails with "No such file or directory". | Two runs → no duplicate hooks; idempotent; bails on missing `claude-mem` bin; `npm pack --dry-run` lists `claude-code-integration/**` |
| C4 | ➕ `tests/integration/install-sh.test.ts` — 5 cases: fresh install adds 4 hooks; rerun is idempotent; conflicting v12.7.5 detected → exit 1 unless --allow-coexist; unrelated user keys preserved; wrappers installed to `~/.claude/hooks/claude-mem/` with +x bits | Tests green; uses tmp HOME |
| C5 | ➕ `claude-code-integration/README.md` (~120 lines: install once, verify via `claude-mem stats`, troubleshooting, disable instructions) + `uninstall.sh` (~40 lines: removes global hooks + wrapper dir, leaves per-project memory dirs) | Uninstall removes only what install added |

### Phase D — Manual E2E + release (1 commit)

| # | Action | Acceptance |
|---|---|---|
| D1 | Manual E2E checklist run + CHANGELOG `## [0.2.0] — YYYY-MM-DD` entry + tag `v0.2.0` (with user confirmation per global rules) | E2E checklist: fresh `npm i -g` → `install.sh` → `cd ~/test-project` → `claude --debug` → SessionStart hook visibly fires (memory.log entry, recall stdout in system context); do an Edit → capture happens; `claude-mem stats` in test-project → counts > 0 |

**Total: 14 commits, ~1200 lines new/changed across ~16 new + ~5 modified files.**

## 8. Open questions

| # | Question | Resolution |
|---|---|---|
| Q1 | `config.default.json` adds `platform` field? | YES, additive, default `"standalone"`. Auto-init writes `"claude-code"` when `--auto-init` flag is set. |
| Q2 | Hy3 smoke fixture dataset source | **Synthesize 20 hand-crafted turns.** User picked Variant A (PII-safe, deterministic). |
| Q3 | `PostToolUse` matcher scope | `Edit\|Write\|MultiEdit` only. `Bash` opt-in via config flag deferred to v0.3. |
| **NEW Q4** | If user has BOTH global hooks (this fork) AND per-project hooks (claude-mem v12.7.5) active in the same project, which wins? | Claude Code runs BOTH. Each writes to its own dir (`<project>/.claude/memory/` vs `~/.claude-mem/`). User can disable v12.7.5 hooks manually. We don't intervene. |
| **NEW Q5** | npm-installed bin path stability across `npm i -g` versions — does `which claude-mem` always resolve the same path? | YES on a given machine for a given npm prefix. If user changes npm prefix or uninstalls + reinstalls under a different package manager (pnpm/yarn), they re-run `install.sh` (idempotent). |

All open. Ready to implement after `/codex:review`.

## 9. Reality-check (v0.2 vs v0.1)

15 contract assumptions from rev1 plus:
- ✅ v0.1 ships `StandaloneHostAdapter` constructible per assumption (verified in master code at HEAD `9d31f51`)
- ✅ v0.1 ships `StandaloneLLMRunnerFactory` with model-slug fix (Task 21)
- ✅ v0.1 CLI exits 0 always (hook-friendly contract preserved)
- ✅ `runInit` is idempotent (already verified by tests; safe to call from auto-init path)
- ✅ `loadContext` throws on missing config — exactly the signal `--auto-init` needs to catch + bootstrap

## 10. Known tradeoffs (from `/codex:review` round 1, 2026-05-16)

| # | Finding | Disposition |
|---|---|---|
| C1 (P1) | `claude-code-integration/` not in `package.json:files[]` → `npm i -g github:...` would ship without `install.sh`, documented flow fails | **Expanded Task C3** to include the `package.json files[]` update. Acceptance: `npm pack --dry-run` lists `claude-code-integration/**`. |
| C2 (P1) | Hook command spec for `PostToolUse` + `Stop` called `claude-mem capture` directly, but Claude Code stdin shape ≠ capture's expected `{user, assistant}` shape → 0 L0 rows, silent fail | **Rewrote §4 hook command table** to use 3 wrapper scripts (`recall-wrapper.sh`, `capture-wrapper.sh`, `stop-wrapper.sh`). Wrappers translate Claude Code's envelope shapes → capture/recall stdin shapes via inline node JSON parse. Library contract for `capture`/`recall` preserved unchanged. |
| C3 (P2) | `UserPromptSubmit` hook said `recall --query -` reads stdin verbatim, but stdin is `{user_prompt, session_id, ...}` JSON → recall searches for the JSON string and never matches | **Same wrapper approach** — `recall-wrapper.sh` extracts `user_prompt` and pipes to recall. Codified in §4. |

Round-2 codex review runs immediately after this commit. Per orchestrator policy (max 2 SPEC review rounds), if round 2 reveals new P1/P2 → fix and proceed without round 3 unless user requests.
