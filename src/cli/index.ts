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

export function buildCli(): Command {
  const program = new Command();

  program
    .name("claude-mem")
    .description("Four-layer local memory for Claude Code and other agents.")
    .version("0.1.0");

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
    .action(async () => {
      const result = await runCapture({ projectRoot: process.cwd() });
      if (!result.ok) {
        process.stderr.write(`claude-mem capture: ${result.error ?? "unknown error"}\n`);
      }
      // Hook discipline: exit 0 even on capture failure
      process.exit(0);
    });

  // Tasks 18/20 will add: recall / stats.

  return program;
}

export async function main(argv: string[]): Promise<void> {
  const program = buildCli();
  await program.parseAsync(argv);
}
