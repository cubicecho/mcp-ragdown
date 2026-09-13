import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { Field, FixedSizeList, Float32, Float64, Int32, Schema, Utf8 } from "apache-arrow";
import { CHUNKER_VERSION, type Chunk } from "./chunk.ts";
import type { Embedder } from "./embedder.ts";
import { errorMessage } from "./errors.ts";

const TABLE = "chunks";
/** Reciprocal-rank-fusion constant; 60 is the value from the original RRF paper and rarely worth tuning. */
const RRF_K = 60;

/** What the index remembers about a file, to decide on the next sync whether it changed. */
export interface FileState {
  hash: string;
  mtimeMs: number;
  size: number;
  chunks: number;
}

export interface FileUpdate {
  path: string;
  hash: string;
  mtimeMs: number;
  size: number;
  chunks: Chunk[];
  vectors: Float32Array[];
}

export interface Hit {
  id: string;
  path: string;
  title: string;
  heading: string;
  text: string;
  lineStart: number;
  lineEnd: number;
  /** Fused rank score; only meaningful for ordering. */
  score: number;
  /** Cosine similarity of the query and the chunk, 0–1 for related text; comparable across queries. */
  similarity: number;
  /** Which retrievers nominated the chunk. */
  sources: ("dense" | "lexical")[];
}

interface Meta {
  embedder: string;
  dim: number;
  chunker_version: number;
}

interface Row {
  id: string;
  path: string;
  file_hash: string;
  mtime_ms: number;
  size: number;
  chunk_index: number;
  title: string;
  heading: string;
  text: string;
  line_start: number;
  line_end: number;
  /** Written as a number array; read back as an Arrow vector. */
  vector: unknown;
}

/**
 * The LanceDB table of chunks and the one meta file that says how it was built.
 *
 * The index is derived data: the Markdown files are the truth. So any disagreement between the
 * meta file and the running configuration is settled by dropping the table, never by migrating it.
 */
export class Store {
  readonly dataDir: string;
  /** Why the table was dropped at open, or undefined when it was reused. */
  readonly rebuiltBecause: string | undefined;
  private readonly table: lancedb.Table;
  private readonly embedder: Embedder;

  private constructor(
    dataDir: string,
    table: lancedb.Table,
    embedder: Embedder,
    rebuiltBecause: string | undefined,
  ) {
    this.dataDir = dataDir;
    this.table = table;
    this.embedder = embedder;
    this.rebuiltBecause = rebuiltBecause;
  }

  /**
   * Open the index under `dataDir`, creating it on first use.
   *
   * @param writable a reader never drops a table it disagrees with — that is the writer's call —
   *   and instead fails, since its query vectors would be meaningless against the stored ones.
   */
  static async open(dataDir: string, embedder: Embedder, writable: boolean): Promise<Store> {
    await mkdir(dataDir, { recursive: true });
    // An interval of 0 re-checks the table version on every read, so a process that is not the
    // writer sees the writer's commits immediately.
    const db = await lancedb.connect(join(dataDir, "lance"), { readConsistencyInterval: 0 });
    const wanted: Meta = {
      embedder: embedder.name,
      dim: embedder.dim,
      chunker_version: CHUNKER_VERSION,
    };
    const metaPath = join(dataDir, "meta.json");
    const existing = await readMeta(metaPath);
    // Only ever one table, so the first page is all of them.
    const names = (await db.listTables({ limit: 100 })).tables;

    let rebuiltBecause: string | undefined;
    if (names.includes(TABLE)) {
      if (!existing) rebuiltBecause = "the index has no meta file";
      else if (existing.embedder !== wanted.embedder) {
        rebuiltBecause = `the embedder changed from ${existing.embedder} to ${wanted.embedder}`;
      } else if (existing.chunker_version !== wanted.chunker_version) {
        rebuiltBecause = `the chunker changed from v${existing.chunker_version} to v${wanted.chunker_version}`;
      }
    }
    if (rebuiltBecause && !writable) {
      throw new Error(
        `the index needs a rebuild (${rebuiltBecause}); start the primary server first`,
      );
    }

    if (rebuiltBecause || !names.includes(TABLE)) {
      if (!writable)
        throw new Error("the index does not exist yet; start the primary server first");
      if (names.includes(TABLE)) await db.dropTable(TABLE);
      const table = await db.createEmptyTable(TABLE, schema(embedder.dim));
      await table.createIndex("text", { config: lancedb.Index.fts() });
      await writeAtomic(metaPath, `${JSON.stringify(wanted, null, 2)}\n`);
      return new Store(dataDir, table, embedder, rebuiltBecause);
    }
    return new Store(dataDir, await db.openTable(TABLE), embedder, undefined);
  }

  /** Every indexed file and what it looked like when it was indexed. Scans only four columns. */
  async files(): Promise<Map<string, FileState>> {
    const rows = await this.table
      .query()
      .select(["path", "file_hash", "mtime_ms", "size"])
      .toArray();
    const files = new Map<string, FileState>();
    for (const row of rows as Pick<Row, "path" | "file_hash" | "mtime_ms" | "size">[]) {
      const state = files.get(row.path);
      if (state) state.chunks++;
      else {
        files.set(row.path, {
          hash: row.file_hash,
          mtimeMs: row.mtime_ms,
          size: row.size,
          chunks: 1,
        });
      }
    }
    return files;
  }

  /**
   * Replace the chunks of `updates` and drop every chunk of `removed`, in one delete and one add.
   * A reader between the two briefly sees those files as absent, never as half-updated.
   */
  async apply(updates: FileUpdate[], removed: string[]): Promise<void> {
    const paths = [...updates.map((u) => u.path), ...removed];
    if (paths.length === 0) return;
    await this.table.delete(`path IN (${paths.map(sqlString).join(", ")})`);
    const rows: Row[] = updates.flatMap((u) =>
      u.chunks.map((chunk, i) => ({
        id: `${u.path}#${chunk.index}@${u.hash.slice(0, 12)}`,
        path: u.path,
        file_hash: u.hash,
        mtime_ms: u.mtimeMs,
        size: u.size,
        chunk_index: chunk.index,
        title: chunk.title,
        heading: chunk.heading,
        text: chunk.text,
        line_start: chunk.lineStart,
        line_end: chunk.lineEnd,
        vector: Array.from(u.vectors[i] ?? []),
      })),
    );
    if (rows.length > 0) await this.table.add(rows as unknown as Record<string, unknown>[]);
  }

  /**
   * Fold the small files the adds and deletes left behind, bring the full-text index up to date and
   * delete old table versions. The one-minute grace keeps a reader mid-query on its version.
   */
  async compact(): Promise<void> {
    await this.table.optimize({ cleanupOlderThan: new Date(Date.now() - 60_000) });
  }

  async count(): Promise<number> {
    return this.table.countRows();
  }

  /**
   * Hybrid search: nearest chunks by cosine similarity and best chunks by BM25, fused by reciprocal
   * rank. Lexical search is what finds an exact error string or flag name that an embedding blurs;
   * dense search is what finds the paragraph that answers a question in other words.
   *
   * @param pathPrefix limits both retrievers to files under this relative path.
   */
  async search(query: string, limit: number, pathPrefix?: string): Promise<Hit[]> {
    const [queryVector] = await this.embedder.embed([query], "query");
    if (!queryVector) return [];
    const pool = Math.max(limit * 4, 20);
    const where = pathPrefix ? `starts_with(path, ${sqlString(pathPrefix)})` : undefined;

    let dense = this.table.vectorSearch(queryVector).distanceType("cosine");
    if (where) dense = dense.where(where);
    const denseRows = (await dense.limit(pool).toArray()) as (Row & { _distance: number })[];

    let lexicalRows: Row[] = [];
    if (/[\p{L}\p{N}]/u.test(query)) {
      try {
        let lexical = this.table.search(query, "fts", "text");
        if (where) lexical = lexical.where(where);
        lexicalRows = (await lexical.limit(pool).toArray()) as Row[];
      } catch (error) {
        // A query the full-text parser rejects still has a dense answer; losing half the ranking
        // is better than failing the call.
        console.error(`[store] full-text search failed, using dense only: ${errorMessage(error)}`);
      }
    }

    const fused = new Map<string, { row: Row; score: number; sources: Hit["sources"] }>();
    const addRanked = (rows: Row[], source: "dense" | "lexical") => {
      rows.forEach((row, rank) => {
        const entry = fused.get(row.id) ?? { row, score: 0, sources: [] };
        entry.score += 1 / (RRF_K + rank + 1);
        entry.sources.push(source);
        fused.set(row.id, entry);
      });
    };
    addRanked(denseRows, "dense");
    addRanked(lexicalRows, "lexical");

    return [...fused.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ row, score, sources }) =>
        toHit(row, score, cosine(queryVector, row.vector), sources),
      );
  }
}

function toHit(row: Row, score: number, similarity: number, sources: Hit["sources"]): Hit {
  return {
    id: row.id,
    path: row.path,
    title: row.title,
    heading: row.heading,
    text: row.text,
    lineStart: row.line_start,
    lineEnd: row.line_end,
    score,
    similarity,
    sources,
  };
}

/**
 * Both sides are unit length, so the dot product is the cosine. LanceDB hands the stored vector
 * back as an Arrow `Vector`, which does not support `[i]`; `toArray()` gives the Float32Array.
 */
function cosine(a: Float32Array, stored: unknown): number {
  const b = (stored as { toArray?: () => ArrayLike<number> } | undefined)?.toArray?.() ?? stored;
  if (!b || typeof (b as ArrayLike<number>).length !== "number") return 0;
  const values = b as ArrayLike<number>;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (values[i] ?? 0);
  return dot;
}

function schema(dim: number): Schema {
  return new Schema([
    new Field("id", new Utf8(), false),
    new Field("path", new Utf8(), false),
    new Field("file_hash", new Utf8(), false),
    new Field("mtime_ms", new Float64(), false),
    new Field("size", new Float64(), false),
    new Field("chunk_index", new Int32(), false),
    new Field("title", new Utf8(), false),
    new Field("heading", new Utf8(), false),
    new Field("text", new Utf8(), false),
    new Field("line_start", new Int32(), false),
    new Field("line_end", new Int32(), false),
    new Field("vector", new FixedSizeList(dim, new Field("item", new Float32(), true)), false),
  ]);
}

/** A SQL string literal for a LanceDB filter; a file name may contain a quote. */
function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function readMeta(path: string): Promise<Meta | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Meta;
  } catch {
    // Missing or unreadable are the same answer: this index cannot be trusted as it is.
    return undefined;
  }
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, contents, { mode: 0o600 });
  await rename(temp, path);
}
