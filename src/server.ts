import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Ragdown } from "./engine.ts";
import { errorMessage } from "./errors.ts";
import { formatHits, hitJson } from "./format.ts";

export const SERVER_NAME = "ragdown";
export const VERSION = "0.1.0";

/**
 * The MCP surface, and the only way an agent or a hook reaches the notes. Tool names are `ragdown_*`,
 * after zeromem's `zeromem_*`: recall, read, remember, stats, plus reindex and context (for hooks). Under `RAGDOWN_READ_ONLY` the two write tools are not listed at all — an
 * agent should never see a tool it cannot call.
 *
 * @param ready resolves to the engine once the model is loaded. Taking a promise lets the stdio
 *   transport connect first, so a client's handshake never waits on the model; a call made before
 *   then waits instead.
 */
export function createMcpServer(ready: Promise<Ragdown>, readOnly: boolean): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: VERSION },
    {
      instructions:
        "Search the user's folder of Markdown notes. Call ragdown_recall before answering a question the notes might cover (project decisions, how-tos, runbooks, personal notes), then ragdown_read_doc to read around a hit before relying on it.",
    },
  );

  server.registerTool(
    "ragdown_recall",
    {
      title: "Search notes",
      description:
        "Hybrid (semantic + keyword) search over the user's Markdown notes. Returns the most relevant sections with file path, line range, heading breadcrumb and cosine similarity (above ~0.7 is usually on topic). Use it before answering anything the notes may cover; follow up with ragdown_read_doc for the surrounding text.",
      inputSchema: {
        query: z.string().min(1).describe("What to look for, as a question or keywords"),
        top_k: z.number().int().min(1).max(50).default(8),
        path_prefix: z
          .string()
          .optional()
          .describe(
            "Only search files under this folder, relative to the notes root, e.g. 'projects/'",
          ),
        format: z.enum(["text", "json"]).default("text"),
        max_chars: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("text format: characters per hit before it is clipped (0 = never)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      run(ready, async (rag) => {
        const hits = await rag.recall(args.query, args.top_k, args.path_prefix);
        return args.format === "json"
          ? { hits: hits.map(hitJson) }
          : formatHits(hits, args.max_chars ?? rag.config.textLimit);
      }),
  );

  server.registerTool(
    "ragdown_context",
    {
      title: "Context for a prompt",
      description:
        "For hooks that run before a turn: the notes related to a user prompt, as a ready-to-inject <ragdown-context> block, or empty text when nothing is similar enough. Unlike ragdown_recall it filters by min_score, skips short prompts and slash commands, and never returns a section twice for the same session_id.",
      inputSchema: {
        prompt: z.string().describe("The user's prompt, verbatim"),
        session_id: z
          .string()
          .optional()
          .describe("Stable id of the conversation; sections already returned for it are skipped"),
        top_k: z.number().int().min(1).max(50).optional().describe("Default RAGDOWN_HOOK_TOP_K"),
        min_score: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Lowest cosine similarity to include. Default RAGDOWN_HOOK_MIN_SCORE"),
        max_chars: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Most characters in the block. Default RAGDOWN_HOOK_MAX_CHARS"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      run(ready, async (rag) => {
        const context = await rag.context(args.prompt, args.session_id || undefined, {
          topK: args.top_k,
          minScore: args.min_score,
          maxChars: args.max_chars,
        });
        return context ?? "";
      }),
  );

  server.registerTool(
    "ragdown_read_doc",
    {
      title: "Read a note",
      description:
        "Read a Markdown file from the notes folder, whole or by line range, straight from disk. Never clipped. Use it to see the context around a ragdown_recall hit.",
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe("Path relative to the notes root, as returned by ragdown_recall"),
        start_line: z.number().int().min(1).optional(),
        end_line: z.number().int().min(1).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => run(ready, (rag) => rag.readDoc(args.path, args.start_line, args.end_line)),
  );

  server.registerTool(
    "ragdown_stats",
    {
      title: "Index status",
      description:
        "The notes folder, index size (files, chunks), embedder, whether this process is the indexing primary, and the last sync. include_files lists every indexed file.",
      inputSchema: { include_files: z.boolean().default(false) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => run(ready, (rag) => rag.stats(args.include_files)),
  );

  if (!readOnly) {
    server.registerTool(
      "ragdown_remember",
      {
        title: "Write a note",
        description:
          "Save something worth keeping (a decision, a fix, a how-to) as a new Markdown note in the notes folder, indexed immediately so later searches find it. Never overwrites an existing file.",
        inputSchema: {
          title: z.string().min(1),
          content: z
            .string()
            .min(1)
            .describe("Markdown body; the title and date go in frontmatter"),
          tags: z.array(z.string()).optional(),
          name: z
            .string()
            .optional()
            .describe(
              "File name under the notes folder, without .md; defaults to <date>-<title-slug>",
            ),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      },
      (args) => run(ready, (rag) => rag.remember(args.title, args.content, args.tags, args.name)),
    );

    server.registerTool(
      "ragdown_reindex",
      {
        title: "Reindex notes",
        description:
          "Bring the index up to date with the folder now. Changes are normally picked up automatically within a second; use this after bulk edits made while no server was running, or full: true to re-embed everything.",
        inputSchema: { full: z.boolean().default(false) },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      },
      (args) => run(ready, (rag) => rag.sync(args.full)),
    );
  }

  return server;
}

/** A tool failure is a result the model can read, never a transport error. */
async function run(
  ready: Promise<Ragdown>,
  body: (rag: Ragdown) => Promise<unknown>,
): Promise<CallToolResult> {
  try {
    const result = await body(await ready);
    const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    return { content: [{ type: "text", text }] };
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: errorMessage(error) }] };
  }
}
