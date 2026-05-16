/**
 * `claude-mem init` — bootstrap a project's .claude/memory/ directory.
 *
 * Writes config.json (from templates/config.default.json) and .gitignore.
 * Idempotent without --force. Exits 0 even on failure (hook discipline);
 * the CLI wrapper logs errors to stderr but doesn't propagate non-zero
 * exits because hooks must never block the user.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MEM_SUBDIR = path.join(".claude", "memory");
const CONFIG_FILE = "config.json";
const GITIGNORE_FILE = ".gitignore";

export interface RunInitOptions {
  /** Project root — typically process.cwd(). */
  projectRoot: string;
  /** Overwrite existing config.json and .gitignore. Default: false. */
  force?: boolean;
  /**
   * Silent mode: omit result.message. Used by --auto-init from
   * Claude Code hooks where stdout must stay clean. Creation still
   * happens; only the human-readable message is suppressed.
   * Errors (result.error) are NOT suppressed.
   */
  silent?: boolean;
}

export interface RunInitResult {
  /** True if the command completed without throwing. */
  ok: boolean;
  /** True if at least one file was newly written this run. */
  created: boolean;
  /** Human-readable message (for stdout in interactive use). */
  message?: string;
  /** Error string if ok=false. */
  error?: string;
}

/**
 * Resolve the path to the bundled default-config template.
 *
 * Strategy:
 *   1. Try ../../../templates/config.default.json relative to this module
 *      (works in dev: src/cli/commands → repo root).
 *   2. Try ../../templates/config.default.json (works in built dist:
 *      dist/cli/commands → dist/.. → repo root).
 *   3. Fail with a clear error if neither resolves.
 */
function resolveTemplatePath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../../templates/config.default.json"),
    path.resolve(here, "../../templates/config.default.json"),
    path.resolve(here, "../templates/config.default.json"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(
    `claude-mem init: could not locate templates/config.default.json near ${here}. ` +
    `Tried: ${candidates.join(", ")}`,
  );
}

export async function runInit(opts: RunInitOptions): Promise<RunInitResult> {
  try {
    const memDir = path.join(opts.projectRoot, MEM_SUBDIR);
    const configPath = path.join(memDir, CONFIG_FILE);
    const gitignorePath = path.join(memDir, GITIGNORE_FILE);

    fs.mkdirSync(memDir, { recursive: true });

    let created = false;

    // config.json
    const configExists = fs.existsSync(configPath);
    if (!configExists || opts.force) {
      const tpl = resolveTemplatePath();
      const tplContents = fs.readFileSync(tpl, "utf-8");
      fs.writeFileSync(configPath, tplContents);
      created = true;
    }

    // .gitignore (always `*` — hide whole memory dir from project's git)
    const giExists = fs.existsSync(gitignorePath);
    if (!giExists || opts.force) {
      fs.writeFileSync(gitignorePath, "*\n");
      created = true;
    }

    const msg = created
      ? configExists && opts.force
        ? `Re-initialized at ${memDir} (force)`
        : `Initialized at ${memDir}`
      : `Already initialized at ${memDir}`;

    return opts.silent
      ? { ok: true, created }
      : { ok: true, created, message: msg };
  } catch (err) {
    return {
      ok: false,
      created: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
