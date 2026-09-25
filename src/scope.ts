import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { isInside } from "./config.ts";
import type { Ragdown } from "./engine.ts";
import { formatHit } from "./format.ts";
import { MARKDOWN } from "./indexer.ts";
import {
  findLinks,
  type LinkNote,
  type LinkRef,
  type ResolvedLink,
  resolveLink,
  resolveRef,
} from "./links.ts";
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
 * The notes as one endpoint sees them, as if its directory were the root: a folder (`/mcp/work`),
 * a subfolder inside one (`/mcp/work/projects/foo`), the whole docs dir in single mode (`stdio`),
 * or — for the web UI only — every folder at once. Every path going in is relative to the scope and
 * every path coming out is made relative to it, so an agent on a scope cannot tell there is
 * anything above it. It is not a security boundary between endpoints that share a token; whether a
 * folder has an endpoint at all is decided in `http.ts`.
 */
export class Scope {
  readonly rag: Ragdown;
  /** The directory relative to the docs root, with `/` separators; empty for the root. */
  readonly dir: string;
  /** The directory's absolute path. */
  readonly root: string;
  /**
   * The folder the scope is in, relative to the docs root: its first segment in folders mode, and
   * empty — the docs dir is the folder — in single mode or at the root. Wikilinks resolve within it.
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
   * Search the notes in this scope. Never waits for a sync: a partial answer (what is indexed so
   * far) beats a hook that times out.
   *
   * @param pathPrefix limits the search to files under this folder, relative to the scope.
   * @param tag limits it to notes with this tag or one nested under it.
   */
  async recall(query: string, topK: number, pathPrefix?: string, tag?: string): Promise<Hit[]> {
    const folder = [this.dir, normalizeFolder(pathPrefix)].filter(Boolean).join("/");
    const hits = await this.rag.recall(query, topK, folder ? `${folder}/` : undefined, tag);
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
   *
   * A path that names no file is tried as a wikilink target (`Note`, `Note#Heading`, `sub/Note`);
   * a heading narrows the text to that section unless a line range is given.
   */
  async readDoc(path: string, startLine?: number, endLine?: number) {
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
    };
  }

  /**
   * Resolve a wikilink target within the scope's folder, Obsidian-style (`links.ts`). A target the
   * folder has but this scope does not (a subfolder endpoint linking above itself) is not found.
   *
   * @param from the linking note, relative to the scope; decides ties and relative links.
   * @returns the path relative to the scope: a note, or with `attachments`, any file.
   */
  async resolveLink(
    raw: string,
    from?: string,
    attachments = false,
  ): Promise<ResolvedLink | undefined> {
    const prefix = this.folder ? `${this.folder}/` : "";
    const notes = await this.folderNotes();
    const others = attachments
      ? await listAttachments(resolve(this.rag.config.docsDir, this.folder))
      : [];
    const fromInFolder = from
      ? [this.dir.slice(prefix.length), from].filter(Boolean).join("/").replace(/^\//, "")
      : undefined;
    const link = resolveLink(raw, fromInFolder, notes, others);
    if (!link) return undefined;
    const rootPath = `${prefix}${link.path}`;
    if (this.dir && !rootPath.startsWith(`${this.dir}/`)) return undefined;
    return { ...link, path: this.toScoped(rootPath) };
  }

  /**
   * The notes in this scope that link to `path` — by wikilink, alias, or relative Markdown link — each
   * with the lines the links are on. Read from disk, so current even mid-sync. A note's links to
   * itself are left out.
   *
   * @throws with `status: 404` for a path the index does not know.
   */
  async backlinks(path: string) {
    const prefix = this.folder ? `${this.folder}/` : "";
    const docs = await this.rag.documents();
    const rootPath = toPosix(relative(this.rag.config.docsDir, resolve(this.root, path)));
    if (!docs.some((doc) => doc.path === rootPath)) {
      throw Object.assign(new Error(`not an indexed document: ${path}`), { status: 404 });
    }
    const target = rootPath.slice(prefix.length);
    const notes = await this.folderNotes();
    const sources = docs.filter(
      (doc) => doc.path !== rootPath && (!this.dir || doc.path.startsWith(`${this.dir}/`)),
    );
    const backlinks: { path: string; title: string; lines: { line: number; text: string }[] }[] =
      [];
    for (const doc of sources) {
      const text = await readFile(resolve(this.rag.config.docsDir, doc.path), "utf8").catch(
        () => undefined,
      );
      // A cheap test first: most notes link to nothing at all.
      if (!text || (!text.includes("[[") && !text.includes("]("))) continue;
      const from = doc.path.slice(prefix.length);
      const lines = new Set<number>();
      for (const ref of findLinks(text)) {
        if (resolveRef(ref, from, notes) === target) lines.add(ref.line);
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

  /** Every note in the scope's folder — not only the scope — relative to the folder, for links. */
  private async folderNotes(): Promise<LinkNote[]> {
    const prefix = this.folder ? `${this.folder}/` : "";
    return (await this.rag.documents())
      .filter((doc) => doc.path.startsWith(prefix))
      .map((doc) => ({ path: doc.path.slice(prefix.length), aliases: doc.aliases }));
  }

  /**
   * A file inside the scope for the web UI to download — a note or an attachment. Refused like a
   * write (`resolvePath`): nothing under a dot-folder, and no symlink anywhere on the path.
   *
   * @throws with `status: 400` for such a path and `404` for no such file.
   */
  async fileFor(path: string): Promise<string> {
    const { full } = await this.resolvePath(path, { create: false, markdownOnly: false });
    if (!(await lstat(full).catch(() => undefined))?.isFile()) {
      throw Object.assign(new Error(`no such file: ${path}`), { status: 404 });
    }
    return full;
  }

  /**
   * Read a file for the web UI: like `readDoc`, but only a file the index holds, so a browser
   * cannot read whatever else happens to sit in the docs folder.
   *
   * @throws with `status: 404` for a path the index does not know.
   */
  async readIndexedDoc(path: string) {
    const full = resolve(this.root, path);
    const rootPath = toPosix(relative(this.rag.config.docsDir, full));
    const doc = (await this.rag.documents()).find((d) => d.path === rootPath);
    if (!doc) {
      throw Object.assign(new Error(`not an indexed document: ${path}`), { status: 404 });
    }
    return { ...(await this.readDoc(path)), tags: doc.tags, aliases: doc.aliases };
  }

  /**
   * Write a new note and index it before returning. At a folder's root it goes under
   * `RAGDOWN_NOTES_DIR`; in a subfolder, in the subfolder itself, which is already where that
   * project's notes live.
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

  /**
   * Write a Markdown file at `path`, creating its folders, and index it before returning. For the
   * web UI's upload: unlike `remember`, the caller names the file and the text is written as given.
   *
   * @param overwrite replace an existing file; without it, an existing file is refused.
   * @param baseHash for an edit: the `hash` of the version the changes were made to. The file must
   *   still be exactly that, so an edit never silently replaces what an agent or another tab wrote
   *   meanwhile, and it keeps that version's CRLF line endings if it had them.
   * @throws with `status: 400` for a path the indexer would not index (see `resolveWritable`), and
   *   `409` for an existing file without `overwrite`, a folder where the file would go, or a file
   *   that is no longer `baseHash` (with `code: "changed"`).
   */
  async writeDoc(path: string, text: string, overwrite = false, baseHash?: string) {
    const { full, relPath } = await this.resolvePath(path, { create: true, markdownOnly: true });
    const existing = await lstat(full).catch(() => undefined);
    if (existing && !existing.isFile()) {
      throw Object.assign(new Error(`not a file: ${path}`), { status: 409 });
    }
    if (existing && !overwrite && baseHash === undefined) {
      throw Object.assign(new Error(`already exists: ${path}`), { status: 409 });
    }
    if (baseHash !== undefined) {
      const current = existing ? await readFile(full) : undefined;
      if (!current || contentHash(current) !== baseHash) {
        const what = current ? "changed on disk" : "deleted";
        throw Object.assign(new Error(`${path} was ${what} since it was opened`), {
          status: 409,
          code: "changed",
        });
      }
      if (current.includes("\r\n")) text = text.replace(/\r?\n/g, "\r\n");
    }
    if (existing) {
      // Written beside it and renamed over it: a sync never reads half a file. The dot name keeps
      // the indexer and the watcher off the temp file.
      const temp = join(dirname(full), `.${randomUUID()}.tmp`);
      try {
        await writeFile(temp, text);
        await rename(temp, full);
      } catch (error) {
        await rm(temp, { force: true });
        throw error;
      }
    } else {
      try {
        await writeFile(full, text, { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        throw Object.assign(new Error(`already exists: ${path}`), { status: 409 });
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
   * An agent's edit (`ragdown_edit`): replace a note's text, or append to it — at the end, or at the
   * end of the section under `heading`. Written through `writeDoc`, so it is atomic and indexed
   * before returning.
   *
   * @param baseHash the `hash` `readDoc` gave. Replacing an existing note requires it, so an agent
   *   never overwrites a version it has not read; an append checks it when given. Either way the
   *   write fails with `code: "changed"` if the file changed after the version edited was read.
   * @throws with `status: 404` to append to a missing note or under a missing heading.
   */
  async editDoc(
    path: string,
    text: string,
    options: { append?: boolean; heading?: string; baseHash?: string } = {},
  ) {
    if (options.heading !== undefined && !options.append) {
      throw Object.assign(new Error("heading is for append: true"), { status: 400 });
    }
    const { full, relPath } = await this.resolvePath(path, { create: false, markdownOnly: true });
    const current = (await lstat(full).catch(() => undefined))?.isFile()
      ? await readFile(full)
      : undefined;
    if (!options.append) {
      if (current && options.baseHash === undefined) {
        throw Object.assign(
          new Error(
            `${relPath} exists: pass the hash ragdown_read_doc returned as base_hash to replace it`,
          ),
          { status: 409 },
        );
      }
      return this.writeDoc(relPath, text, false, options.baseHash);
    }
    if (!current) throw Object.assign(new Error(`no such note: ${path}`), { status: 404 });
    const hash = contentHash(current);
    if (options.baseHash !== undefined && options.baseHash !== hash) {
      throw Object.assign(new Error(`${relPath} was changed on disk since it was opened`), {
        status: 409,
        code: "changed",
      });
    }
    const lines = current.toString("utf8").split(/\r?\n/);
    const added = text.trimEnd().split(/\r?\n/);
    let start = 0;
    let end = lines.length;
    if (options.heading) {
      const section = headingRange(lines, options.heading);
      if (!section) {
        throw Object.assign(new Error(`no heading "${options.heading}" in ${relPath}`), {
          status: 404,
        });
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
    return this.writeDoc(relPath, next.join("\n"), false, hash);
  }

  /**
   * The notes in this scope, for an agent to browse (`ragdown_list`) rather than search.
   *
   * @param pathPrefix only notes under this folder, relative to the scope.
   * @param tag only notes with this tag or one nested under it, as `recall` filters.
   * @param sort `path`, or `recent` for the most recently changed first.
   */
  async listDocs(
    options: { pathPrefix?: string; tag?: string; sort?: "path" | "recent"; limit?: number } = {},
  ) {
    const folder = [this.dir, normalizeFolder(options.pathPrefix)].filter(Boolean).join("/");
    const tag = options.tag?.trim().replace(/^#+/, "").replace(/\/+$/, "").toLowerCase();
    const docs = (await this.rag.documents()).filter(
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
      })),
    };
  }

  /**
   * Rename or move a note within its folder, and rewrite every link in the folder that pointed at
   * it — wikilinks, aliases aside, and relative Markdown links — so none of them breaks. The note's
   * own links are rewritten too where the move would break them. Any link that resolved before
   * resolves to the same note after; one that already resolved to nothing is left alone.
   *
   * A rewritten wikilink is the shortest target that still resolves where it should: the name when
   * that is unambiguous, else as much of the path as it takes. Headings and shown text are kept.
   *
   * @throws with `status: 400` for a bad path or moving onto itself, `404` for no such note, and
   *   `409` when something is already at `to`.
   */
  async moveDoc(from: string, to: string) {
    const source = await this.resolvePath(from, { create: false, markdownOnly: true });
    const dest = await this.resolvePath(to, { create: false, markdownOnly: true });
    const info = await lstat(source.full).catch(() => undefined);
    if (!info?.isFile()) {
      throw Object.assign(new Error(`no such note: ${from}`), { status: 404 });
    }
    if (source.full === dest.full) {
      throw Object.assign(new Error(`${from} is already there`), { status: 400 });
    }
    // A case-only rename on a case-insensitive disk finds the note itself at `to`: that is fine.
    const occupied = await lstat(dest.full).catch(() => undefined);
    if (occupied && (occupied.ino !== info.ino || occupied.dev !== info.dev)) {
      throw Object.assign(new Error(`already exists: ${to}`), { status: 409 });
    }

    const docsDir = this.rag.config.docsDir;
    const prefix = this.folder ? `${this.folder}/` : "";
    const inFolder = (full: string) => toPosix(relative(docsDir, full)).slice(prefix.length);
    const oldPath = inFolder(source.full);
    const newPath = inFolder(dest.full);
    const before = await this.folderNotes();
    if (!before.some((note) => note.path === oldPath)) {
      before.push({ path: oldPath, aliases: [] });
    }
    const after = before.map((note) => (note.path === oldPath ? { ...note, path: newPath } : note));
    const attachments = await listAttachments(resolve(docsDir, this.folder));

    // Every note's new text, read and rewritten before anything is written.
    const rewrites = new Map<string, { original: string; text: string }>();
    for (const note of before) {
      const full = resolve(docsDir, `${prefix}${note.path}`);
      const original = await readFile(full, "utf8").catch(() => undefined);
      if (original === undefined) continue;
      const from = note.path;
      const at = from === oldPath ? newPath : from;
      const edits: { start: number; end: number; text: string }[] = [];
      for (const ref of findLinks(original)) {
        const was = resolveRef(ref, from, before, attachments);
        if (!was) continue;
        const want = was === oldPath ? newPath : was;
        if (resolveRef(ref, at, after, attachments) === want) continue;
        edits.push({
          start: ref.targetStart,
          end: ref.targetEnd,
          text: linkTarget(ref, want, at, after, attachments),
        });
      }
      let text = original;
      for (const edit of edits.reverse()) {
        text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
      }
      if (text !== original || from === oldPath) rewrites.set(from, { original, text });
    }

    const moved = rewrites.get(oldPath);
    if (!moved) throw Object.assign(new Error(`no such note: ${from}`), { status: 404 });
    await mkdir(dirname(dest.full), { recursive: true });
    if (occupied) {
      await rename(source.full, dest.full);
      if (moved.text !== moved.original) await writeFile(dest.full, moved.text);
    } else {
      try {
        await writeFile(dest.full, moved.text, { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        throw Object.assign(new Error(`already exists: ${to}`), { status: 409 });
      }
      await unlink(source.full);
    }

    const updated: string[] = [];
    for (const [path, { original, text }] of rewrites) {
      if (path === oldPath) continue;
      const full = resolve(docsDir, `${prefix}${path}`);
      // Changed since it was read, by an editor or an agent: theirs wins, and this link is not fixed.
      if ((await readFile(full, "utf8").catch(() => undefined)) !== original) continue;
      const temp = join(dirname(full), `.${randomUUID()}.tmp`);
      try {
        await writeFile(temp, text);
        await rename(temp, full);
      } catch (error) {
        await rm(temp, { force: true });
        throw error;
      }
      updated.push(path);
    }
    const scoped = (path: string) => this.toScoped(`${prefix}${path}`);
    return {
      from: scoped(oldPath),
      to: scoped(newPath),
      updated: updated.map(scoped),
      sync: await this.rag.sync(false),
    };
  }

  /**
   * Delete a Markdown file and drop it from the index before returning.
   *
   * @throws with `status: 400` for a path the indexer would not index, and `404` for no such file.
   */
  async deleteDoc(path: string) {
    const { full, relPath } = await this.resolvePath(path, { create: false, markdownOnly: true });
    if (!(await lstat(full).catch(() => undefined))?.isFile()) {
      throw Object.assign(new Error(`no such document: ${path}`), { status: 404 });
    }
    await unlink(full);
    return { path: relPath, sync: await this.rag.sync(false) };
  }

  /**
   * Resolve a path a client wants to write, delete or download, relative to the scope. Refused with
   * a 400 unless the indexer would walk to it: no dot-segment or `node_modules`, inside the folder,
   * and no symlink or file on the way — the indexer does not follow symlinks, and a write through
   * one could land outside the docs. Resolved against the folder's real path, as `openScope` does.
   *
   * @param create make the missing folders on the way.
   * @param markdownOnly also require a Markdown extension, as for anything that is written.
   */
  private async resolvePath(
    path: string,
    { create, markdownOnly }: { create: boolean; markdownOnly: boolean },
  ) {
    const invalid = (why: string) => Object.assign(new Error(`${why}: ${path}`), { status: 400 });
    const posixPath = path.replaceAll("\\", "/");
    if (!posixPath || posix.isAbsolute(posixPath) || /^[a-z]:/i.test(posixPath)) {
      throw invalid("path must be relative to the docs folder");
    }
    const segments = posix
      .normalize(posixPath)
      .split("/")
      .filter((segment) => segment && segment !== ".");
    if (segments.length === 0 || segments.includes("..")) {
      throw invalid("path is outside the docs folder");
    }
    if (segments.some((s) => s.startsWith(".") || s === "node_modules" || s.includes("\0"))) {
      throw invalid("path names a folder or file the index skips");
    }
    if (markdownOnly && !MARKDOWN.test(segments.at(-1) ?? "")) {
      throw invalid("only Markdown files (.md, .markdown, .mdx) can be written");
    }

    const root = await realpath(this.root);
    let current = root;
    for (const segment of segments.slice(0, -1)) {
      current = join(current, segment);
      let info = await lstat(current).catch(() => undefined);
      if (!info && create) {
        await mkdir(current).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
        info = await lstat(current);
      }
      if (!info) break;
      if (!info.isDirectory()) throw invalid("a folder on the path is a file or a symlink");
    }
    const full = join(root, ...segments);
    if (!isInside(root, full)) throw invalid("path is outside the docs folder");
    return { full, relPath: segments.join("/") };
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

/**
 * The lines of the section under a heading, 1-based and inclusive: from the heading to the line
 * before the next heading at its level or above. `A#B` names `B` under `A`; only the last part is
 * matched. Undefined when no heading matches, and the caller reads the whole note.
 */
function headingRange(lines: string[], anchor: string): { start: number; end: number } | undefined {
  const wanted = (anchor.split("#").at(-1) ?? "").trim().toLowerCase();
  let fence: string | null = null;
  let start: number | undefined;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch?.[1]) {
      const marker = fenceMatch[1];
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!heading?.[1] || !heading[2]) continue;
    if (start === undefined) {
      if (heading[2].trim().toLowerCase() === wanted) {
        start = i + 1;
        level = heading[1].length;
      }
    } else if (heading[1].length <= level) {
      return { start, end: i };
    }
  }
  return start === undefined ? undefined : { start, end: lines.length };
}

/**
 * What to write in place of a link's target so it points at `want` from the note at `from`. A
 * Markdown link gets the relative path; a wikilink, the shortest trailing part of the path that
 * resolves there, keeping `.md` if the link had it.
 */
function linkTarget(
  ref: LinkRef,
  want: string,
  from: string,
  notes: LinkNote[],
  attachments: string[],
): string {
  if (ref.kind === "markdown") {
    return encodeURI(posix.relative(posix.dirname(from), want))
      .replaceAll("(", "%28")
      .replaceAll(")", "%29");
  }
  const note = MARKDOWN.test(want);
  const keepExtension = note && MARKDOWN.test(ref.target);
  const bare = note && !keepExtension ? want.replace(MARKDOWN, "") : want;
  const segments = bare.split("/");
  for (let k = 1; k <= segments.length; k++) {
    const candidate = segments.slice(-k).join("/");
    if (resolveLink(candidate, from, notes, attachments)?.path === want) return candidate;
  }
  return bare;
}

/**
 * Every file under `root` a wikilink may embed that is not a note: images, PDFs and the like, by
 * `/`-separated relative path. Skips what the indexer skips.
 */
async function listAttachments(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [] as Dirent[]);
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && !MARKDOWN.test(entry.name))
        out.push(toPosix(relative(root, full)));
    }
  };
  await walk(root);
  return out;
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

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
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

/** What `readIndexedDoc` calls a file's `hash`, and `writeDoc` checks a `baseHash` against. */
export const contentHash = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
