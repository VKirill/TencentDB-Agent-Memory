/**
 * MCP server for claude-mem — v0.4.0
 *
 * Exposes 4 tools over stdio so Claude Code can call memory operations
 * directly via MCP instead of spawning hook scripts:
 *
 *   memory_search       — L1 vector/keyword search (semantic facts)
 *   conversation_search — L0 keyword search (raw turns)
 *   recall_persona      — L3 persona.md content
 *   recall_scenes       — L2 scene index (filenames + summaries)
 *
 * ADR-3: stdio transport (Claude Code spawns this via `claude-mem mcp serve`).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { runRecall } from "../cli/commands/recall.js";
import { loadContextOrAutoInit } from "../cli/context.js";
import {
  readPersonaContext,
  readSceneIndexContext,
} from "../cli/commands/recall-context.js";

// ── Strip XML wrapper helpers ────────────────────────────────────────────────

/**
 * Remove a known XML wrapper from text returned by recall-context helpers.
 * If the wrapper is not present, returns text unchanged.
 */
function stripXmlWrapper(text: string, tag: string): string {
  const open = `<${tag}>\n`;
  const close = `\n</${tag}>`;
  if (text.startsWith(open) && text.endsWith(close)) {
    return text.slice(open.length, -close.length);
  }
  return text;
}

// ── Tool handler implementations ────────────────────────────────────────────

async function handleMemorySearch(
  args: Record<string, unknown>,
): Promise<string> {
  const query = String(args.query ?? "");
  const limit = typeof args.limit === "number" ? args.limit : 5;

  const result = await runRecall({
    projectRoot: process.cwd(),
    query,
    limit,
    includePersona: false,
    includeScenes: false,
    vector: true,
    autoInit: true,
    platform: "claude-code",
  });

  if (!result.ok) {
    return `memory_search error: ${result.error ?? "unknown error"}`;
  }

  const raw = result.text.trim();
  if (!raw) return "no matches found";

  // result.text may be wrapped in <recall-matches>…</recall-matches>
  return stripXmlWrapper(raw, "recall-matches");
}

async function handleConversationSearch(
  args: Record<string, unknown>,
): Promise<string> {
  const query = String(args.query ?? "");
  const limit = typeof args.limit === "number" ? args.limit : 5;

  const result = await runRecall({
    projectRoot: process.cwd(),
    query,
    limit,
    includePersona: false,
    includeScenes: false,
    vector: false,
    autoInit: true,
    platform: "claude-code",
  });

  if (!result.ok) {
    return `conversation_search error: ${result.error ?? "unknown error"}`;
  }

  const raw = result.text.trim();
  if (!raw) return "no matches found";

  return stripXmlWrapper(raw, "recall-matches");
}

async function handleRecallPersona(): Promise<string> {
  let ctx;
  try {
    ctx = await loadContextOrAutoInit({
      projectRoot: process.cwd(),
      autoInit: true,
      platform: "claude-code",
    });
  } catch {
    return "(no persona.md yet — run `claude-mem extract` after some conversation)";
  }

  const personaRaw = readPersonaContext(ctx.dataDir);
  if (!personaRaw) {
    return "(no persona.md yet — run `claude-mem extract` after some conversation)";
  }

  return stripXmlWrapper(personaRaw, "persona-context");
}

async function handleRecallScenes(): Promise<string> {
  let ctx;
  try {
    ctx = await loadContextOrAutoInit({
      projectRoot: process.cwd(),
      autoInit: true,
      platform: "claude-code",
    });
  } catch {
    return "(no scene blocks yet — run `claude-mem extract` after some conversation)";
  }

  const scenesRaw = await readSceneIndexContext(ctx.dataDir);
  if (!scenesRaw) {
    return "(no scene blocks yet — run `claude-mem extract` after some conversation)";
  }

  return stripXmlWrapper(scenesRaw, "scene-index");
}

// ── Server setup ─────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "memory_search",
    description:
      "Search L1 structured memories (facts) by semantic similarity (Voyage vector) or keyword fallback. Returns top-K matches with type, content, and score.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query text" },
        limit: {
          type: "number",
          description: "Maximum number of matches to return (default 5)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "conversation_search",
    description:
      "Search raw L0 conversation history (verbatim user/assistant turns) by keyword substring. Returns top-K matching turns with timestamp.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Keyword search query" },
        limit: {
          type: "number",
          description: "Maximum number of turns to return (default 5)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "recall_persona",
    description:
      "Return the full persona.md (L3 user / coder profile) for the current project. Returns empty sentinel if persona not yet generated.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "recall_scenes",
    description:
      "List all L2 scene blocks (thematic memory groupings) with filename, heat, and summary. Use this to discover what topics have been captured.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

export async function runMcpServer(): Promise<void> {
  const server = new Server(
    { name: "claude-mem", version: "0.4.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const safeArgs = (args ?? {}) as Record<string, unknown>;

    let text: string;
    switch (name) {
      case "memory_search":
        text = await handleMemorySearch(safeArgs);
        break;
      case "conversation_search":
        text = await handleConversationSearch(safeArgs);
        break;
      case "recall_persona":
        text = await handleRecallPersona();
        break;
      case "recall_scenes":
        text = await handleRecallScenes();
        break;
      default:
        text = `unknown tool: ${name}`;
    }

    return {
      content: [{ type: "text" as const, text }],
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server runs until stdio closes — no explicit return.
}
