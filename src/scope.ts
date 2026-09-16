import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { isInside } from "./config.ts";
import type { Ragdown } from "./engine.ts";
import { formatHit } from "./format.ts";
import type { Hit } from "./store.ts";

/** Sessions whose returned chunks are remembered; past this the oldest is forgotten. */
const MAX_SESSIONS = 200;

/** Per-call overrides of the `RAGDOWN_HOOK_*` defaults for `context`. */
export interface ContextOptions {
  topK?: number;
  minScore?: number;
  minRatio?: number;
  maxChars?: number;
}

/**
 * The chunk ids `ragdown_context` already returned for each session, least recently used first.
 * One per `Ragdown`, shared by every scope and every stateless HTTP request.
 */
export class SessionMemory {
  private readonly sessions = new Map<string, Set<string>>();

  seen(key: string): Set<string> {
    let seen = this.sessions.get(key);
    if (seen) {
      // Re-insert so Map order is least-recently-used first.
      this.sessions.delete(key);
    } else {
      seen = new Set();
      if (this.sessions.size >= MAX_SESSIONS) {
        const oldest = this.sessions.keys().next().value;
        if (oldest !== undefined) this.sessions.delete(oldest);
      }
    }
    this.sessions.set(key, seen);
    return seen;
  }
}

/**
 * The notes as one MCP endpoint sees them: the whole docs folder (`dir` is empty, `/mcp`) or one
 * folder inside it (`/mcp/projects/foo`), as if that folder were the root. Every path going in is
 * relative to the scope and every path coming out is made relative to it, so an agent on a scope
 * cannot tell there is anything above it. It is not a security boundary: the same token reaches
 * `/mcp`.
 */
export class Scope {
  readonly rag: Ragdown;
  /** The folder relative to the docs root, with `/` separators; empty for the root. */
  readonly dir: string;
  /** The folder's absolute path. */
  readonly root: string;

  constructor(rag: Ragdown, dir = "") {
    this.rag = rag;
    this.dir = dir;
    this.root = resolve(rag.config.docsDir, dir);
  }

  get config() {
    return this.rag.config;
  }

  /**
   * Search the notes in this scope. Never waits for a sync: a partial answer (what is indexed so
   * far) beats a hook that times out.
   *
   * @param pathPrefix limits the search to files under this folder, relative to the scope.
   */
  async recall(query: string, topK: number, pathPrefix?: string): Promise<Hit[]> {
    const folder = [this.dir, normalizeFolder(pathPrefix)].filter(Boolean).join("/");
    const hits = await this.rag.recall(query, topK, folder ? `${folder}/` : undefined);
    return hits.map((hit) => ({ ...hit, path: this.toScoped(hit.path) }));
  }

  /**
   * The context block a hook injects for a prompt (`ragdown_context`), or undefined when nothing is
   * similar enough. Chunks already returned for the same session in this scope are left out, so a
   * long conversation about one topic pays for each note once.
   */
  async context(
    prompt: string,
    sessionId?: string,
    options: ContextOptions = {},
  ): Promise<string | undefined> {
    const topK = options.topK ?? this.config.hook.topK;
    const minScore = options.minScore ?? this.config.hook.minScore;
    const minRatio = options.minRatio ?? this.config.hook.minRatio;
    const maxChars = options.maxChars ?? this.config.hook.maxChars;
    const trimmed = prompt.trim();
    // A slash command or a one-word reply ("yes", "go on") has nothing to retrieve on.
    if (trimmed.length < 12 || trimmed.startsWith("/")) return undefined;

    const seen = sessionId
      ? this.rag.sessions.seen(`${this.dir}\0${sessionId}`)
      : new Set<string>();
    const ranked = (await this.recall(trimmed, topK * 2))
      .filter((hit) => hit.similarity >= minScore && !seen.has(hit.id))
      .sort((a, b) => b.similarity - a.similarity);
    // Then the relative floor: whatever the best hit scored, a hit well below it is noise beside
    // it, and injected noise costs accuracy rather than merely costing tokens.
    const best = ranked[0]?.similarity ?? 0;
    const hits = ranked.filter((hit) => hit.similarity >= best * minRatio).slice(0, topK);
    if (hits.length === 0) return undefined;

    const blocks: string[] = [];
    let used = 0;
    for (const hit of hits) {
      const block = formatHit(hit, Math.min(this.config.textLimit, maxChars));
      if (blocks.length > 0 && used + block.length > maxChars) break;
      blocks.push(block);
      used += block.length;
      seen.add(hit.id);
    }
    return [
      `<ragdown-context source="${this.root}">`,
      "Excerpts from the user's Markdown notes that look related to this prompt, found by search, not chosen by the user.",
      "They may be irrelevant or out of date. Use ragdown_read_doc for the whole file before relying on a fragment.",
      "",
      blocks.join("\n\n"),
      "</ragdown-context>",
    ].join("\n");
  }

  /**
   * Read a file from the folder: the source, not the index, so it is current even mid-sync. Never
   * clipped — it is what a clipped hit points at.
   */
  async readDoc(path: string, startLine?: number, endLine?: number) {
    const full = resolve(this.root, path);
    if (!isInside(this.root, full)) throw new Error(`path is outside the docs folder: ${path}`);
    const lines = (await readFile(full, "utf8")).split(/\r?\n/);
    const start = Math.max(1, startLine ?? 1);
    const end = Math.min(lines.length, endLine ?? lines.length);
    return {
      path: relative(this.root, full),
      start_line: start,
      end_line: end,
      total_lines: lines.length,
      text: lines.slice(start - 1, end).join("\n"),
    };
  }

  /**
   * Read a file for the web UI: like `readDoc`, but only a file the index holds, so a browser
   * cannot read whatever else happens to sit in the docs folder.
   *
   * @throws with `status: 404` for a path the index does not know.
   */
  async readIndexedDoc(path: string) {
    const full = resolve(this.root, path);
    if (!(await this.rag.files()).has(relative(this.rag.config.docsDir, full))) {
      throw Object.assign(new Error(`not an indexed document: ${path}`), { status: 404 });
    }
    return this.readDoc(path);
  }

  /**
   * Write a new note and index it before returning. At the root it goes under `RAGDOWN_NOTES_DIR`;
   * in a scope, in the scope's own folder, which is already where that project's notes live.
   *
   * @param name file name without extension; defaults to the date and a slug of the title. An
   *   existing file is never overwritten: a numeric suffix is added instead.
   */
  async remember(
    title: string,
    content: string,
    tags: string[] = [],
    name?: string,
    options: { supersedes?: string[]; sessionId?: string } = {},
  ) {
    const notesDir = this.dir ? this.root : this.config.notesDir;
    const date = new Date().toISOString().slice(0, 10);
    const base = name ?? `${date}-${slug(title)}`;

    // Checked before anything is written: a dangling `supersedes` would silently hide nothing, and
    // the agent that got the path wrong should hear about it rather than believe it replaced a note.
    const replaced = await Promise.all(
      (options.supersedes ?? []).map(async (path) => {
        const target = resolve(this.root, path);
        if (!isInside(this.root, target)) {
          throw new Error(`supersedes is outside the notes folder: ${path}`);
        }
        if (!(await stat(target).catch(() => undefined))?.isFile()) {
          throw new Error(`supersedes names no note in this folder: ${path}`);
        }
        return target;
      }),
    );

    let full = "";
    for (let n = 1; ; n++) {
      full = resolve(notesDir, `${base}${n === 1 ? "" : `-${n}`}.md`);
      if (!isInside(notesDir, full)) {
        throw new Error(`note name escapes the notes folder: ${base}`);
      }
      const front = [
        "---",
        `title: ${JSON.stringify(title)}`,
        `date: ${date}`,
        ...(tags.length > 0 ? [`tags: [${tags.map((t) => JSON.stringify(t)).join(", ")}]`] : []),
        // Relative to this note's own folder, which is how the indexer reads them back.
        ...(replaced.length > 0
          ? [
              `supersedes: [${replaced
                .map((target) => JSON.stringify(toPosix(relative(dirname(full), target))))
                .join(", ")}]`,
            ]
          : []),
        // Provenance: a note an agent wrote is not a note the user wrote, and whoever reads it
        // later — person or model — should be able to tell which one they are holding.
        "created_by: ragdown_remember",
        ...(options.sessionId ? [`session: ${JSON.stringify(options.sessionId)}`] : []),
        "---",
        "",
      ].join("\n");
      await mkdir(dirname(full), { recursive: true });
      try {
        await writeFile(full, `${front}${content.trimEnd()}\n`, { flag: "wx" });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const sync = await this.rag.sync(false);
    return {
      path: relative(this.root, full),
      ...(replaced.length > 0
        ? { supersedes: replaced.map((target) => relative(this.root, target)) }
        : {}),
      sync,
    };
  }

  /** Sync (or with `full`, rebuild) the whole index: there is one, shared by every scope. */
  sync(full: boolean) {
    return this.rag.sync(full);
  }

  /** The whole index's status, with the file and chunk counts narrowed to this scope. */
  async stats(includeFiles: boolean) {
    const { file_list: all = [], ...stats } = await this.rag.stats(true);
    const files = all
      .filter((file) => !this.dir || file.path.startsWith(`${this.dir}/`))
      .map((file) => ({ ...file, path: this.toScoped(file.path) }));
    return {
      ...stats,
      docs_dir: this.root,
      scope: this.dir || null,
      files: files.length,
      chunks: files.reduce((sum, file) => sum + file.chunks, 0),
      ...(includeFiles ? { file_list: files } : {}),
    };
  }

  private toScoped(path: string): string {
    return this.dir ? path.slice(this.dir.length + 1) : path;
  }
}

/**
 * The scope for a folder named in a URL, or undefined when it is not one: a missing folder, a file,
 * a symlink, or a dot-folder or `node_modules` — anything the indexer would not walk into.
 *
 * @param dir the folder relative to the docs root, `/`-separated; empty for the root.
 */
export async function openScope(rag: Ragdown, dir: string): Promise<Scope | undefined> {
  const segments = dir.split("/").filter(Boolean);
  if (segments.some((s) => s.startsWith(".") || s === "node_modules" || s.includes("\\"))) {
    return undefined;
  }
  const docsDir = await realpath(rag.config.docsDir).catch(() => undefined);
  if (!docsDir) return undefined;
  const normalized = segments.join("/");
  let current = docsDir;
  for (const segment of segments) {
    current = join(current, segment);
    // lstat, not stat: the indexer does not follow symlinks, so a symlinked folder holds no notes.
    const info = await lstat(current).catch(() => undefined);
    if (!info?.isDirectory()) return undefined;
  }
  return new Scope(rag, normalized);
}

/** `path_prefix` as a folder: `./projects/` and `projects` both mean files under `projects/`. */
function normalizeFolder(prefix: string | undefined): string {
  if (!prefix) return "";
  const folder = posix.normalize(prefix.replaceAll("\\", "/")).replace(/^(\.?\/)+|\/+$/g, "");
  if (folder === ".") return "";
  if (folder === ".." || folder.startsWith("../")) {
    throw new Error(`path_prefix is outside the docs folder: ${prefix}`);
  }
  return folder;
}

/** A relative path with `/` separators, which is what frontmatter and the index both use. */
function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function slug(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "note"
  );
}
