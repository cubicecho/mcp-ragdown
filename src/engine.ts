import type { Server } from "node:net";
import type { Config } from "./config.ts";
import { createEmbedder, type Embedder } from "./embedder.ts";
import { errorMessage } from "./errors.ts";
import { Indexer, type SyncReport } from "./indexer.ts";
import { claimSocket, request } from "./primary.ts";
import { SessionMemory } from "./scope.ts";
import { type DocumentInfo, type FileState, type Hit, Store } from "./store.ts";

/** How often a reader checks whether the primary has gone and it should take over. */
const TAKEOVER_INTERVAL_MS = 30_000;
/**
 * The running server's state: the embedder, the index, and — when this process is the primary —
 * the indexer and the socket. The tools and routes reach it through a `Scope` (`scope.ts`), which
 * narrows it to one folder.
 */
export class Ragdown {
  readonly config: Config;
  readonly embedder: Embedder;
  private store: Store;
  private indexer: Indexer | undefined;
  private socket: Server | undefined;
  private takeover: NodeJS.Timeout | undefined;
  /** Chunk ids already returned by `ragdown_context` for each session, so a hook does not repeat itself. */
  readonly sessions = new SessionMemory();

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
  static async start(config: Config): Promise<Ragdown> {
    const embedder = await createEmbedder(config);
    let pending: Ragdown | undefined;
    const handler = (req: Record<string, unknown>) => {
      if (!pending) throw new Error("the primary is still starting");
      return pending.handle(req);
    };
    const socket = await claimSocket(config.socketPath, handler);

    const store = socket
      ? await Store.open(config.dataDir, embedder, true)
      : await openAsReader(config.dataDir, embedder);
    const ragdown = new Ragdown(config, embedder, store);
    pending = ragdown;
    if (store.rebuiltBecause)
      console.error(`[ragdown] rebuilding the index: ${store.rebuiltBecause}`);
    if (socket) ragdown.becomePrimary(socket);
    else ragdown.watchForTakeover(handler);
    return ragdown;
  }

  /**
   * Search the notes. Never waits for a sync: the first index of a large folder takes minutes, and
   * a partial answer (what is indexed so far) beats a hook that times out.
   *
   * @param pathPrefix limits the search to paths starting with this, relative to the docs folder.
   */
  async recall(query: string, topK: number, pathPrefix?: string): Promise<Hit[]> {
    return this.store.search(query, topK, pathPrefix);
  }

  /** The files the index knows about, with their titles, sorted by path. */
  async documents(): Promise<DocumentInfo[]> {
    return this.store.documents();
  }

  /** Every indexed file's path, relative to the docs folder, and its state. */
  async files(): Promise<Map<string, FileState>> {
    return this.store.files();
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
      case "sync":
        return this.sync(req.full === true);
      default:
        throw new Error(`unknown op: ${String(req.op)}`);
    }
  }

  private becomePrimary(socket: Server): void {
    this.socket = socket;
    this.indexer = new Indexer(this.config.docsDir, this.store, this.embedder);
    void this.indexer.sync().catch((error: unknown) => {
      console.error(`[ragdown] first sync failed: ${errorMessage(error)}`);
    });
    if (this.config.watch) this.indexer.watch();
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
