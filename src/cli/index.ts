/**
 * `claude-mem` CLI entry point.
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

import { Command } from "commander";
import { runInit } from "./commands/init.js";
import { runCapture } from "./commands/capture.js";
import { runRecall } from "./commands/recall.js";
import { runStats, formatStatsReport } from "./commands/stats.js";
import { runExtract, formatExtractSummary } from "./commands/extract.js";

export function buildCli(): Command {
  const program = new Command();

  program
    .name("claude-mem")
    .description("Four-layer local memory for Claude Code and other agents.")
    .version("0.3.1")
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
        process.stderr.write(`claude-mem init: ${result.error ?? "unknown error"}\n`);
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
        process.stderr.write(`claude-mem capture: ${result.error ?? "unknown error"}\n`);
      }
      // Hook discipline: exit 0 even on capture failure
      process.exit(0);
    });

  program
    .command("recall")
    .description("Keyword search over recorded turns; prints matches to stdout.")
    .requiredOption("-q, --query <text>", "search query (use '-' to read from stdin)")
    .option("-l, --limit <n>", "max number of matches", (v) => Number.parseInt(v, 10), 5)
    .action(async (subOpts: { query: string; limit: number }, cmd: Command) => {
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
      });
      if (result.ok && result.text) process.stdout.write(result.text + "\n");
      if (!result.ok) {
        process.stderr.write(`claude-mem recall: ${result.error ?? "unknown error"}\n`);
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
        process.stderr.write(`claude-mem stats: ${result.error ?? "unknown error"}\n`);
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
        process.stderr.write(`claude-mem extract: ${result.error ?? "unknown error"}\n`);
      }
      // Extract is a deliberate command (not a hook) — propagate the real
      // exit code so users / CI can detect failure. This differs from
      // init/capture/recall/stats which always exit 0 for hook safety.
      process.exit(result.exitCode);
    });

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
