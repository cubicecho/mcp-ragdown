import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { Field, FixedSizeList, Float32, Float64, Int32, Schema, Utf8 } from "apache-arrow";
import { CHUNKER_VERSION, type Chunk, embeddingText } from "./chunk.ts";
import type { Embedder } from "./embedder.ts";
import { errorMessage } from "./errors.ts";

const TABLE = "chunks";
/**
 * Bumped whenever the table's columns or indexes change, so an index built by the old layout is
 * rebuilt rather than queried with columns it does not have. Separate from `CHUNKER_VERSION`: the
 * chunks may be unchanged and still be stored differently.
 */
const INDEX_VERSION = 2;
/** Reciprocal-rank-fusion constant; 60 is the value from the original RRF paper and rarely worth tuning. */
const RRF_K = 60;
/**
 * Chunks below which no vector index is built. A folder of notes is nowhere near it, and under it
 * the flat scan wins anyway: measured at 10k chunks the index is twice as fast, at 1k it is noise.
 */
const VECTOR_INDEX_MIN_ROWS = 10_000;

/** What the index remembers about a file, to decide on the next sync whether it changed. */
export interface FileState {
  hash: string;
  mtimeMs: number;
  size: number;
  chunks: number;
}

export interface DocumentInfo {
  path: string;
  title: string;
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
  /** Paths, relative to the docs root, this file's frontmatter says it replaces. */
  supersedes: string[];
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
  index_version: number;
}

/** The columns a `Hit` is built from: everything a search reads except the vector. */
const HIT_COLUMNS = ["id", "path", "title", "heading", "text", "line_start", "line_end"] as const;
type HitRow = Pick<Row, (typeof HIT_COLUMNS)[number]>;
/**
 * A row from either retriever, carrying the cosine of the query and the chunk. Each side works it
 * out from what it has — the dense one from `_distance`, the lexical one from the stored vector —
 * so fusion never has to ask where a row came from.
 */
type ScoredRow = HitRow & { similarity: number };

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
  /** What the full-text index sees: the breadcrumb and the text, as `embeddingText` builds it. */
  search_text: string;
  /** The file's `supersedes` frontmatter, newline-separated; the same on every row of a file. */
  supersedes: string;
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
  /** `supersededPaths`, until the next `apply` makes it stale. */
  private superseded: Set<string> | undefined;
  /** Whether the table has a vector index, so `compact` asks the table only until it does. */
  private vectorIndexed = false;

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
      index_version: INDEX_VERSION,
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
      } else if (existing.index_version !== wanted.index_version) {
        rebuiltBecause = `the index layout changed from v${existing.index_version ?? 0} to v${wanted.index_version}`;
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
      await table.createIndex("search_text", { config: lancedb.Index.fts() });
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

  /** Every indexed file with its title, for listing rather than diffing. */
  async documents(): Promise<DocumentInfo[]> {
    const rows = await this.table.query().select(["path", "title", "mtime_ms", "size"]).toArray();
    const docs = new Map<string, DocumentInfo>();
    for (const row of rows as Pick<Row, "path" | "title" | "mtime_ms" | "size">[]) {
      const doc = docs.get(row.path);
      if (doc) doc.chunks++;
      else {
        docs.set(row.path, {
          path: row.path,
          title: row.title,
          mtimeMs: row.mtime_ms,
          size: row.size,
          chunks: 1,
        });
      }
    }
    return [...docs.values()].sort((a, b) => a.path.localeCompare(b.path));
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
        // Lexical search sees the breadcrumb the embedder sees: a table of settings says
        // "Replicas | 2 | 12" and never names the service its heading names.
        search_text: embeddingText(chunk),
        supersedes: u.supersedes.join("\n"),
        line_start: chunk.lineStart,
        line_end: chunk.lineEnd,
        vector: Array.from(u.vectors[i] ?? []),
      })),
    );
    if (rows.length > 0) await this.table.add(rows as unknown as Record<string, unknown>[]);
    this.superseded = undefined;
  }

  /**
   * Every path some other note's frontmatter replaces, so search can leave the old one out. Cached
   * because it is read on every search and changes only when the index does; the scan reads one
   * column of the few rows that name anything, not the table.
   */
  async supersededPaths(): Promise<Set<string>> {
    if (this.superseded) return this.superseded;
    const rows = (await this.table
      .query()
      .where("supersedes <> ''")
      .select(["supersedes"])
      .toArray()) as Pick<Row, "supersedes">[];
    const paths = new Set<string>();
    for (const row of rows) for (const path of row.supersedes.split("\n")) paths.add(path);
    this.superseded = paths;
    return paths;
  }

  /**
   * Fold the small files the adds and deletes left behind, bring the full-text index up to date and
   * delete old table versions. The one-minute grace keeps a reader mid-query on its version.
   *
   * `optimize` also folds new chunks into the vector index, if there is one; rows it has not reached
   * yet are still scanned, so a search never misses a chunk that is in the table.
   */
  async compact(): Promise<void> {
    await this.table.optimize({ cleanupOlderThan: new Date(Date.now() - 60_000) });
    await this.ensureVectorIndex();
  }

  /**
   * Build the vector index once the table is big enough to want one, and never before: under
   * `VECTOR_INDEX_MIN_ROWS` a flat scan is the faster answer and an exact one.
   *
   * IVF-flat, because it stores the vectors themselves rather than a quantisation of them: measured
   * over 10k and 100k chunks it returns exactly what the flat scan returns, two to five times
   * faster, and builds in about a second. The quantised indexes are faster again at 100k and lose
   * 5-20% of the true neighbours, which is a bad trade for a hook that injects four chunks.
   */
  private async ensureVectorIndex(): Promise<void> {
    if (this.vectorIndexed) return;
    try {
      const indices = await this.table.listIndices();
      if (indices.some((index) => index.columns.includes("vector"))) {
        this.vectorIndexed = true;
        return;
      }
      const rows = await this.table.countRows();
      if (rows < VECTOR_INDEX_MIN_ROWS) return;
      console.error(`[store] building the vector index over ${rows} chunks`);
      await this.table.createIndex("vector", {
        config: lancedb.Index.ivfFlat({ distanceType: "cosine" }),
      });
      this.vectorIndexed = true;
    } catch (error) {
      // The index is an optimisation; a flat scan still answers every query. Trying again on the
      // next sync costs a `listIndices` call.
      console.error(`[store] could not build the vector index: ${errorMessage(error)}`);
    }
  }

  async count(): Promise<number> {
    return this.table.countRows();
  }

  /**
   * Hybrid search: nearest chunks by cosine similarity and best chunks by BM25, fused by reciprocal
   * rank. Lexical search is what finds an exact error string or flag name that an embedding blurs;
   * dense search is what finds the paragraph that answers a question in other words.
   *
   * Both retrievers read the chunk with its breadcrumb (`search_text`). Matching BM25 on the body
   * alone loses every chunk that never repeats its own subject — a table of settings, a list of
   * steps — and a lexical ranking that bad drags the fused one below dense search on its own.
   *
   * A note another note's frontmatter supersedes is left out: a replaced fact that still reads as
   * confident prose is worse than no hit at all. The file stays on disk and `readDoc` still opens it.
   *
   * @param pathPrefix limits both retrievers to files under this relative path.
   */
  async search(query: string, limit: number, pathPrefix?: string): Promise<Hit[]> {
    const [queryVector] = await this.embedder.embed([query], "query");
    if (!queryVector) return [];
    const pool = Math.max(limit * 4, 20);
    // Superseded notes are filtered here rather than after fusion, so a replaced note cannot take
    // up the pool a current one would have filled.
    const superseded = await this.supersededPaths();
    const clauses = [
      ...(pathPrefix ? [`starts_with(path, ${sqlString(pathPrefix)})`] : []),
      ...(superseded.size > 0
        ? [`path NOT IN (${[...superseded].map(sqlString).join(", ")})`]
        : []),
    ];
    const where = clauses.length > 0 ? clauses.join(" AND ") : undefined;

    // The dense side asks for `_distance` and leaves the vector column behind: for a cosine search
    // the distance is 1 - similarity, so a vector per row would be copied out only to recompute a
    // number the search already knows. The lexical side still reads it, since a chunk only BM25
    // found has no distance and its similarity is what the hook gates on.
    let dense = this.table
      .vectorSearch(queryVector)
      .distanceType("cosine")
      .select([...HIT_COLUMNS, "_distance"]);
    if (where) dense = dense.where(where);
    const denseRows = (await dense.limit(pool).toArray()) as (HitRow & { _distance: number })[];
    const denseScored: ScoredRow[] = denseRows.map(({ _distance, ...row }) => ({
      ...row,
      similarity: 1 - _distance,
    }));

    let lexicalScored: ScoredRow[] = [];
    if (/[\p{L}\p{N}]/u.test(query)) {
      try {
        let lexical = this.table.search(query, "fts", "search_text");
        if (where) lexical = lexical.where(where);
        const rows = (await lexical.limit(pool).toArray()) as (HitRow & { vector: unknown })[];
        lexicalScored = rows.map(({ vector, ...row }) => ({
          ...row,
          similarity: cosine(queryVector, vector),
        }));
      } catch (error) {
        // A query the full-text parser rejects still has a dense answer; losing half the ranking
        // is better than failing the call.
        console.error(`[store] full-text search failed, using dense only: ${errorMessage(error)}`);
      }
    }

    // Each row already carries its own similarity, so which retriever reaches an id first decides
    // nothing: the two agree to floating-point noise, both being the cosine of the query and that
    // chunk.
    const fused = new Map<string, { row: ScoredRow; score: number; sources: Hit["sources"] }>();
    const addRanked = (rows: ScoredRow[], source: "dense" | "lexical") => {
      rows.forEach((row, rank) => {
        const entry = fused.get(row.id) ?? { row, score: 0, sources: [] };
        entry.score += 1 / (RRF_K + rank + 1);
        entry.sources.push(source);
        fused.set(row.id, entry);
      });
    };
    addRanked(denseScored, "dense");
    addRanked(lexicalScored, "lexical");

    return [...fused.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ row, score, sources }) => toHit(row, score, sources));
  }
}

function toHit(row: ScoredRow, score: number, sources: Hit["sources"]): Hit {
  return {
    id: row.id,
    path: row.path,
    title: row.title,
    heading: row.heading,
    text: row.text,
    lineStart: row.line_start,
    lineEnd: row.line_end,
    score,
    similarity: row.similarity,
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
    new Field("search_text", new Utf8(), false),
    new Field("supersedes", new Utf8(), false),
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
