/**
 * `tencentdb-mem` CLI entry point.
 *
 * Top-level Commander program. Each subcommand lives in src/cli/commands/.
 * v0.1 wires: init. capture/recall/stats land in Tasks 16/18/20.
 *
 * Exit-code discipline: each subcommand catches its own errors and
 * exits 0 (hooks must never block the user). Errors surface via
 * stderr and the memory.log file. Non-zero exits are reserved for
 * genuine CLI usage errors (e.g. unknown subcommand) which Commander
 * handles itself.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { runInit } from "./commands/init.js";
import { runCapture } from "./commands/capture.js";
import { runRecall } from "./commands/recall.js";
import { runStats, formatStatsReport } from "./commands/stats.js";
import { runExtract, formatExtractSummary } from "./commands/extract.js";

// Read package.json version dynamically so bin output never lags behind
// the actual published version. Resolves package.json from <pkg>/dist/
// upward — the shim at bin/tencentdb-mem.mjs imports the bundled module
// from <pkg>/dist/index.mjs, so package.json sits one level up.
function readPkgVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function buildCli(): Command {
  const program = new Command();

  program
    .name("tencentdb-mem")
    .description("Four-layer local memory for Claude Code and other agents.")
    .version(readPkgVersion())
    .option("--auto-init", "auto-bootstrap .claude/memory/ on first use (for hook invocation)", false)
    .option(
      "--platform <name>",
      "host platform tag (claude-code, standalone) — accepted by every subcommand. " +
      "When combined with --auto-init, written into the new config.json. " +
      "Future v0.3 use: drives adapter dispatch for vector recall.",
    );

  program
    .command("init")
    .description("Bootstrap .claude/memory/ in the current directory.")
    .option("-f, --force", "overwrite existing config.json and .gitignore", false)
    .action(async (opts: { force?: boolean }) => {
      const result = await runInit({
        projectRoot: process.cwd(),
        force: opts.force,
      });
      if (result.ok) {
        // stdout is fine here: init is interactive, not hook-invoked
        if (result.message) process.stdout.write(result.message + "\n");
      } else {
        process.stderr.write(`tencentdb-mem init: ${result.error ?? "unknown error"}\n`);
      }
      // Always exit 0 — hook discipline
      process.exit(0);
    });

  program
    .command("capture")
    .description("Read { user, assistant } JSON on stdin; write to L0.")
    .action(async (_subOpts: unknown, cmd: Command) => {
      const opts = cmd.optsWithGlobals<{ autoInit?: boolean; platform?: string }>();
      const result = await runCapture({
        projectRoot: process.cwd(),
        autoInit: opts.autoInit,
        platform: opts.platform,
      });
      if (!result.ok) {
        process.stderr.write(`tencentdb-mem capture: ${result.error ?? "unknown error"}\n`);
      }
      // Hook discipline: exit 0 even on capture failure
      process.exit(0);
    });

  program
    .command("recall")
    .description("Keyword search over recorded turns; prints matches to stdout.")
    .requiredOption("-q, --query <text>", "search query (use '-' to read from stdin)")
    .option("-l, --limit <n>", "max number of matches", (v) => Number.parseInt(v, 10), 5)
    .option("--no-vector", "force v0.2 keyword path; skip Voyage embed even if key present")
    .option("--no-persona", "skip persona.md injection (v0.3.5)")
    .option("--no-scenes", "skip scene index injection (v0.3.5)")
    .action(async (subOpts: { query: string; limit: number; vector?: boolean; persona?: boolean; scenes?: boolean }, cmd: Command) => {
      const globals = cmd.optsWithGlobals<{ autoInit?: boolean; platform?: string }>();
      let query = subOpts.query;
      if (query === "-") {
        query = await readStdinTrimmed();
      }
      const result = await runRecall({
        projectRoot: process.cwd(),
        query,
        limit: subOpts.limit,
        autoInit: globals.autoInit,
        platform: globals.platform,
        vector: subOpts.vector,
        includePersona: subOpts.persona,
        includeScenes: subOpts.scenes,
      });
      if (result.ok && result.text) process.stdout.write(result.text + "\n");
      if (!result.ok) {
        process.stderr.write(`tencentdb-mem recall: ${result.error ?? "unknown error"}\n`);
      }
      process.exit(0);
    });

  program
    .command("stats")
    .description("Show memory database statistics.")
    .action(async (_subOpts: unknown, cmd: Command) => {
      const opts = cmd.optsWithGlobals<{ autoInit?: boolean; platform?: string }>();
      const result = await runStats({
        projectRoot: process.cwd(),
        autoInit: opts.autoInit,
        platform: opts.platform,
      });
      if (result.ok) {
        process.stdout.write(formatStatsReport(result) + "\n");
      } else {
        process.stderr.write(`tencentdb-mem stats: ${result.error ?? "unknown error"}\n`);
      }
      process.exit(0);
    });

  program
    .command("extract")
    .description("Run L1 LLM extraction over accumulated L0 turns (v0.3.0+). Requires OPENROUTER_API_KEY.")
    .option("--dry-run", "enumerate sessionKeys but do NOT call the LLM", false)
    .option("--max-sessions <n>", "process at most N unique sessions (0 = no cap)", (v) => Number.parseInt(v, 10), 0)
    .action(async (subOpts: { dryRun?: boolean; maxSessions?: number }, cmd: Command) => {
      const globals = cmd.optsWithGlobals<{ autoInit?: boolean }>();
      const projectRoot = process.cwd();
      const result = await runExtract({
        projectRoot,
        dryRun: subOpts.dryRun,
        maxSessions: subOpts.maxSessions,
        autoInit: globals.autoInit,
      });
      if (result.ok && result.summary) {
        process.stdout.write(formatExtractSummary(projectRoot, result.summary) + "\n");
      } else if (!result.ok) {
        process.stderr.write(`tencentdb-mem extract: ${result.error ?? "unknown error"}\n`);
      }
      // Extract is a deliberate command (not a hook) — propagate the real
      // exit code so users / CI can detect failure. This differs from
      // init/capture/recall/stats which always exit 0 for hook safety.
      process.exit(result.exitCode);
    });

  // ── v0.4.0: MCP server subcommand ──────────────────────────────────────
  const mcpCmd = new Command("mcp").description("MCP server commands");
  mcpCmd.addCommand(
    new Command("serve")
      .description("Start the MCP server on stdio for Claude Code")
      .action(async () => {
        const { runMcpServeCommand } = await import("./commands/mcp-serve.js");
        await runMcpServeCommand();
      }),
  );
  program.addCommand(mcpCmd);

  return program;
}

export async function main(argv: string[]): Promise<void> {
  const program = buildCli();
  await program.parseAsync(argv);
}

async function readStdinTrimmed(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  let total = 0;
  const MAX = 1 * 1024 * 1024; // 1 MiB cap for recall query (way more than enough)
  for await (const chunk of process.stdin) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += b.length;
    if (total > MAX) break;
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString("utf-8").trim();
}
