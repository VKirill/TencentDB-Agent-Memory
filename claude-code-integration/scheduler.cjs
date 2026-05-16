#!/usr/bin/env node
// claude-mem scheduler — PM2-supervised long-lived daemon.
//
// Ticks every CLAUDE_MEM_INTERVAL_MIN minutes (default 30). On each tick:
//   1. Read allowlist ~/.claude/claude-mem-projects.txt (hot-reload per tick)
//   2. For each absolute project path:
//      a. acquireLock(<project>/.claude/memory/.extract.lock)
//      b. spawn `claude-mem extract` with cwd: project, 5-min kill timer
//      c. log result to <project>/.claude/memory/scheduler.log + stdout
//      d. releaseLock
//   3. Serial execution — never parallel (avoids LLM rate-limit storms)
//
// Graceful shutdown: SIGTERM/SIGINT → drain current project's extract,
// exit 0 within 60s (hard fallback timer).
//
// Install via:
//   pm2 start ~/.claude/hooks/claude-mem/scheduler.cjs --name claude-mem-scheduler

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn, execSync } = require("node:child_process");

const DEFAULT_INTERVAL_MIN = 30;
const DEFAULT_EXTRACT_TIMEOUT_MS = 5 * 60 * 1000; // 5 min
const STALE_LOCK_MS = 10 * 60 * 1000; // 10 min
const SIGTERM_GRACE_MS = 60 * 1000; // 60s hard fallback
const ALLOWLIST_PATH =
  process.env.CLAUDE_MEM_ALLOWLIST ||
  path.join(process.env.HOME || "/root", ".claude", "claude-mem-projects.txt");

/**
 * Resolve `claude-mem` bin path. Priority (codex round 1 adversarial P2 fix):
 *   1. $CLAUDE_MEM_BIN env (user override)
 *   2. `command -v claude-mem` lookup on PATH (covers nvm, pnpm, /usr/local,
 *      custom npm prefixes)
 *   3. Hard-coded ~/.npm-global/bin/claude-mem fallback (preserves v0.3.1
 *      pre-fix behavior on default npm-global setups)
 * Returns the resolved path or the fallback. Caller checks existence.
 */
function resolveBinPath() {
  if (process.env.CLAUDE_MEM_BIN) return process.env.CLAUDE_MEM_BIN;
  try {
    const out = execSync("command -v claude-mem", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      shell: "/bin/bash",
    }).trim();
    if (out) return out;
  } catch {
    // PATH lookup failed; fall through to default
  }
  return path.join(process.env.HOME || "/root", ".npm-global", "bin", "claude-mem");
}
const CLAUDE_MEM_BIN = resolveBinPath();

function lockPath(projectPath) {
  return path.join(projectPath, ".claude", "memory", ".extract.lock");
}

/**
 * Parse the allowlist file. Strips `#` comments + blank lines.
 * Drops non-absolute paths with a warn log (returns only valid absolute paths).
 * Missing file → empty array (caller logs).
 */
function parseAllowlist(filePath) {
  let buf;
  try {
    buf = fs.readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }
  const out = [];
  for (const rawLine of buf.split("\n")) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (!path.isAbsolute(line)) {
      // Skip silently in tests; daemon logs in runOnce
      continue;
    }
    out.push(line);
  }
  return out;
}

/** Check if a process is alive via signal 0 (POSIX). */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process; EPERM = exists but we lack permission (still alive)
    return err.code === "EPERM";
  }
}

/**
 * Try to acquire the per-project extract lock.
 * - Fresh slot → write {pid, ts}, return true.
 * - Held by alive pid → return false.
 * - Held by dead pid OR age>STALE_LOCK_MS → reclaim, return true.
 */
function acquireLock(projectPath) {
  const lp = lockPath(projectPath);
  fs.mkdirSync(path.dirname(lp), { recursive: true });

  if (fs.existsSync(lp)) {
    let existing;
    try {
      existing = JSON.parse(fs.readFileSync(lp, "utf-8"));
    } catch {
      // Corrupted lock — treat as stale and reclaim
      existing = null;
    }
    if (existing && typeof existing.pid === "number") {
      const ageMs = existing.ts ? Date.now() - Date.parse(existing.ts) : Infinity;
      const alive = isProcessAlive(existing.pid);
      if (alive && ageMs <= STALE_LOCK_MS) {
        return false;
      }
      // Stale (dead or too old) — fall through to reclaim
    }
  }

  fs.writeFileSync(
    lp,
    JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }),
  );
  return true;
}

/** Idempotent unlink. Safe to call when lock doesn't exist. */
function releaseLock(projectPath) {
  try {
    fs.unlinkSync(lockPath(projectPath));
  } catch (err) {
    if (err.code !== "ENOENT") {
      // unexpected — re-throw to surface
      throw err;
    }
  }
}

/**
 * Append a status line to per-project scheduler.log and process stdout.
 */
function logResult(projectPath, line) {
  const ts = new Date().toISOString();
  const formatted = `[${ts}] ${line}\n`;
  process.stdout.write(`scheduler ${projectPath}: ${line}\n`);
  try {
    const logPath = path.join(projectPath, ".claude", "memory", "scheduler.log");
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, formatted);
  } catch {
    // Log write failure non-fatal; stdout already happened.
  }
}

/**
 * Spawn `claude-mem extract` with cwd=projectPath, 5-min kill timer.
 * Returns Promise<{ok:boolean, exitCode:number, killed:boolean}>.
 */
function runExtractOnce(projectPath, timeoutMs) {
  return new Promise((resolve) => {
    const proc = spawn(CLAUDE_MEM_BIN, ["extract"], {
      cwd: projectPath,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    let killed = false;
    const killTimer = setTimeout(() => {
      killed = true;
      proc.kill("SIGTERM");
      setTimeout(() => proc.kill("SIGKILL"), 10_000).unref();
    }, timeoutMs);
    killTimer.unref();

    proc.on("close", (code) => {
      clearTimeout(killTimer);
      resolve({
        ok: code === 0 && !killed,
        exitCode: code,
        killed,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
    proc.on("error", (err) => {
      clearTimeout(killTimer);
      resolve({
        ok: false,
        exitCode: -1,
        killed: false,
        stdout,
        stderr: `spawn error: ${err.message}`,
      });
    });
  });
}

/**
 * One full sweep over the allowlist. Serial — never parallel.
 * Honors stopRequested for graceful shutdown.
 */
async function runOnce(allowlistPath, options = {}) {
  const { stopRequested = () => false } = options;
  const timeoutMs = Number(process.env.CLAUDE_MEM_EXTRACT_TIMEOUT_MS) || DEFAULT_EXTRACT_TIMEOUT_MS;

  const projects = parseAllowlist(allowlistPath);
  if (projects.length === 0) {
    process.stdout.write(`scheduler: allowlist empty or missing at ${allowlistPath}\n`);
    return { projects: 0, extracted: 0, skipped: 0, failed: 0 };
  }

  let extracted = 0;
  let skipped = 0;
  let failed = 0;

  for (const project of projects) {
    if (stopRequested()) {
      process.stdout.write("scheduler: stop requested, halting sweep early\n");
      break;
    }
    if (!fs.existsSync(project)) {
      logResult(project, "WARN: project path does not exist; skipping");
      continue;
    }
    if (!acquireLock(project)) {
      logResult(project, "WARN: lock held by another process, skipping");
      skipped += 1;
      continue;
    }
    try {
      const result = await runExtractOnce(project, timeoutMs);
      if (result.killed) {
        logResult(project, `FAIL: extract killed after ${timeoutMs}ms timeout`);
        failed += 1;
      } else if (!result.ok) {
        logResult(
          project,
          `FAIL: extract exit=${result.exitCode} ${result.stderr ? `stderr=${result.stderr.slice(0, 200)}` : ""}`,
        );
        failed += 1;
      } else {
        logResult(project, `OK: ${result.stdout || "extract completed"}`);
        extracted += 1;
      }
    } finally {
      releaseLock(project);
    }
  }

  return { projects: projects.length, extracted, skipped, failed };
}

/**
 * Main entry point — PM2 spawns this. Boots immediately, then ticks
 * every CLAUDE_MEM_INTERVAL_MIN minutes. Handles SIGTERM/SIGINT.
 */
async function main() {
  const intervalMin = Number(process.env.CLAUDE_MEM_INTERVAL_MIN) || DEFAULT_INTERVAL_MIN;
  const intervalMs = intervalMin * 60 * 1000;

  process.stdout.write(
    `scheduler: starting (allowlist=${ALLOWLIST_PATH}, interval=${intervalMin}min, bin=${CLAUDE_MEM_BIN})\n`,
  );

  let stopRequested = false;

  const shutdown = (signal) => {
    process.stdout.write(`scheduler: ${signal} received, draining...\n`);
    stopRequested = true;
    // Hard fallback so PM2 doesn't SIGKILL us
    setTimeout(() => {
      process.stdout.write("scheduler: hard timeout, exit 0\n");
      process.exit(0);
    }, SIGTERM_GRACE_MS).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  const sleep = (ms) =>
    new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      t.unref();
    });

  // Chained-setTimeout loop (codex round 1 adversarial P2 fix):
  // setInterval overlaps when a tick exceeds intervalMs (slow LLM, 5-min
  // timeouts, many projects). Chain pattern guarantees serial ticks +
  // no parallel sweeps, preserving the "no rate-limit storm" invariant.
  while (!stopRequested) {
    try {
      const summary = await runOnce(ALLOWLIST_PATH, { stopRequested: () => stopRequested });
      process.stdout.write(
        `scheduler: tick complete projects=${summary.projects} ok=${summary.extracted} skip=${summary.skipped} fail=${summary.failed}\n`,
      );
    } catch (err) {
      process.stderr.write(`scheduler: tick error: ${err.message}\n`);
    }
    if (stopRequested) break;
    await sleep(intervalMs);
  }

  process.stdout.write("scheduler: drained, exit 0\n");
  process.exit(0);
}

module.exports = {
  parseAllowlist,
  acquireLock,
  releaseLock,
  runOnce,
  runExtractOnce,
  main,
};

// Boot when invoked directly (PM2 spawns this file)
if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`scheduler: fatal: ${err.message}\n`);
    process.exit(1);
  });
}
