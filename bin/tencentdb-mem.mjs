#!/usr/bin/env node
/**
 * `claude-mem` bin shim.
 *
 * Delegates to the bundled CLI in dist/index.mjs. Distributed via
 * package.json "bin" so users get `claude-mem` on PATH after install.
 *
 * Resolution: when installed, this file ends up at <pkg>/bin/claude-mem.mjs
 * and dist/ is sibling at <pkg>/dist/. In dev (npm link / unbuilt) the
 * same path holds. No special path resolution needed beyond import.meta.
 */

import { main } from "../dist/index.mjs";

main(process.argv).catch((err) => {
  process.stderr.write(`claude-mem: ${err instanceof Error ? err.message : String(err)}\n`);
  // Discipline: per-subcommand handlers already exit 0; this catch is
  // for top-level Commander errors (unknown subcommand, etc.) — those
  // should propagate the appropriate exit code so users see the error.
  process.exit(typeof err?.exitCode === "number" ? err.exitCode : 1);
});
