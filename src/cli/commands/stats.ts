/**
 * `claude-mem stats` — report on the local memory state.
 *
 * v0.1 reads JSONL only (no SQLite init): counts L0 turns (user+assistant
 * pairs), L0 message rows, total bytes, last capture timestamp, and the
 * size of memory.log if present.
 *
 * v0.2 will expand to include L1/L2/L3 row counts from SQLite, embedding
 * token usage, and last pipeline run timestamp.
 */

import fs from "node:fs";
import path from "node:path";

import { loadContextOrAutoInit } from "../context.js";

const CONVERSATIONS_SUBDIR = "conversations";
const LOG_FILE = "memory.log";

export interface RunStatsOptions {
  projectRoot: string;
  /** Auto-init missing .claude/memory/ on first use (hook scenario). */
  autoInit?: boolean;
}

export interface RunStatsResult {
  ok: boolean;
  /** Number of user+assistant pairs across all conversation JSONLs. */
  l0TurnCount: number;
  /** Number of individual L0 message rows (typically 2 × turnCount). */
  l0MessageCount: number;
  /** Sum of all JSONL file sizes under conversations/. */
  conversationsDirBytes: number;
  /** Size of memory.log if it exists, else 0. */
  logFileBytes: number;
  /** ISO timestamp of the most recent capture, if any. */
  lastCaptureAt?: string;
  /** Path to the inspected data dir (for the human stdout report). */
  dataDir: string;
  error?: string;
}

interface L0Message {
  role?: string;
  content?: string;
  recordedAt?: string;
  timestamp?: number;
}

export async function runStats(opts: RunStatsOptions): Promise<RunStatsResult> {
  let ctx;
  try {
    ctx = await loadContextOrAutoInit({ projectRoot: opts.projectRoot, autoInit: opts.autoInit });
  } catch (err) {
    return emptyResult(opts.projectRoot, false, err instanceof Error ? err.message : String(err));
  }

  const convDir = path.join(ctx.dataDir, CONVERSATIONS_SUBDIR);
  const logPath = path.join(ctx.stateDir, LOG_FILE);

  let l0TurnCount = 0;
  let l0MessageCount = 0;
  let conversationsDirBytes = 0;
  let lastCaptureAt: string | undefined;

  if (fs.existsSync(convDir)) {
    const files = listJsonlFiles(convDir);
    for (const f of files) {
      try {
        const stat = fs.statSync(f);
        conversationsDirBytes += stat.size;
      } catch {
        /* skip */
      }
      const lines = safeReadLines(f);
      let pendingUser = false;
      for (const line of lines) {
        const msg = safeParse(line);
        if (!msg) continue;
        l0MessageCount += 1;
        if (msg.recordedAt) {
          if (!lastCaptureAt || msg.recordedAt > lastCaptureAt) {
            lastCaptureAt = msg.recordedAt;
          }
        }
        if (msg.role === "user") {
          pendingUser = true;
        } else if (msg.role === "assistant" && pendingUser) {
          l0TurnCount += 1;
          pendingUser = false;
        }
      }
    }
  }

  let logFileBytes = 0;
  if (fs.existsSync(logPath)) {
    try {
      logFileBytes = fs.statSync(logPath).size;
    } catch {
      /* skip */
    }
  }

  return {
    ok: true,
    l0TurnCount,
    l0MessageCount,
    conversationsDirBytes,
    logFileBytes,
    lastCaptureAt,
    dataDir: ctx.dataDir,
  };
}

function emptyResult(projectRoot: string, ok: boolean, error?: string): RunStatsResult {
  return {
    ok,
    l0TurnCount: 0,
    l0MessageCount: 0,
    conversationsDirBytes: 0,
    logFileBytes: 0,
    dataDir: path.join(projectRoot, ".claude", "memory"),
    error,
  };
}

function listJsonlFiles(dir: string): string[] {
  const out: string[] = [];
  walk(dir, out);
  return out.filter((f) => f.endsWith(".jsonl"));

  function walk(d: string, acc: string[]): void {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, acc);
      else acc.push(full);
    }
  }
}

function safeReadLines(file: string): string[] {
  try {
    return fs.readFileSync(file, "utf-8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function safeParse(line: string): L0Message | undefined {
  try {
    return JSON.parse(line) as L0Message;
  } catch {
    return undefined;
  }
}

/** Format a RunStatsResult for human stdout. */
export function formatStatsReport(r: RunStatsResult): string {
  const lines: string[] = [];
  lines.push(`claude-mem stats — ${r.dataDir}`);
  lines.push(`  L0 turns:        ${r.l0TurnCount}`);
  lines.push(`  L0 messages:     ${r.l0MessageCount}`);
  lines.push(`  conversations:   ${formatBytes(r.conversationsDirBytes)}`);
  lines.push(`  memory.log:      ${formatBytes(r.logFileBytes)}`);
  lines.push(`  last capture:    ${r.lastCaptureAt ?? "(none yet)"}`);
  return lines.join("\n");
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
