# v0.4.0 SPEC — MCP tools + repo rebrand + README

> Version: 0.4.0-draft · Date: 2026-05-16 · Owner: VKirill
> Branch: `feat/v0.4.0-mcp-rebrand`
> Predecessor: v0.3.6 (coder-profile L3)

## 1. Goal

Three combined deliverables in one ship:

1. **MCP server** exposing 4 tools so the `MEMORY_TOOLS_GUIDE` instructions
   (already injected into agent context by v0.3.5) become callable from any
   Claude Code session. Closes the last real Tencent-design gap.
2. **Repo rebrand** to `TencentDB-Memory-Claude-Code` (npm package name,
   README badges, install URLs reflect new identity).
3. **README rewrite + INSTALL.md** so any user can install on their own
   Claude Code setup with zero prior context.

## 2. Non-goals

- New L0/L1/L2/L3 capabilities — the four layers are stable since v0.3.6.
- tcvdb cloud sync (deferred; local-first is THE design)
- Per-query vector search across L2 scenes (deferred v0.5)
- Cross-project persona inheritance (deferred)
- Persona-bootstrap from code scan (deferred — wait for usage data)

## 3. Architecture decisions

| ID | Decision | Rationale |
|---|---|---|
| ADR-1 | MCP server implemented as a separate `claude-mem mcp serve` subcommand | Mirrors `claude-mem extract`/`recall` CLI surface; Claude Code spawns it via stdio per MCP spec |
| ADR-2 | 4 MCP tools: `memory_search`, `conversation_search`, `recall_persona`, `recall_scenes` | Matches the names Tencent put in MEMORY_TOOLS_GUIDE + adds 2 v0.3.5-era helpers (persona / scenes) |
| ADR-3 | MCP server uses stdio transport (default) | Claude Code's MCP runtime supports stdio natively; no port management |
| ADR-4 | install.sh registers MCP in `~/.claude/settings.json` under `mcpServers.claude-mem` | Standard MCP wiring; idempotent (won't overwrite existing) |
| ADR-5 | npm package renamed `@vkirill/tencentdb-agent-memory` → `@vkirill/tencentdb-memory-claude-code`; bin name stays `claude-mem` (UX continuity) | Package name signals identity; binary name is what users actually type — no churn |
| ADR-6 | README rewritten from scratch (not patched) | Old README inherited Tencent shape and didn't reflect fork's purpose / Claude Code focus |
| ADR-7 | INSTALL.md = separate detailed guide; README has Quick Start (5 commands) + link to INSTALL.md | Quick Start serves browsers; INSTALL.md serves committed users |

## 4. Acceptance criteria

### MCP
1. ✅ `node bin/claude-mem.mjs mcp serve` starts MCP server on stdio
2. ✅ MCP tool `memory_search({query, limit})` returns L1 fact matches as MCP content
3. ✅ MCP tool `conversation_search({query, limit})` returns L0 turn matches
4. ✅ MCP tool `recall_persona({})` returns persona.md content (or empty if absent)
5. ✅ MCP tool `recall_scenes({})` returns scene index (filename + summary)
6. ✅ install.sh registers MCP server in ~/.claude/settings.json (idempotent)
7. ✅ Manual smoke from a real Claude Code session: `mcp__claude-mem__memory_search` callable

### Rebrand
8. ✅ `package.json` name = `@vkirill/tencentdb-memory-claude-code`
9. ✅ `claude-mem --version` = `0.4.0`
10. ✅ All install URLs in README + INSTALL point to `github:VKirill/TencentDB-Memory-Claude-Code`
11. ✅ Bin name stays `claude-mem` (no breaking change for users typing the command)

### Docs
12. ✅ README.md is a complete user-facing project page (no upstream-derived content)
13. ✅ INSTALL.md is step-by-step for fresh Claude Code setup
14. ✅ CHANGELOG `[0.4.0]` entry

### Gates
15. ✅ npm test green
16. ✅ npm run build OK
17. ✅ npm run lint:gate clean

## 5. File plan

| File | New/Mod | Lines | Purpose |
|---|---|---|---|
| `src/mcp/server.ts` | New | ~250 | MCP server with 4 tools |
| `src/cli/commands/mcp-serve.ts` | New | ~50 | CLI subcommand wrapper |
| `src/cli/index.ts` | Mod | +12 | Register `mcp` subcommand |
| `src/mcp/server.test.ts` | New | ~150 | Unit tests for tool handlers (mock store/persona) |
| `claude-code-integration/install.sh` | Mod | +30 | Register MCP in settings.json |
| `package.json` | Mod | +1/-1 dep + name + version | `@modelcontextprotocol/sdk` dep; rename; version |
| `README.md` | **Rewrite** | -300 +500 | Project overview + Quick Start (5 commands) |
| `INSTALL.md` | New | ~250 | Detailed install guide |
| `CHANGELOG.md` | Mod | +50 | `[0.4.0]` entry |
| `src/cli/index.ts` (version) | Mod | 0.3.6 → 0.4.0 | |

**Total**: 4 new + 6 modified, ~1300 LOC delta.

## 6. MCP tool spec (canonical contract for worker)

All tools follow MCP `CallToolResult` format with `content: [{type: "text", text: "..."}]`.

### `memory_search`
- **Description**: "Search L1 structured memories (facts) by semantic similarity (Voyage vector) or keyword fallback. Returns top-K matches with type, content, and score."
- **Input schema**: `{query: string, limit?: number (default 5)}`
- **Implementation**: Reuse existing `runRecall({query, limit, includePersona: false, includeScenes: false})` logic. Strip XML wrappers; return raw matches.
- **Returns**: `{type:"text", text: <formatted lines, one per match>}`

### `conversation_search`
- **Description**: "Search raw L0 conversation history (verbatim user/assistant turns) by keyword substring. Returns top-K matching turns with timestamp."
- **Input schema**: `{query: string, limit?: number (default 5)}`
- **Implementation**: Force keyword path (`includeVector: false`), reuse runRecall keyword branch.
- **Returns**: `{type:"text", text: <formatted turns>}`

### `recall_persona`
- **Description**: "Return the full persona.md (L3 user / coder profile) for the current project. Returns empty if persona not yet generated."
- **Input schema**: `{}`  (no params)
- **Implementation**: Read persona.md via `readPersonaContext()` from `recall-context.ts`; strip XML wrapper, return raw content.
- **Returns**: `{type:"text", text: <persona body or "(no persona.md yet)">}`

### `recall_scenes`
- **Description**: "List all L2 scene blocks (thematic memory groupings) with filename, heat, and summary. Use this to discover what topics have been captured."
- **Input schema**: `{}` (no params)
- **Implementation**: Read scene index via `readSceneIndexContext()`; strip XML wrapper.
- **Returns**: `{type:"text", text: <scene list>}`

## 7. install.sh MCP wiring (canonical patch)

After existing wrapper install (around line 90-100 of install.sh), add:

```bash
# ─── MCP server registration (v0.4.0) ─────────────────────────────────
SETTINGS_PATH="$HOME/.claude/settings.json"
if [ -f "$SETTINGS_PATH" ]; then
  # Idempotent: only register if not already present
  if ! grep -q '"claude-mem"' "$SETTINGS_PATH"; then
    node -e '
      const fs = require("node:fs");
      const p = "'"$SETTINGS_PATH"'";
      const s = JSON.parse(fs.readFileSync(p, "utf-8"));
      s.mcpServers = s.mcpServers || {};
      s.mcpServers["claude-mem"] = {
        command: "'"$BIN_PATH"'",
        args: ["mcp", "serve"]
      };
      fs.writeFileSync(p, JSON.stringify(s, null, 2));
      console.log("registered claude-mem MCP server in", p);
    '
  else
    echo "claude-mem MCP server already registered, skipping"
  fi
fi
```

## 8. TDD checklist — 8 commits

| # | Action | Acceptance |
|---|---|---|
| 1 | Add `@modelcontextprotocol/sdk` dep + npm install | dep present, build still works |
| 2 | Create `src/mcp/server.ts` with 4 tool handlers (skeleton + types) | imports compile |
| 3 | Implement memory_search + conversation_search handlers (reuse runRecall logic) | manual call works |
| 4 | Implement recall_persona + recall_scenes handlers (reuse recall-context helpers) | manual call works |
| 5 | Add `mcp serve` CLI subcommand + register in src/cli/index.ts | `claude-mem mcp serve --help` shows |
| 6 | Add `src/mcp/server.test.ts` — 8 cases (4 tools × happy/empty paths) | tests green |
| 7 | Patch install.sh per §7 | install.sh dry-run inserts MCP config |
| 8 | Rebrand: package.json name + version bump 0.3.6→0.4.0 | `claude-mem --version` = 0.4.0 |

(README + INSTALL + CHANGELOG handled by orchestrator after worker returns.)

## 9. Verification commands

```bash
cd /home/ubuntu/projects/TencentDB-MCP-v0.4.0
npm test                         # ≥91 passing
npm run build
npm run lint:gate

# MCP server starts:
node bin/claude-mem.mjs mcp serve <<<'{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}},"id":1}' 2>&1 | head -5

# List tools:
node bin/claude-mem.mjs mcp serve <<<'{"jsonrpc":"2.0","method":"tools/list","params":{},"id":2}'
```

Smoke output should show 4 tools registered.

## 10. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | MCP SDK v1.29.0 API may change between minor versions | Pin to `^1.29.0`; smoke test before ship |
| R2 | install.sh edits settings.json — corruption risk if user has malformed JSON | Wrap node script in try/catch; bail on parse error with warning |
| R3 | npm package rename may break users with old install pinned to `@vkirill/tencentdb-agent-memory` | They keep working from cached install; on `npm i -g github:...#v0.4.0` they pick up the new name automatically (npm respects package.json) |
| R4 | Bin path resolution differs between npm-global / pnpm / nvm | Reuse v0.3.1 `resolveBinPath()` 3-tier pattern in install.sh |
