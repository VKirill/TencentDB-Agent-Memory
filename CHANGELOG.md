# Changelog

All notable changes to `@vkirill/tencentdb-agent-memory`.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org/).

For the upstream Tencent project history (pre-fork), see
[Tencent/TencentDB-Agent-Memory CHANGELOG](https://github.com/Tencent/TencentDB-Agent-Memory/blob/main/CHANGELOG.md).

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

### Test plan (manual, before declaring v0.1 done)
- [ ] `npm install && npm run build && npm test` — green on Node 22 + 24
- [ ] `bash scripts/check-no-openclaw.sh` — exits 0
- [ ] `node bin/claude-mem.mjs init` in a tmp dir creates expected layout
- [ ] `capture` → `stats` → non-zero L0 count
- [ ] `recall` returns at least the captured turn
