# Changelog

All notable changes to `@vkirill/tencentdb-agent-memory`.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org/).

For the upstream Tencent project history (pre-fork), see
[Tencent/TencentDB-Agent-Memory CHANGELOG](https://github.com/Tencent/TencentDB-Agent-Memory/blob/main/CHANGELOG.md).

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
