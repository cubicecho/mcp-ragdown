import { createHash } from "node:crypto";
import { type Dirent, type FSWatcher, watch } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { chunkMarkdown, embeddingText, readSupersedes } from "./chunk.ts";
import type { Embedder } from "./embedder.ts";
import { errorMessage } from "./errors.ts";
import type { FileUpdate, Store } from "./store.ts";

const MARKDOWN = /\.(md|markdown|mdx)$/i;
/** An editor save is a burst of events (temp file, rename, chmod); one sync per burst. */
const WATCH_DEBOUNCE_MS = 750;
/** Chunks per embed-and-write round: a crash loses at most this much work, and progress is visible. */
const BATCH_CHUNKS = 256;
/** When the OS will not watch (inotify limits, network mounts), rescan on this interval instead. */
const POLL_FALLBACK_MS = 60_000;

export interface SyncReport {
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  chunks: number;
  ms: number;
}

/**
 * Keeps the index equal to the folder. Only the primary process holds one.
 *
 * A sync is a diff, not a rebuild: size and mtime decide which files to read, the content hash
 * decides which to re-embed, and files gone from disk are dropped. Syncs never overlap; a change
 * that arrives mid-sync schedules one more.
 */
export class Indexer {
  readonly docsDir: string;
  lastSync: (SyncReport & { at: string }) | undefined;
  private readonly store: Store;
  private readonly embedder: Embedder;
  private running: Promise<SyncReport> | undefined;
  private queued: Promise<SyncReport> | undefined;
  private watcher: FSWatcher | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(docsDir: string, store: Store, embedder: Embedder) {
    this.docsDir = docsDir;
    this.store = store;
    this.embedder = embedder;
  }

  /** True while a sync is running; searches meanwhile see the files indexed so far. */
  get syncing(): boolean {
    return this.running !== undefined;
  }

  /**
   * Sync now, or, when a sync is already running, run exactly one more after it — the caller asked
   * because something changed, and the running sync may have listed the folder before it did.
   * Any number of callers during one sync share that one follow-up.
   */
  sync(): Promise<SyncReport> {
    if (this.queued) return this.queued;
    if (this.running) {
      this.queued = this.running
        .catch(() => undefined)
        .then(() => {
          this.queued = undefined;
          return this.sync();
        });
      return this.queued;
    }
    this.running = this.run().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** Drop every chunk and index the folder from scratch. */
  async rebuild(): Promise<SyncReport> {
    await this.running?.catch(() => undefined);
    await this.store.apply([], [...(await this.store.files()).keys()]);
    return this.sync();
  }

  /** Watch the folder recursively and sync after each burst of changes. */
  watch(): void {
    const schedule = () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.sync().catch(logFailure), WATCH_DEBOUNCE_MS);
    };
    try {
      this.watcher = watch(this.docsDir, { recursive: true, persistent: false }, (_event, name) => {
        // `.git/index` and editor swap files change on every save and are never indexed.
        if (name?.split(/[/\\]/).some((part) => part.startsWith("."))) return;
        // A directory rename reports the directory, which has no extension; sync for those too.
        if (!name || MARKDOWN.test(name) || !/\.[^/\\]+$/.test(name)) schedule();
      });
      this.watcher.on("error", (error) => {
        console.error(`[indexer] watch failed, polling every 60 s: ${errorMessage(error)}`);
        this.watcher?.close();
        this.poll();
      });
    } catch (error) {
      console.error(
        `[indexer] cannot watch ${this.docsDir}, polling every 60 s: ${errorMessage(error)}`,
      );
      this.poll();
    }
  }

  close(): void {
    this.watcher?.close();
    clearTimeout(this.timer);
    clearInterval(this.timer);
  }

  private poll(): void {
    this.timer = setInterval(() => void this.sync().catch(logFailure), POLL_FALLBACK_MS);
    this.timer.unref();
  }

  private async run(): Promise<SyncReport> {
    const started = performance.now();
    const onDisk = await listMarkdown(this.docsDir);
    const indexed = await this.store.files();
    const report: SyncReport = { added: 0, updated: 0, removed: 0, unchanged: 0, chunks: 0, ms: 0 };

    const removed = [...indexed.keys()].filter((path) => !onDisk.has(path));
    report.removed = removed.length;

    let batch: FileUpdate[] = [];
    let batchChunks = 0;
    const flush = async () => {
      const texts = batch.flatMap((u) => u.chunks.map(embeddingText));
      const vectors = await this.embedder.embed(texts, "document");
      let offset = 0;
      for (const update of batch) {
        update.vectors = vectors.slice(offset, offset + update.chunks.length);
        offset += update.chunks.length;
      }
      await this.store.apply(batch, removed.splice(0));
      batch = [];
      batchChunks = 0;
    };

    for (const [path, { mtimeMs, size }] of onDisk) {
      const known = indexed.get(path);
      if (known && known.mtimeMs === mtimeMs && known.size === size) {
        report.unchanged++;
        continue;
      }
      let source: string;
      try {
        source = await readFile(join(this.docsDir, path), "utf8");
      } catch (error) {
        // Deleted between the listing and the read; the next sync will see it gone.
        console.error(`[indexer] skipped ${path}: ${errorMessage(error)}`);
        continue;
      }
      const hash = createHash("sha256").update(source).digest("hex");
      if (known?.hash === hash) {
        report.unchanged++;
        continue;
      }
      const chunks = chunkMarkdown(source, path);
      if (known) report.updated++;
      else report.added++;
      report.chunks += chunks.length;
      batch.push({
        path,
        hash,
        mtimeMs,
        size,
        chunks,
        vectors: [],
        supersedes: readSupersedes(source, path),
      });
      batchChunks += chunks.length;
      if (batchChunks >= BATCH_CHUNKS) await flush();
    }
    if (batch.length > 0 || removed.length > 0) await flush();

    if (report.added + report.updated + report.removed > 0) await this.store.compact();
    report.ms = Math.round(performance.now() - started);
    this.lastSync = { ...report, at: new Date().toISOString() };
    if (report.added + report.updated + report.removed > 0) {
      console.error(
        `[indexer] +${report.added} ~${report.updated} -${report.removed} files, ${report.chunks} chunks embedded in ${report.ms} ms`,
      );
    }
    return report;
  }
}

/**
 * Every Markdown file under `root`, keyed by its `/`-separated relative path. Dot-directories and
 * `node_modules` are skipped, and symlinks are not followed, so a link cycle cannot hang a sync.
 */
export async function listMarkdown(
  root: string,
): Promise<Map<string, { mtimeMs: number; size: number }>> {
  const files = new Map<string, { mtimeMs: number; size: number }>();
  const walk = async (dir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      console.error(`[indexer] skipped ${dir}: ${errorMessage(error)}`);
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && MARKDOWN.test(entry.name)) {
        try {
          const info = await stat(full);
          const path = relative(root, full).split(sep).join("/");
          files.set(path, { mtimeMs: info.mtimeMs, size: info.size });
        } catch (error) {
          console.error(`[indexer] skipped ${full}: ${errorMessage(error)}`);
        }
      }
    }
  };
  await walk(root);
  return files;
}

function logFailure(error: unknown): void {
  console.error(`[indexer] sync failed: ${errorMessage(error)}`);
}
