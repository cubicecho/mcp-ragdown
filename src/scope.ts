import {
  lstat,
  readdir,
  readFile,
  realpath,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, posix, relative, resolve } from "node:path";
import { listAttachments } from "./attachments.ts";
import { contentHash } from "./content-hash.ts";
import { isIndexedName, isInside, MARKDOWN, toPosix } from "./document-paths.ts";
import type { Ragdown } from "./engine.ts";
import { readSettings } from "./folders.ts";
import { headingRange } from "./headings.ts";
import { hookContext } from "./hook-context.ts";
import { type ContextOptions, resolveHook } from "./hook-settings.ts";
import {
  findLinks,
  type LinkDocument,
  type ResolvedLink,
  resolveLink,
  resolveRef,
} from "./links.ts";
import { moveInFolder } from "./move.ts";
import { Refusal } from "./refusal.ts";
import { writeRemembered } from "./remember.ts";
import { resolvePath } from "./resolve-path.ts";
import { type Hit, supersededBy } from "./store.ts";
import { writeAtomic } from "./write-atomic.ts";

/**
 * The documents as one endpoint sees them, as if its directory were the root: a folder
 * (`/mcp/work`), a subfolder inside one (`/mcp/work/projects/foo`), the whole docs dir in single
 * mode (`stdio`), or — for the web UI only — every folder at once. Every path going in is relative
 * to the scope and every path coming out is made relative to it, so an agent on a scope cannot tell
 * there is anything above it. It is not a security boundary between endpoints that share a token;
 * whether a folder has an endpoint at all is decided in `http.ts`.
 */
export class Scope {
  readonly rag: Ragdown;
  /** The directory relative to the docs root, with `/` separators; empty for the root. */
  readonly dir: string;
  /** The directory's absolute path. */
  readonly root: string;
  /**
   * The folder the scope is in, relative to the docs root: its first segment in folders mode, and
   * empty — the docs dir is the folder — in single mode or at the root. Wikilinks resolve within
   * it.
   */
  readonly folder: string;

  constructor(rag: Ragdown, dir = "") {
    this.rag = rag;
    this.dir = dir;
    this.root = resolve(rag.config.docsDir, dir);
    this.folder = rag.config.mode === "folders" ? (dir.split("/")[0] ?? "") : "";
  }

  get config() {
    return this.rag.config;
  }

  /**
   * Search the documents in this scope. Never waits for a sync: a partial answer (what is indexed
   * so far) beats a hook that times out.
   *
   * @param pathPrefix limits the search to files under this folder, relative to the scope.
   * @param tag limits it to documents with this tag or one nested under it.
   */
  async recall(query: string, topK: number, pathPrefix?: string, tag?: string): Promise<Hit[]> {
    const folder = [this.dir, normalizeFolder(pathPrefix)].filter(Boolean).join("/");
    const hits = await this.rag.recall(query, topK, folder ? `${folder}/` : undefined, tag);
    return hits.map((hit) => ({ ...hit, path: this.toScoped(hit.path) }));
  }

  /**
   * The context block a hook injects for a prompt (`ragdown_context`), or undefined when nothing is
   * similar enough. Chunks already returned for the same session in this scope are left out, so a
   * long conversation about one topic pays for each document once.
   */
  async context(
    prompt: string,
    sessionId?: string,
    options: ContextOptions = {},
  ): Promise<string | undefined> {
    // The call's own arguments, then the folder's `.ragdown.json`, then the environment's.
    const own = this.folder
      ? (await readSettings(resolve(this.config.docsDir, this.folder), this.folder)).hook
      : {};
    return hookContext({
      prompt,
      source: this.root,
      settings: resolveHook(options, own, this.config.hook),
      textLimit: this.config.textLimit,
      seenBy: () =>
        sessionId ? this.rag.sessions.seen(`${this.dir}\0${sessionId}`) : new Set<string>(),
      recall: (query, topK) => this.recall(query, topK),
    });
  }

  /**
   * Read a file from the folder: the source, not the index, so it is current even mid-sync. Never
   * clipped — it is what a clipped hit points at.
   *
   * A path that names no file is tried as a wikilink target (`Note`, `Note#Heading`, `sub/Note`);
   * a heading narrows the text to that section unless a line range is given.
   */
  async readDocument(path: string, startLine?: number, endLine?: number) {
    let full = resolve(this.root, path);
    if (!isInside(this.root, full)) throw new Error(`path is outside the docs folder: ${path}`);
    let anchor: string | undefined;
    let resolvedFrom: string | undefined;
    if (!(await stat(full).catch(() => undefined))?.isFile()) {
      const link = await this.resolveLink(path);
      if (!link || !MARKDOWN.test(link.path)) {
        throw new Error(`no such note: ${path} (not a path, and no note by that name or alias)`);
      }
      full = resolve(this.root, link.path);
      anchor = link.anchor;
      resolvedFrom = path;
    }
    const bytes = await readFile(full);
    const replacedBy = this.replacedBy(
      supersededBy(await this.rag.documents()),
      toPosix(relative(this.rag.config.docsDir, full)),
    );
    const lines = bytes.toString("utf8").split(/\r?\n/);
    const section =
      anchor && startLine === undefined && endLine === undefined
        ? headingRange(lines, anchor)
        : undefined;
    const start = Math.max(1, startLine ?? section?.start ?? 1);
    const end = Math.min(lines.length, endLine ?? section?.end ?? lines.length);
    return {
      path: toPosix(relative(this.root, full)),
      ...(resolvedFrom ? { resolved_from: resolvedFrom } : {}),
      start_line: start,
      end_line: end,
      total_lines: lines.length,
      text: lines.slice(start - 1, end).join("\n"),
      // Of the whole file as it is on disk, whatever range was read: what an edit hands back as
      // `baseHash` to say which version it was made to.
      hash: contentHash(bytes),
      ...withSupersededBy(replacedBy),
    };
  }

  /**
   * The documents in this scope whose frontmatter says they replace `rootPath`, relative to the
   * scope. Search already skips a superseded document; this is for whoever opens one anyway.
   */
  private replacedBy(by: Map<string, string[]>, rootPath: string): string[] {
    return (by.get(rootPath) ?? [])
      .filter((path) => this.contains(path))
      .map((path) => this.toScoped(path));
  }

  /** Whether a root-relative path is inside this scope. */
  private contains(rootPath: string): boolean {
    return !this.dir || rootPath.startsWith(`${this.dir}/`);
  }

  /**
   * Resolve a wikilink target within the scope's folder, Obsidian-style (`links.ts`). A target the
   * folder has but this scope does not (a subfolder endpoint linking above itself) is not found.
   *
   * @param from the linking document, relative to the scope; decides ties and relative links.
   * @returns the path relative to the scope: a document, or with `attachments`, any file.
   */
  async resolveLink(
    raw: string,
    from?: string,
    attachments = false,
  ): Promise<ResolvedLink | undefined> {
    const prefix = this.folder ? `${this.folder}/` : "";
    const documents = await this.folderDocuments();
    const others = attachments
      ? await listAttachments(resolve(this.rag.config.docsDir, this.folder))
      : [];
    const fromInFolder = from
      ? [this.dir.slice(prefix.length), from].filter(Boolean).join("/").replace(/^\//, "")
      : undefined;
    const link = resolveLink(raw, fromInFolder, documents, others);
    if (!link) return undefined;
    const rootPath = `${prefix}${link.path}`;
    if (this.dir && !rootPath.startsWith(`${this.dir}/`)) return undefined;
    return { ...link, path: this.toScoped(rootPath) };
  }

  /**
   * The documents in this scope that link to `path` — by wikilink, alias, or relative Markdown link
   * — each with the lines the links are on. Read from disk, so current even mid-sync. A document's
   * links to itself are left out.
   *
   * @throws with `status: 404` for a path the index does not know.
   */
  async backlinks(path: string) {
    const prefix = this.folder ? `${this.folder}/` : "";
    const docs = await this.rag.documents();
    const rootPath = toPosix(relative(this.rag.config.docsDir, resolve(this.root, path)));
    if (!docs.some((doc) => doc.path === rootPath)) {
      throw new Refusal(404, `not an indexed document: ${path}`);
    }
    const target = rootPath.slice(prefix.length);
    const documents = await this.folderDocuments();
    const sources = docs.filter(
      (doc) => doc.path !== rootPath && (!this.dir || doc.path.startsWith(`${this.dir}/`)),
    );
    const backlinks: { path: string; title: string; lines: { line: number; text: string }[] }[] =
      [];
    for (const doc of sources) {
      const text = await readFile(resolve(this.rag.config.docsDir, doc.path), "utf8").catch(
        () => undefined,
      );
      // A cheap test first: most documents link to nothing at all.
      if (!text || (!text.includes("[[") && !text.includes("]("))) continue;
      const from = doc.path.slice(prefix.length);
      const lines = new Set<number>();
      for (const ref of findLinks(text)) {
        if (resolveRef(ref, from, documents) === target) lines.add(ref.line);
      }
      if (lines.size === 0) continue;
      const all = text.split(/\r?\n/);
      backlinks.push({
        path: this.toScoped(doc.path),
        title: doc.title,
        lines: [...lines].map((line) => ({ line, text: clip((all[line - 1] ?? "").trim(), 240) })),
      });
    }
    return { path: this.toScoped(rootPath), backlinks };
  }

  /** Every document in the scope's folder — not only the scope — relative to the folder, for links. */
  private async folderDocuments(): Promise<LinkDocument[]> {
    const prefix = this.folder ? `${this.folder}/` : "";
    return (await this.rag.documents())
      .filter((doc) => doc.path.startsWith(prefix))
      .map((doc) => ({ path: doc.path.slice(prefix.length), aliases: doc.aliases }));
  }

  /**
   * A file inside the scope for the web UI to download — a document or an attachment. Refused like
   * a write (`resolvePath`): nothing under a dot-folder, and no symlink anywhere on the path.
   *
   * @throws with `status: 400` for such a path and `404` for no such file.
   */
  async fileFor(path: string): Promise<string> {
    const { full } = await resolvePath(this.root, path, { create: false, markdownOnly: false });
    if (!(await lstat(full).catch(() => undefined))?.isFile()) {
      throw new Refusal(404, `no such file: ${path}`);
    }
    return full;
  }

  /**
   * Read a file for the web UI: like `readDocument`, but only a file the index holds, so a browser
   * cannot read whatever else happens to sit in the docs folder.
   *
   * @throws with `status: 404` for a path the index does not know.
   */
  async readIndexedDocument(path: string) {
    const full = resolve(this.root, path);
    const rootPath = toPosix(relative(this.rag.config.docsDir, full));
    const doc = (await this.rag.documents()).find((d) => d.path === rootPath);
    if (!doc) {
      throw new Refusal(404, `not an indexed document: ${path}`);
    }
    return { ...(await this.readDocument(path)), tags: doc.tags, aliases: doc.aliases };
  }

  /**
   * Write a new document and index it before returning. At a folder's root it goes under
   * `RAGDOWN_NOTES_DIR`; in a subfolder, in the subfolder itself, which is already where that
   * project's documents live.
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
    const notesDir =
      this.dir === this.folder ? resolve(this.root, this.config.notesDir) : this.root;
    const { full, replaced } = await writeRemembered({
      root: this.root,
      notesDir,
      title,
      content,
      tags,
      name,
      supersedes: options.supersedes ?? [],
      sessionId: options.sessionId,
    });
    const sync = await this.rag.sync(false);
    return {
      path: relative(this.root, full),
      ...(replaced.length > 0
        ? { supersedes: replaced.map((target) => relative(this.root, target)) }
        : {}),
      sync,
    };
  }

  /**
   * Write a Markdown file at `path`, creating its folders, and index it before returning. For the
   * web UI's upload: unlike `remember`, the caller names the file and the text is written as given.
   *
   * @param overwrite replace an existing file; without it, an existing file is refused.
   * @param baseHash for an edit: the `hash` of the version the changes were made to. The file must
   *   still be exactly that, so an edit never silently replaces what an agent or another tab wrote
   *   meanwhile, and it keeps that version's CRLF line endings if it had them.
   * @throws with `status: 400` for a path the indexer would not index (see `resolvePath`), and
   *   `409` for an existing file without `overwrite`, a folder where the file would go, or a file
   *   that is no longer `baseHash` (with `code: "changed"`).
   */
  async writeDocument(path: string, text: string, overwrite = false, baseHash?: string) {
    const { full, relPath } = await resolvePath(this.root, path, {
      create: true,
      markdownOnly: true,
    });
    const existing = await lstat(full).catch(() => undefined);
    if (existing && !existing.isFile()) {
      throw new Refusal(409, `not a file: ${path}`);
    }
    if (existing && !overwrite && baseHash === undefined) {
      throw new Refusal(409, `already exists: ${path}`);
    }
    if (baseHash !== undefined) {
      const current = existing ? await readFile(full) : undefined;
      if (!current || contentHash(current) !== baseHash) {
        const what = current ? "changed on disk" : "deleted";
        throw new Refusal(409, `${path} was ${what} since it was opened`, "changed");
      }
      if (current.includes("\r\n")) text = text.replace(/\r?\n/g, "\r\n");
    }
    if (existing) {
      // Renamed over it, so a sync never reads half a file.
      await writeAtomic(full, text);
    } else {
      try {
        await writeFile(full, text, { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        throw new Refusal(409, `already exists: ${path}`);
      }
    }
    return {
      path: relPath,
      created: !existing,
      hash: contentHash(text),
      sync: await this.rag.sync(false),
    };
  }

  /**
   * An agent's edit (`ragdown_edit`): replace a document's text, or append to it — at the end, or
   * at the end of the section under `heading`. Written through `writeDocument`, so it is atomic and
   * indexed before returning.
   *
   * @param baseHash the `hash` `readDocument` gave. Replacing an existing document requires it, so
   *   an agent never overwrites a version it has not read; an append checks it when given. Either
   *   way the write fails with `code: "changed"` if the file changed after the version edited was
   *   read.
   * @throws with `status: 404` to append to a missing document or under a missing heading.
   */
  async editDocument(
    path: string,
    text: string,
    options: { append?: boolean; heading?: string; baseHash?: string } = {},
  ) {
    if (options.heading !== undefined && !options.append) {
      throw new Refusal(400, "heading is for append: true");
    }
    const { full, relPath } = await resolvePath(this.root, path, {
      create: false,
      markdownOnly: true,
    });
    const current = (await lstat(full).catch(() => undefined))?.isFile()
      ? await readFile(full)
      : undefined;
    if (!options.append) {
      if (current && options.baseHash === undefined) {
        throw new Refusal(
          409,
          `${relPath} exists: pass the hash ragdown_read_doc returned as base_hash to replace it`,
        );
      }
      return this.writeDocument(relPath, text, false, options.baseHash);
    }
    if (!current) throw new Refusal(404, `no such note: ${path}`);
    const hash = contentHash(current);
    if (options.baseHash !== undefined && options.baseHash !== hash) {
      throw new Refusal(409, `${relPath} was changed on disk since it was opened`, "changed");
    }
    const lines = current.toString("utf8").split(/\r?\n/);
    const added = text.trimEnd().split(/\r?\n/);
    let start = 0;
    let end = lines.length;
    if (options.heading) {
      const section = headingRange(lines, options.heading);
      if (!section) {
        throw new Refusal(404, `no heading "${options.heading}" in ${relPath}`);
      }
      start = section.start;
      end = section.end;
    }
    // After the section's last non-blank line, with one blank line on each side.
    let last = end;
    while (last > start && !lines[last - 1]?.trim()) last--;
    const next = [
      ...lines.slice(0, last),
      ...(last > 0 ? [""] : []),
      ...added,
      "",
      ...lines.slice(end),
    ];
    // Hashed from what was read, so a write since then is a conflict rather than lost.
    return this.writeDocument(relPath, next.join("\n"), false, hash);
  }

  /**
   * The documents in this scope, for an agent to browse (`ragdown_list`) rather than search.
   *
   * @param pathPrefix only documents under this folder, relative to the scope.
   * @param tag only documents with this tag or one nested under it, as `recall` filters.
   * @param sort `path`, or `recent` for the most recently changed first.
   */
  async listDocuments(
    options: { pathPrefix?: string; tag?: string; sort?: "path" | "recent"; limit?: number } = {},
  ) {
    const folder = [this.dir, normalizeFolder(options.pathPrefix)].filter(Boolean).join("/");
    const tag = options.tag?.trim().replace(/^#+/, "").replace(/\/+$/, "").toLowerCase();
    const all = await this.rag.documents();
    const by = supersededBy(all);
    const docs = all.filter(
      (doc) =>
        (!folder || doc.path.startsWith(`${folder}/`)) &&
        (!tag || doc.tags.some((t) => t === tag || t.startsWith(`${tag}/`))),
    );
    if (options.sort === "recent") docs.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return {
      total: docs.length,
      notes: docs.slice(0, options.limit ?? docs.length).map((doc) => ({
        path: this.toScoped(doc.path),
        title: doc.title,
        ...(doc.tags.length > 0 ? { tags: doc.tags } : {}),
        ...(doc.aliases.length > 0 ? { aliases: doc.aliases } : {}),
        modified: new Date(doc.mtimeMs).toISOString(),
        ...withSupersededBy(this.replacedBy(by, doc.path)),
      })),
    };
  }

  /**
   * Rename or move a document, or a subfolder with everything in it, within its folder, and rewrite
   * every link in the folder that pointed at what moved — wikilinks, aliases aside, and relative
   * Markdown links — so none of them breaks. The moved documents' own links are rewritten too where
   * the move would break them. Any link that resolved before resolves to the same document after;
   * one that already resolved to nothing is left alone.
   *
   * A rewritten wikilink is the shortest target that still resolves where it should: the name when
   * that is unambiguous, else as much of the path as it takes. Headings and shown text are kept.
   *
   * @throws with `status: 400` for a bad path, moving onto itself or a subfolder into itself, `404`
   *   for nothing at `from`, and `409` when something is already at `to`.
   */
  async move(from: string, to: string) {
    const prefix = this.folder ? `${this.folder}/` : "";
    const moved = await moveInFolder({
      docsDir: this.rag.config.docsDir,
      folder: this.folder,
      root: this.root,
      documents: await this.folderDocuments(),
      from,
      to,
    });
    const scoped = (path: string) => this.toScoped(`${prefix}${path}`);
    return {
      from: scoped(moved.from),
      to: scoped(moved.to),
      updated: moved.updated.map(scoped),
      sync: await this.rag.sync(false),
    };
  }

  /**
   * Delete a Markdown file and drop it from the index before returning.
   *
   * @throws with `status: 400` for a path the indexer would not index, and `404` for no such file.
   */
  async deleteDocument(path: string) {
    const { full, relPath } = await resolvePath(this.root, path, {
      create: false,
      markdownOnly: true,
    });
    if (!(await lstat(full).catch(() => undefined))?.isFile()) {
      throw new Refusal(404, `no such document: ${path}`);
    }
    await unlink(full);
    return { path: relPath, sync: await this.rag.sync(false) };
  }

  /**
   * An agent's delete (`ragdown_delete`): a document as `deleteDocument` does, or a subfolder.
   * Nothing is kept — there is no trash — so a subfolder that holds anything goes only with
   * `recursive`, and then with its documents, its attachments and every file the index skips.
   *
   * @throws with `status: 400` for a bad path, `404` for nothing there, and `409` for a subfolder
   *   that is not empty without `recursive`.
   */
  async remove(path: string, recursive = false) {
    const { full, relPath } = await resolvePath(this.root, path, {
      create: false,
      markdownOnly: false,
    });
    if (!(await lstat(full).catch(() => undefined))?.isDirectory())
      return this.deleteDocument(path);
    const held = (await readdir(full)).length;
    if (held > 0 && !recursive) {
      throw new Refusal(
        409,
        `${relPath} is not empty: pass recursive: true to delete everything in it`,
      );
    }
    if (held > 0) await rm(full, { recursive: true });
    else await rmdir(full);
    return { path: relPath, sync: await this.rag.sync(false) };
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
  if (segments.some((segment) => !isIndexedName(segment))) {
    return undefined;
  }
  const docsDir = await realpath(rag.config.docsDir).catch(() => undefined);
  if (!docsDir) return undefined;
  const normalized = segments.join("/");
  let current = docsDir;
  for (const segment of segments) {
    current = join(current, segment);
    // lstat, not stat: the indexer does not follow symlinks, so a symlinked folder holds no
    // documents.
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

/** `superseded_by` on a document that something replaces, and nothing on one that nothing does. */
function withSupersededBy(paths: string[]): { superseded_by?: string[] } {
  return paths.length > 0 ? { superseded_by: paths } : {};
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
