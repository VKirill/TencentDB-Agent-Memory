/**
 * `claude-mem recall` — keyword search over L0 JSONL conversations.
 *
 * v0.1 design: simple case-insensitive substring search over recorded
 * turns in <dataDir>/conversations/. No LLM, no vector embedding, no
 * API key required. Returns the most recent matching turns first.
 *
 * v0.2 will replace the keyword path with TdaiCore.handleBeforeRecall
 * (vector + FTS hybrid via the embedding service); the same `runRecall`
 * signature and `--query / --limit` flags stay. Hooks (SessionStart,
 * UserPromptSubmit) only need the surface contract, not the impl.
 *
 * Output budget: total formatted text capped at MAX_OUTPUT_CHARS to fit
 * inside Claude Code's hook stdout → system-context injection budget.
 */

import fs from "node:fs";
import path from "node:path";

import { loadContextOrAutoInit } from "../context.js";

const MAX_OUTPUT_CHARS = 4000;
const RECORD_SEPARATOR = "\n---\n";
const CONVERSATIONS_SUBDIR = "conversations";

export interface RunRecallOptions {
  projectRoot: string;
  /** Search query. Use '-' to read query from stdin (CLI integration). */
  query: string;
  /** Max number of matching turns to return. */
  limit: number;
  /** Auto-init missing .claude/memory/ on first use (hook scenario). */
  autoInit?: boolean;
}

export interface RunRecallResult {
  ok: boolean;
  /** Formatted text suitable for stdout / hook injection. */
  text: string;
  /** Number of distinct matches returned. */
  matchCount: number;
  error?: string;
}

interface L0Message {
  sessionKey?: string;
  sessionId?: string;
  recordedAt?: string;
  id?: string;
  role?: string;
  content?: string;
  timestamp?: number;
}

export async function runRecall(opts: RunRecallOptions): Promise<RunRecallResult> {
  let ctx;
  try {
    ctx = await loadContextOrAutoInit({ projectRoot: opts.projectRoot, autoInit: opts.autoInit });
  } catch (err) {
    return {
      ok: false,
      text: "",
      matchCount: 0,
      error: `recall: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const convDir = path.join(ctx.dataDir, CONVERSATIONS_SUBDIR);
  if (!fs.existsSync(convDir)) {
    return { ok: true, text: "", matchCount: 0 };
  }

  const query = (opts.query ?? "").trim().toLowerCase();
  if (!query) {
    return { ok: true, text: "", matchCount: 0 };
  }

  // Collect all JSONL files (newest by file name first — files are named
  // by date bucket YYYY-MM-DD.jsonl per upstream l0-recorder).
  const files = listJsonlFiles(convDir).sort().reverse();

  // Stream-read; group consecutive user/assistant pairs into a single
  // "turn" string for matching. Stop once we've collected `limit` matches
  // AND output budget reached.
  const matches: string[] = [];
  outer: for (const file of files) {
    const lines = safeReadLines(file);
    // Iterate newest-first within each file too
    let pendingUser: L0Message | undefined;
    const turns: Array<{ user: L0Message; assistant: L0Message }> = [];
    for (const line of lines) {
      const msg = safeParseLine(line);
      if (!msg) continue;
      if (msg.role === "user") {
        pendingUser = msg;
      } else if (msg.role === "assistant" && pendingUser) {
        turns.push({ user: pendingUser, assistant: msg });
        pendingUser = undefined;
      }
    }
    // Newest first within file
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i];
      const blob = `${t.user.content ?? ""}\n${t.assistant.content ?? ""}`.toLowerCase();
      if (blob.includes(query)) {
        matches.push(formatTurn(t.user, t.assistant));
        if (matches.length >= opts.limit) break outer;
      }
    }
  }

  // Compose output respecting MAX_OUTPUT_CHARS
  const text = composeBounded(matches, MAX_OUTPUT_CHARS);
  return { ok: true, text, matchCount: matches.length };
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

function safeParseLine(line: string): L0Message | undefined {
  try {
    return JSON.parse(line) as L0Message;
  } catch {
    return undefined;
  }
}

function formatTurn(user: L0Message, assistant: L0Message): string {
  const ts = user.recordedAt ?? "?";
  return `[${ts}]\nuser: ${user.content ?? ""}\nassistant: ${assistant.content ?? ""}`;
}

function composeBounded(matches: string[], maxChars: number): string {
  if (matches.length === 0) return "";
  const out: string[] = [];
  let used = 0;
  for (const m of matches) {
    const next = (out.length === 0 ? m : RECORD_SEPARATOR + m);
    if (used + next.length > maxChars) {
      // Try a truncated tail of `next`
      const remaining = maxChars - used;
      if (remaining > 50) {
        // Worth emitting a truncated entry
        out.push(next.slice(0, remaining - 5) + "…");
      }
      break;
    }
    out.push(next);
    used += next.length;
  }
  return out.join("");
}
