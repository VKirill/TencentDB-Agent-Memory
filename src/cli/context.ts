/**
 * ClaudeCliContext — host-neutral CLI context object.
 *
 * Constructed by `loadContext()` from a project's `.claude/memory/config.json`.
 * Consumed by every claude-mem subcommand (init/capture/recall/stats).
 *
 * Logger writes only to `<stateDir>/memory.log` — never to stdout —
 * because claude-mem is invoked from Claude Code hooks and stdout is
 * reserved for content the agent should see (e.g. recall output).
 */

import fs from "node:fs";
import path from "node:path";
import type { MemoryTdaiConfig } from "../config.js";
import { parseConfig } from "../config.js";
import { getEnv } from "../utils/env.js";
import { runInit } from "./commands/init.js";

export interface CliLogger {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export interface ClaudeCliContext {
  /** Fully resolved memory-tdai config (parseConfig result + env merge). */
  config: MemoryTdaiConfig;
  /** Project state dir — `<projectRoot>/.claude/memory`. */
  stateDir: string;
  /** Data dir for SQLite + JSONL (same as stateDir in v0.1). */
  dataDir: string;
  /** File-only logger, writes to `<stateDir>/memory.log`. */
  logger: CliLogger;
}

export interface LoadContextOptions {
  /** Project root — typically `process.cwd()`. `.claude/memory/` is expected here. */
  projectRoot: string;
}

const STATE_SUBDIR = path.join(".claude", "memory");
const CONFIG_FILE = "config.json";
const LOG_FILE = "memory.log";

/**
 * Load and resolve a ClaudeCliContext for the given project root.
 *
 * Steps:
 *   1. Read `.claude/memory/config.json` (throws if missing).
 *   2. Parse via `parseConfig()` → `MemoryTdaiConfig`.
 *   3. Merge env vars `OPENROUTER_API_KEY` → `config.llm.apiKey`,
 *      `VOYAGE_API_KEY` → `config.embedding.apiKey`. Env wins over file
 *      (file should never contain secrets; init writes empty `apiKey`).
 *   4. Construct a file-only logger writing to `memory.log`.
 *
 * Throws on missing config. All other failures (env unset, write failure)
 * are non-fatal and surface as logger warnings — the caller is responsible
 * for the `exit 0` discipline expected by hooks.
 */
export async function loadContext(opts: LoadContextOptions): Promise<ClaudeCliContext> {
  const stateDir = path.join(opts.projectRoot, STATE_SUBDIR);
  const configPath = path.join(stateDir, CONFIG_FILE);

  if (!fs.existsSync(configPath)) {
    throw new Error(
      `claude-mem: config.json not found at ${configPath}. ` +
      `Run 'claude-mem init' in this directory first.`,
    );
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch (err) {
    throw new Error(
      `claude-mem: failed to parse ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── Env-var merge into RAW before parseConfig ────────────────────────
  // Bug fix (codex adversarial review, 2026-05-16): parseConfig validates
  // the embedding block and disables the provider when apiKey is empty.
  // Merging env after parseConfig would set apiKey but leave enabled=false,
  // silently disabling embeddings even with a valid VOYAGE_API_KEY.
  // Merge before parsing so validation sees the resolved keys.
  const openrouterKey = getEnv("OPENROUTER_API_KEY");
  const voyageKey = getEnv("VOYAGE_API_KEY");
  if (openrouterKey) {
    const llmRaw = (raw.llm as Record<string, unknown> | undefined) ?? {};
    raw.llm = { ...llmRaw, apiKey: openrouterKey };
  }
  if (voyageKey) {
    const embRaw = (raw.embedding as Record<string, unknown> | undefined) ?? {};
    raw.embedding = { ...embRaw, apiKey: voyageKey };
  }

  const config = parseConfig(raw);

  // ── Logger: file-only, hook-friendly ─────────────────────────────────
  const logPath = path.join(stateDir, LOG_FILE);
  const logger = createFileLogger(logPath);

  return {
    config,
    stateDir,
    dataDir: stateDir,
    logger,
  };
}

function createFileLogger(logPath: string): CliLogger {
  // Ensure parent dir exists; if it can't, fall back to a no-op logger
  // (don't throw — hook stdout discipline trumps log fidelity).
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
  } catch {
    return {
      info: () => {},
      warn: () => {},
      error: () => {},
    };
  }

  const write = (level: string, message: string) => {
    const line = `${new Date().toISOString()} [${level}] ${message}\n`;
    try {
      fs.appendFileSync(logPath, line);
    } catch {
      // Swallow — hooks must never crash on log-write failure.
    }
  };

  return {
    debug: (msg) => write("debug", msg),
    info: (msg) => write("info", msg),
    warn: (msg) => write("warn", msg),
    error: (msg) => write("error", msg),
  };
}

export interface LoadOrAutoInitOptions extends LoadContextOptions {
  /** When true and the config is missing, auto-init the project dir silently first. */
  autoInit?: boolean;
}

/**
 * Load context; if missing config and `autoInit` is true, bootstrap
 * `.claude/memory/` silently first (then retry loadContext).
 *
 * v0.2 Claude Code hook contract: hooks pass `--auto-init` so the first
 * SessionStart in a fresh project just works. Terminal users (no flag)
 * still get the v0.1 error contract that tells them to run `claude-mem init`.
 *
 * Returns the loaded context, or throws if loading still fails after init.
 */
export async function loadContextOrAutoInit(opts: LoadOrAutoInitOptions): Promise<ClaudeCliContext> {
  try {
    return await loadContext(opts);
  } catch (firstErr) {
    if (!opts.autoInit) throw firstErr;

    const initRes = await runInit({ projectRoot: opts.projectRoot, silent: true });
    if (!initRes.ok) {
      throw new Error(
        `claude-mem: auto-init failed: ${initRes.error ?? "unknown error"} ` +
        `(original loadContext error: ${firstErr instanceof Error ? firstErr.message : String(firstErr)})`,
      );
    }
    return await loadContext(opts);
  }
}
