/**
 * ClaudeCodeHostAdapter — wraps StandaloneHostAdapter with Claude Code-
 * specific defaults: project-local dataDir, platform tag, and session ID
 * synthesis from CLAUDE_PROJECT_DIR + UTC day bucket.
 *
 * v0.2 SPEC §3 A2: sessionId = sha1(projectDir + "::" + yyyy-mm-dd).slice(0,16)
 * Day-granularity matches TDAI's L0→L1 batching; turn-precise sessions
 * aren't needed.
 */

import crypto from "node:crypto";
import path from "node:path";

import { StandaloneHostAdapter } from "../standalone/host-adapter.js";
import type { StandaloneLLMConfig } from "../standalone/llm-runner.js";
import type { HostAdapter, RuntimeContext, Logger, LLMRunnerFactory } from "../../core/types.js";

const PLATFORM = "claude-code";
const MEMORY_SUBDIR = path.join(".claude", "memory");

export interface ClaudeCodeHostAdapterOptions {
  /** Project root — typically process.cwd() or $CLAUDE_PROJECT_DIR. */
  projectRoot: string;
  /** LLM configuration for model calls (OpenRouter Hy3 by default). */
  llmConfig: StandaloneLLMConfig;
  /** Logger instance. */
  logger: Logger;
  /** Explicit session ID — overrides synthesis when provided. */
  sessionId?: string;
  /** Stable session key for L0/L1 grouping. Defaults to sessionId. */
  sessionKey?: string;
  /** Optional user identifier. */
  userId?: string;
  /** Optional agent identity (e.g. "primary", subagent name). */
  agentIdentity?: string;
  /** Agent execution context — defaults to "primary". */
  agentContext?: "primary" | "subagent" | "cron" | "flush";
}

export class ClaudeCodeHostAdapter implements HostAdapter {
  readonly hostType = "standalone" as const;

  private inner: StandaloneHostAdapter;
  private projectRoot: string;
  private dataDir: string;
  private explicitSessionId?: string;
  private explicitSessionKey?: string;
  private userId: string;
  private agentIdentity?: string;
  private agentContext: "primary" | "subagent" | "cron" | "flush";

  constructor(opts: ClaudeCodeHostAdapterOptions) {
    this.projectRoot = opts.projectRoot;
    this.dataDir = path.join(opts.projectRoot, MEMORY_SUBDIR);
    this.explicitSessionId = opts.sessionId;
    this.explicitSessionKey = opts.sessionKey;
    this.userId = opts.userId ?? "default_user";
    this.agentIdentity = opts.agentIdentity;
    this.agentContext = opts.agentContext ?? "primary";

    this.inner = new StandaloneHostAdapter({
      dataDir: this.dataDir,
      llmConfig: opts.llmConfig,
      logger: opts.logger,
      defaultUserId: this.userId,
      platform: PLATFORM,
    });
  }

  getRuntimeContext(): RuntimeContext {
    const sessionId = this.explicitSessionId ?? synthesizeSessionId(this.projectRoot, new Date());
    return {
      userId: this.userId,
      sessionId,
      sessionKey: this.explicitSessionKey ?? sessionId,
      platform: PLATFORM,
      agentIdentity: this.agentIdentity,
      agentContext: this.agentContext,
      workspaceDir: this.projectRoot,
      dataDir: this.dataDir,
    };
  }

  getLogger(): Logger {
    return this.inner.getLogger();
  }

  getLLMRunnerFactory(): LLMRunnerFactory {
    return this.inner.getLLMRunnerFactory();
  }
}

/**
 * Synthesize a stable session ID from project directory + UTC day bucket.
 *
 * Output: 16 lowercase hex chars (sha1 prefix).
 * Determinism: same projectDir + same UTC day → same sessionId.
 * Granularity: one session per project per UTC day.
 *
 * Exported for unit tests and for callers that want to compute the
 * sessionId without constructing a full adapter.
 */
export function synthesizeSessionId(projectDir: string, date: Date): string {
  const dayBucket = date.toISOString().slice(0, 10); // YYYY-MM-DD
  const input = `${projectDir}::${dayBucket}`;
  return crypto.createHash("sha1").update(input).digest("hex").slice(0, 16);
}
