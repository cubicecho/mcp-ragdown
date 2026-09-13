import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Server } from "node:net";
import { dirname, relative, resolve } from "node:path";
import { type Config, isInside } from "./config.ts";
import { createEmbedder, type Embedder } from "./embedder.ts";
import { errorMessage } from "./errors.ts";
import { formatHit } from "./format.ts";
import { Indexer, type SyncReport } from "./indexer.ts";
import { claimSocket, request } from "./primary.ts";
import { type DocumentInfo, type Hit, Store } from "./store.ts";

/** How often a reader checks whether the primary has gone and it should take over. */
const TAKEOVER_INTERVAL_MS = 30_000;
/** Sessions whose injected chunks are remembered; past this the oldest is forgotten. */
const MAX_SESSIONS = 200;

export interface StartOptions {
  /** Readers only: never claim the socket, never index. For one-off CLI reads. */
  readerOnly?: boolean;
  /**
   * Primary only: start syncing and watching at once (default). `index` turns it off so the report
   * it prints is the sync it asked for, not a no-op queued behind the real one.
   */
  background?: boolean;
}

/**
 * The running server's state: the embedder, the index, and — when this process is the primary —
 * the indexer and the socket. The MCP tools, the hook and the CLI all go through here.
 */
export class Ragdown {
  readonly config: Config;
  readonly embedder: Embedder;
  private store: Store;
  private indexer: Indexer | undefined;
  private socket: Server | undefined;
  private takeover: NodeJS.Timeout | undefined;
  /** Chunk ids already injected into each session, so the hook does not repeat itself. */
  private readonly injected = new Map<string, Set<string>>();

  private constructor(config: Config, embedder: Embedder, store: Store) {
    this.config = config;
    this.embedder = embedder;
    this.store = store;
  }

  get role(): "primary" | "reader" {
    return this.indexer ? "primary" : "reader";
  }

  /**
   * Load the embedder, claim the primary role if it is free, open the index and — as primary —
   * start the first sync and the watcher. Resolves before that first sync finishes.
   */
  static async start(config: Config, options: StartOptions = {}): Promise<Ragdown> {
    const embedder = await createEmbedder(config);
    let socket: Server | undefined;
    let pending: Ragdown | undefined;
    const handler = (req: Record<string, unknown>) => {
      if (!pending) throw new Error("the primary is still starting");
      return pending.handle(req);
    };
    if (!options.readerOnly) socket = await claimSocket(config.socketPath, handler);

    const store = socket
      ? await Store.open(config.dataDir, embedder, true)
      : await openAsReader(config.dataDir, embedder);
    const ragdown = new Ragdown(config, embedder, store);
    pending = ragdown;
    if (store.rebuiltBecause)
      console.error(`[ragdown] rebuilding the index: ${store.rebuiltBecause}`);
    if (socket) ragdown.becomePrimary(socket, options.background ?? true);
    else if (!options.readerOnly) ragdown.watchForTakeover(handler);
    return ragdown;
  }

  /**
   * Search the notes. Never waits for a sync: the first index of a large folder takes minutes, and
   * a partial answer (what is indexed so far) beats a hook that times out.
   *
   * @param pathPrefix limits the search to files under this path, relative to the docs folder.
   */
  async recall(query: string, topK: number, pathPrefix?: string): Promise<Hit[]> {
    return this.store.search(query, topK, pathPrefix);
  }

  /**
   * The context block the hook injects for a prompt, or undefined when nothing is similar enough.
   * Chunks already injected into the same session are left out, so a long conversation about one
   * topic pays for each note once.
   */
  async context(prompt: string, sessionId?: string): Promise<string | undefined> {
    const { topK, minScore, maxChars } = this.config.hook;
    const trimmed = prompt.trim();
    // A slash command or a one-word reply ("yes", "go on") has nothing to retrieve on.
    if (trimmed.length < 12 || trimmed.startsWith("/")) return undefined;

    const seen = sessionId ? this.sessionSeen(sessionId) : new Set<string>();
    const hits = (await this.recall(trimmed, topK * 2))
      .filter((hit) => hit.similarity >= minScore && !seen.has(hit.id))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK);
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
      `<ragdown-context source="${this.config.docsDir}">`,
      "Excerpts from the user's Markdown notes that look related to this prompt, found by search, not chosen by the user.",
      "They may be irrelevant or out of date. Use ragdown_read_doc for the whole file before relying on a fragment.",
      "",
      blocks.join("\n\n"),
      "</ragdown-context>",
    ].join("\n");
  }

  /**
   * Read a file from the docs folder: the source, not the index, so it is current even mid-sync.
   * Never clipped — it is what a clipped hit points at.
   */
  async readDoc(path: string, startLine?: number, endLine?: number) {
    const full = this.resolveDoc(path);
    const lines = (await readFile(full, "utf8")).split(/\r?\n/);
    const start = Math.max(1, startLine ?? 1);
    const end = Math.min(lines.length, endLine ?? lines.length);
    return {
      path: relative(this.config.docsDir, full),
      start_line: start,
      end_line: end,
      total_lines: lines.length,
      text: lines.slice(start - 1, end).join("\n"),
    };
  }

  /** The files the index knows about, with their titles, sorted by path. */
  async documents(): Promise<DocumentInfo[]> {
    return this.store.documents();
  }

  /**
   * Read a file for the web UI: like `readDoc`, but only a file the index holds, so a browser
   * cannot read whatever else happens to sit in the docs folder.
   *
   * @throws with `status: 404` for a path the index does not know.
   */
  async readIndexedDoc(path: string) {
    if (!(await this.store.files()).has(path)) {
      throw Object.assign(new Error(`not an indexed document: ${path}`), { status: 404 });
    }
    return this.readDoc(path);
  }

  /**
   * Write a new note under the notes folder and index it before returning.
   *
   * @param name file name without extension; defaults to the date and a slug of the title. An
   *   existing file is never overwritten: a numeric suffix is added instead.
   */
  async remember(title: string, content: string, tags: string[] = [], name?: string) {
    const date = new Date().toISOString().slice(0, 10);
    const base = name ?? `${date}-${slug(title)}`;
    const front = [
      "---",
      `title: ${JSON.stringify(title)}`,
      `date: ${date}`,
      ...(tags.length > 0 ? [`tags: [${tags.map((t) => JSON.stringify(t)).join(", ")}]`] : []),
      "---",
      "",
    ].join("\n");
    const body = `${front}${content.trimEnd()}\n`;

    let full = "";
    for (let n = 1; ; n++) {
      full = resolve(this.config.notesDir, `${base}${n === 1 ? "" : `-${n}`}.md`);
      if (!isInside(this.config.notesDir, full)) {
        throw new Error(`note name escapes the notes folder: ${base}`);
      }
      await mkdir(dirname(full), { recursive: true });
      try {
        await writeFile(full, body, { flag: "wx" });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const sync = await this.sync(false);
    return { path: relative(this.config.docsDir, full), sync };
  }

  /** Sync (or with `full`, rebuild) the index — here when primary, on the primary otherwise. */
  async sync(full: boolean): Promise<SyncReport> {
    if (this.indexer) return full ? this.indexer.rebuild() : this.indexer.sync();
    // A full rebuild of a large folder takes minutes; the timeout is for a primary that hangs.
    return (await request(this.config.socketPath, { op: "sync", full }, 30 * 60_000)) as SyncReport;
  }

  async stats(includeFiles: boolean) {
    const files = await this.store.files();
    return {
      docs_dir: this.config.docsDir,
      data_dir: this.config.dataDir,
      role: this.role,
      embedder: this.embedder.name,
      read_only: this.config.readOnly,
      files: files.size,
      chunks: await this.store.count(),
      syncing: this.indexer?.syncing ?? null,
      last_sync: this.indexer?.lastSync ?? null,
      ...(includeFiles
        ? {
            file_list: [...files]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([path, state]) => ({ path, chunks: state.chunks })),
          }
        : {}),
    };
  }

  async close(): Promise<void> {
    clearInterval(this.takeover);
    this.indexer?.close();
    await new Promise<void>((done) => (this.socket ? this.socket.close(() => done()) : done()));
  }

  private async handle(req: Record<string, unknown>): Promise<unknown> {
    switch (req.op) {
      case "context":
        return {
          context:
            (await this.context(String(req.prompt ?? ""), stringOrUndefined(req.session_id))) ??
            null,
        };
      case "sync":
        return this.sync(req.full === true);
      default:
        throw new Error(`unknown op: ${String(req.op)}`);
    }
  }

  private becomePrimary(socket: Server, background = true): void {
    this.socket = socket;
    this.indexer = new Indexer(this.config.docsDir, this.store, this.embedder);
    if (background) {
      void this.indexer.sync().catch((error: unknown) => {
        console.error(`[ragdown] first sync failed: ${errorMessage(error)}`);
      });
      if (this.config.watch) this.indexer.watch();
    }
    console.error(`[ragdown] primary for ${this.config.docsDir} (index: ${this.config.dataDir})`);
  }

  private watchForTakeover(handler: (req: Record<string, unknown>) => Promise<unknown>): void {
    this.takeover = setInterval(() => {
      void (async () => {
        const socket = await claimSocket(this.config.socketPath, handler);
        if (!socket) return;
        clearInterval(this.takeover);
        // Reopened writable, so a meta mismatch the old primary left behind is repaired here.
        this.store = await Store.open(this.config.dataDir, this.embedder, true);
        this.becomePrimary(socket);
      })().catch((error: unknown) => {
        console.error(`[ragdown] takeover failed: ${errorMessage(error)}`);
      });
    }, TAKEOVER_INTERVAL_MS);
    this.takeover.unref();
  }

  private sessionSeen(sessionId: string): Set<string> {
    let seen = this.injected.get(sessionId);
    if (seen) {
      // Re-insert so Map order is least-recently-used first.
      this.injected.delete(sessionId);
    } else {
      seen = new Set();
      if (this.injected.size >= MAX_SESSIONS) {
        const oldest = this.injected.keys().next().value;
        if (oldest !== undefined) this.injected.delete(oldest);
      }
    }
    this.injected.set(sessionId, seen);
    return seen;
  }

  private resolveDoc(path: string): string {
    const full = resolve(this.config.docsDir, path);
    if (!isInside(this.config.docsDir, full)) {
      throw new Error(`path is outside the docs folder: ${path}`);
    }
    return full;
  }
}

/**
 * A reader that starts in the same instant as a new primary can find no index yet; give the
 * primary a few seconds to create it before calling the index missing.
 */
async function openAsReader(dataDir: string, embedder: Embedder): Promise<Store> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await Store.open(dataDir, embedder, false);
    } catch (error) {
      if (attempt >= 20) throw error;
      await new Promise((done) => setTimeout(done, 500));
    }
  }
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

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}
