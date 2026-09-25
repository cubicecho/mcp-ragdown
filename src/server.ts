import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { errorMessage } from "./errors.ts";
import { formatHits, hitJson } from "./format.ts";
import type { Scope } from "./scope.ts";

export const SERVER_NAME = "ragdown";
/** The package's own version: semantic-release bumps `package.json`, which ships beside `src`. */
export const VERSION: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

/**
 * The MCP surface, and the only way an agent or a hook reaches the notes. Tool names are `ragdown_*`,
 * after zeromem's `zeromem_*`: recall, read, list, backlinks, remember, edit, stats, plus reindex and context (for hooks). Under `RAGDOWN_READ_ONLY` the write tools are not listed at all — an
 * agent should never see a tool it cannot call.
 *
 * @param ready resolves to the scope — the folder these tools treat as the root — once the model is
 *   loaded. Taking a promise lets the stdio
 *   transport connect first, so a client's handshake never waits on the model; a call made before
 *   then waits instead.
 * @param folder names the server after its folder (`ragdown-<name>`) and tells the model which
 *   notes these are, since one client may connect to several folders' servers at once.
 */
export function createMcpServer(
  ready: Promise<Scope>,
  readOnly: boolean,
  folder?: { name: string; title: string },
): McpServer {
  const which = folder
    ? `the "${folder.title}" folder of the user's Markdown notes`
    : "the user's folder of Markdown notes";
  const server = new McpServer(
    { name: folder ? `${SERVER_NAME}-${folder.name}` : SERVER_NAME, version: VERSION },
    {
      instructions: `Search ${which}. Call ragdown_recall before answering a question the notes might cover (project decisions, how-tos, runbooks, personal notes), then ragdown_read_doc to read around a hit before relying on it.`,
    },
  );

  server.registerTool(
    "ragdown_recall",
    {
      title: "Search notes",
      description:
        "Hybrid (semantic + keyword) search over the user's Markdown notes. Returns the most relevant sections with file path, line range, heading breadcrumb and cosine similarity (above ~0.8 is usually on topic). Use it before answering anything the notes may cover; follow up with ragdown_read_doc for the surrounding text.",
      inputSchema: {
        query: z.string().min(1).describe("What to look for, as a question or keywords"),
        top_k: z.number().int().min(1).max(50).default(8),
        path_prefix: z
          .string()
          .optional()
          .describe(
            "Only search files under this subfolder, relative to the notes root, e.g. 'projects/'",
          ),
        tag: z
          .string()
          .optional()
          .describe(
            "Only search notes with this tag (frontmatter tags or inline #tags); 'project' also matches 'project/alpha'",
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
        const hits = await rag.recall(args.query, args.top_k, args.path_prefix, args.tag);
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
        min_ratio: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe(
            "Lowest share of the best hit's similarity a hit may have and still be included; 0 keeps every hit above min_score. Default RAGDOWN_HOOK_MIN_RATIO",
          ),
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
          minRatio: args.min_ratio,
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
        "Read a Markdown file from the notes folder, whole or by line range, straight from disk. Never clipped. Use it to see the context around a ragdown_recall hit, or to follow a [[wikilink]] in a note. The result's hash is the whole file's, for ragdown_edit's base_hash.",
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe(
            "Path relative to the notes root, as returned by ragdown_recall, or a wikilink target as written inside [[...]] ('Note', 'Note#Heading', 'sub/Note'); a heading narrows the text to that section",
          ),
        start_line: z.number().int().min(1).optional(),
        end_line: z.number().int().min(1).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => run(ready, (rag) => rag.readDoc(args.path, args.start_line, args.end_line)),
  );

  server.registerTool(
    "ragdown_backlinks",
    {
      title: "Notes linking here",
      description:
        "The notes that link to a note — by [[wikilink]], alias, or relative Markdown link — each with the lines the links are on. Use it to find what depends on or refers to a note, e.g. before changing or superseding it.",
      inputSchema: {
        path: z.string().min(1).describe("Path of the note relative to the notes root"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => run(ready, (rag) => rag.backlinks(args.path)),
  );

  server.registerTool(
    "ragdown_list",
    {
      title: "List notes",
      description:
        "Browse the notes rather than search them: every note's path, title, tags and last change, optionally under a subfolder or with a tag. sort: 'recent' puts the most recently changed first.",
      inputSchema: {
        path_prefix: z
          .string()
          .optional()
          .describe(
            "Only notes under this subfolder, relative to the notes root, e.g. 'projects/'",
          ),
        tag: z
          .string()
          .optional()
          .describe("Only notes with this tag; 'project' also matches 'project/alpha'"),
        sort: z.enum(["path", "recent"]).default("path"),
        limit: z.number().int().min(1).max(1000).default(100),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      run(ready, (rag) =>
        rag.listDocs({
          pathPrefix: args.path_prefix,
          tag: args.tag,
          sort: args.sort,
          limit: args.limit,
        }),
      ),
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
          "Save something worth keeping (a decision, a fix, a how-to) as a new Markdown note in the notes folder, indexed immediately so later searches find it. Never overwrites an existing file. When this note replaces an earlier one, pass that note's path as supersedes so searches stop returning the old version.",
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
          supersedes: z
            .array(z.string())
            .optional()
            .describe(
              "Paths of notes this one replaces, as returned by ragdown_recall. They stay on disk and ragdown_read_doc still opens them, but search and hook context skip them. Use it when a fact changed, not when you are merely writing about the same topic.",
            ),
          session_id: z
            .string()
            .optional()
            .describe("Stable id of the conversation, recorded in the note's frontmatter"),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      },
      (args) =>
        run(ready, (rag) =>
          rag.remember(args.title, args.content, args.tags, args.name, {
            supersedes: args.supersedes,
            sessionId: args.session_id,
          }),
        ),
    );

    server.registerTool(
      "ragdown_edit",
      {
        title: "Edit a note",
        description:
          "Change an existing note, or create one at a path you choose. By default text replaces the whole file (frontmatter included), which for an existing note needs base_hash: the hash ragdown_read_doc returned, so you never overwrite a version you have not read. append: true adds text at the end of the note, or with heading at the end of that section, leaving the rest as it is. If the file changed since base_hash, nothing is written: read it again and redo the edit.",
        inputSchema: {
          path: z
            .string()
            .min(1)
            .describe(
              "Path of a Markdown file relative to the notes root, e.g. 'projects/alpha.md'",
            ),
          text: z.string().min(1).describe("The note's new Markdown, or with append, what to add"),
          base_hash: z
            .string()
            .optional()
            .describe("The hash from ragdown_read_doc; required to replace an existing note"),
          append: z.boolean().default(false),
          heading: z
            .string()
            .optional()
            .describe("With append: add to the end of the section under this heading"),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      },
      (args) =>
        run(ready, (rag) =>
          rag.editDoc(args.path, args.text, {
            append: args.append,
            heading: args.heading,
            baseHash: args.base_hash,
          }),
        ),
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
  ready: Promise<Scope>,
  body: (rag: Scope) => Promise<unknown>,
): Promise<CallToolResult> {
  try {
    const result = await body(await ready);
    const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    return { content: [{ type: "text", text }] };
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: errorMessage(error) }] };
  }
}
