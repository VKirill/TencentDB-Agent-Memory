#!/usr/bin/env node
// scripts/smoke-hy3.mjs — Hy3 reliability smoke (v0.3.1).
//
// Walks 20 fixture turns through the REAL OpenRouter Hy3 endpoint using
// the same L1 extraction prompt that the production extract path uses
// (imported from dist/ for single-source-of-truth).
//
// Pass gate: ≥80% valid-JSON rate (per SPEC). Below that → exit 1 with
// R1 fallback activation snippet (switch extraction.model to Sonnet 4.6).
//
// Skipped in CI without OPENROUTER_API_KEY (exit 0 + warning) — matches
// v0.2 SPEC pattern for paid-call gates.
//
// Run: OPENROUTER_API_KEY=sk-or-... npm run smoke:hy3

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_PATH = path.join(REPO_ROOT, "tests", "fixtures", "hy3-smoke", "turns.json");
const REPORT_DIR = path.join(REPO_ROOT, "tests", "output");
const REPORT_PATH = path.join(REPORT_DIR, "hy3-smoke-report.json");
const DIST_PATH = path.join(REPO_ROOT, "dist", "index.mjs");

const PASS_GATE = 0.8;          // ≥80% valid JSON required
const SPACING_MS = 500;          // 2 RPS, well under OpenRouter free tier 3 RPS
const SESSION_KEY = "smoke-test";

function log(...args) {
  process.stdout.write(`smoke-hy3: ${args.join(" ")}\n`);
}

function warn(...args) {
  process.stderr.write(`smoke-hy3: WARN: ${args.join(" ")}\n`);
}

function err(...args) {
  process.stderr.write(`smoke-hy3: ERROR: ${args.join(" ")}\n`);
}

async function main() {
  // ── Preflight ──────────────────────────────────────────────────────
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    warn("OPENROUTER_API_KEY not set — skipping smoke (CI-safe exit 0)");
    process.exit(0);
  }

  if (!fs.existsSync(DIST_PATH)) {
    err(`dist/ missing at ${DIST_PATH} — run 'npm run build' first`);
    process.exit(1);
  }

  if (!fs.existsSync(FIXTURE_PATH)) {
    err(`fixture missing at ${FIXTURE_PATH}`);
    process.exit(1);
  }

  // ── Import prompts + runner from dist (single source of truth) ────
  const dist = await import(DIST_PATH);
  const {
    EXTRACT_MEMORIES_SYSTEM_PROMPT,
    formatExtractionPrompt,
    StandaloneLLMRunnerFactory,
  } = dist;
  if (!EXTRACT_MEMORIES_SYSTEM_PROMPT || !formatExtractionPrompt || !StandaloneLLMRunnerFactory) {
    err("dist/ missing required exports (EXTRACT_MEMORIES_SYSTEM_PROMPT, formatExtractionPrompt, StandaloneLLMRunnerFactory) — rebuild");
    process.exit(1);
  }

  // ── Load fixtures ─────────────────────────────────────────────────
  const turns = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf-8"));
  if (!Array.isArray(turns) || turns.length === 0) {
    err("fixture is not a non-empty array");
    process.exit(1);
  }
  log(`loaded ${turns.length} fixture turns from ${FIXTURE_PATH}`);

  // ── Build LLM runner ──────────────────────────────────────────────
  const factory = new StandaloneLLMRunnerFactory({
    config: {
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey,
      model: "tencent/hy3-preview",
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: (m) => warn(m),
      error: (m) => err(m),
    },
  });
  const runner = factory.createRunner({ enableTools: false, modelRef: "tencent/hy3-preview" });

  // ── Sequential walk ───────────────────────────────────────────────
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const perPrompt = [];
  let valid = 0;
  let invalid = 0;

  for (let i = 0; i < turns.length; i++) {
    const { user, assistant } = turns[i];
    // Build L1 prompt — same shape extract path uses. Pair each fixture
    // turn as one "session" containing two messages (user + assistant).
    const messages = [
      { id: `m${i}u`, role: "user", content: user, timestamp: Date.now() },
      { id: `m${i}a`, role: "assistant", content: assistant, timestamp: Date.now() + 1 },
    ];
    const userPrompt = formatExtractionPrompt({
      newMessages: messages,
      backgroundMessages: [],
      previousSceneName: undefined,
    });

    const startMs = Date.now();
    let response;
    let parseError = null;
    let parsed = null;
    let validJson = false;

    try {
      response = await runner.run({
        prompt: userPrompt,
        systemPrompt: EXTRACT_MEMORIES_SYSTEM_PROMPT,
        taskId: `smoke-${i}`,
        timeoutMs: 60_000,
      });

      // Tencent's L1 contract: top-level JSON array of scenes
      //   [{ scene_name, message_ids, memories }]
      // (Verified in src/core/record/l1-extractor.ts:parseExtractionResult)
      try {
        parsed = JSON.parse(response);
        validJson = Array.isArray(parsed) && parsed.every((s) =>
          typeof s?.scene_name === "string" && Array.isArray(s?.memories),
        );
        if (!validJson) parseError = "shape mismatch (expected array of {scene_name, memories})";
      } catch (e) {
        parseError = `JSON.parse: ${e.message}`;
      }
    } catch (e) {
      parseError = `LLM call: ${e.message}`;
    }

    const latencyMs = Date.now() - startMs;
    if (validJson) {
      valid += 1;
      log(`[${i + 1}/${turns.length}] ✅ valid (${latencyMs}ms, ${parsed.length} scene(s))`);
    } else {
      invalid += 1;
      log(`[${i + 1}/${turns.length}] ❌ invalid: ${parseError} (${latencyMs}ms)`);
    }

    perPrompt.push({
      idx: i,
      validJson,
      latencyMs,
      scenes: parsed?.length ?? 0,
      parseError,
      responsePreview: response ? response.slice(0, 200) : null,
    });

    if (i < turns.length - 1) await new Promise((r) => setTimeout(r, SPACING_MS));
  }

  // ── Aggregate + report ────────────────────────────────────────────
  const rate = valid / turns.length;
  const latencies = perPrompt.map((p) => p.latencyMs).sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)];
  const p95 = latencies[Math.floor(latencies.length * 0.95)];

  const report = {
    timestamp: new Date().toISOString(),
    model: "tencent/hy3-preview",
    fixturePath: FIXTURE_PATH,
    sessionKey: SESSION_KEY,
    aggregate: {
      total: turns.length,
      valid,
      invalid,
      validJsonRate: Number(rate.toFixed(4)),
      passGate: PASS_GATE,
      passed: rate >= PASS_GATE,
      p50LatencyMs: p50,
      p95LatencyMs: p95,
    },
    perPrompt,
  };

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  log(`report written to ${REPORT_PATH}`);
  log(`AGGREGATE: ${valid}/${turns.length} valid (${(rate * 100).toFixed(1)}%), p50=${p50}ms p95=${p95}ms`);

  if (rate < PASS_GATE) {
    err("");
    err(`FAIL: valid-JSON rate ${(rate * 100).toFixed(1)}% < gate ${(PASS_GATE * 100).toFixed(0)}%`);
    err("Activate R1 fallback (Sonnet 4.6 for L1 only) by editing templates/config.default.json:");
    err('  "extraction": { "model": "anthropic/claude-sonnet-4.6" }');
    err("Then re-run smoke. Hy3 stays for L2/L3 when those land in v0.3.3.");
    process.exit(1);
  }

  log(`PASS: rate ${(rate * 100).toFixed(1)}% ≥ ${(PASS_GATE * 100).toFixed(0)}% — Hy3 reliable for L1, no R1 fallback needed`);
  process.exit(0);
}

main().catch((e) => {
  err(`fatal: ${e.message}`);
  process.exit(1);
});
