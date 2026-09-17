// How much faster can LanceDB's dense search get without leaving LanceDB?
//
// qdrant.ts found LanceDB flat search fine at corpus size but slow by 100k chunks, and very slow
// with a filter. This sweeps the knobs that do not change the architecture, each against brute-force
// ground truth at the limit `store.search` really asks for (40 for a top-10 recall):
//
// 1. Per query, on the real Store table: the vector column in the result, cosine vs dot (the
//    vectors are unit length, so the ranking is the same), and `readConsistencyInterval: 0`, which
//    makes every read re-check the table version.
// 2. Filters at scale: `starts_with(path)` as shipped, an equality on a folder column, no scalar
//    index / btree / bitmap, and postfiltering.
// 3. Vector indexes at scale: HNSW-SQ with the default partitions and with one (the docs'
//    recommendation) across ef, IVF-flat across nprobes, IVF-PQ with a refine step.
//
// Each variant gets its own table, and a group's variants run interleaved query by query, so load
// from elsewhere on the machine moves them together: compare rows within a group, not across runs.
//
//   node scripts/bench/lance-tuning.ts   # SIZES=10000,100000 by default; writes lance-tuning.json
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { Store } from "../../src/store.ts";
import {
  corpus,
  FOLDERS,
  interleaved,
  jitter,
  recall,
  scaledVectors,
  type Timing,
  truth,
} from "./scale.ts";

const here = import.meta.dirname;
const MODEL = process.env.MODEL ?? "granite-small";
const SIZES = (process.env.SIZES ?? "10000,100000").split(",").map(Number);
const QUERIES = 200;
const WARMUP = 30;
/** `store.search(q, 10)` pulls max(10 * 4, 20) from each retriever. */
const LIMIT = 40;
/** A slow group stops after this much timed work (and at least 50 rounds). */
const BUDGET_MS = 90_000;

const { embedder, updates, chunkRows, qs, qvs } = await corpus(MODEL);
const dim = embedder.dim;

interface Result {
  n: number;
  group: string;
  variant: string;
  buildMs?: number;
  timing: Timing;
  recall?: number;
}
const results: Result[] = [];

interface Entry {
  variant: string;
  run: (i: number) => Promise<unknown>;
  /** Ground truth per query when `run` returns row ids. */
  want?: number[][];
  buildMs?: number;
}
async function group(n: number, name: string, entries: Entry[]) {
  console.error(`[bench] ${name}: ${entries.length} variants`);
  const { timings, outputs } = await interleaved(
    entries.map((e) => e.run),
    QUERIES,
    WARMUP,
    BUDGET_MS,
  );
  console.log(`\n${name}`);
  console.log(
    "variant                                           n     p50     p95     p99  recall",
  );
  entries.forEach((e, k) => {
    const timing = timings[k] as Timing;
    const r = e.want ? recall(outputs[k] as number[][], e.want, LIMIT) : undefined;
    results.push({ n, group: name, variant: e.variant, buildMs: e.buildMs, timing, recall: r });
    console.log(
      `${e.variant.padEnd(45)} ${String(timing.n).padStart(5)} ${String(timing.p50).padStart(7)} ${String(timing.p95).padStart(7)} ${String(timing.p99).padStart(7)}  ${r?.toFixed(3) ?? "    —"}${e.buildMs === undefined ? "" : `  (index ${e.buildMs}ms)`}`,
    );
  });
}

async function time(build: () => Promise<unknown>) {
  const started = performance.now();
  await build();
  return Math.round(performance.now() - started);
}

// ---- 1. the real Store table ----
const realDir = mkdtempSync(join(here, `.lance-tuning-${MODEL}-`));
const store = await Store.open(realDir, embedder, true);
await store.apply(updates, []);
await store.compact();
// biome-ignore lint: reach the private table to time each retriever alone
const strongReal = (store as any).table as lancedb.Table;
const looseReal = await (await lancedb.connect(join(realDir, "lance"))).openTable("chunks");
const REAL_COLUMNS = ["id", "path", "title", "heading", "text", "line_start", "line_end"];
const n1 = qs.length;
const dense =
  (t: lancedb.Table, distance: "cosine" | "dot", allColumns: boolean) => (i: number) => {
    const q = t
      .vectorSearch(qvs[i % n1] as Float32Array)
      .distanceType(distance)
      .limit(LIMIT);
    return (allColumns ? q : q.select(REAL_COLUMNS)).toArray();
  };
const fts = (t: lancedb.Table, allColumns: boolean) => (i: number) => {
  const q = t.search(qs[i % n1] as string, "fts", "search_text").limit(LIMIT);
  return (allColumns ? q : q.select(REAL_COLUMNS)).toArray();
};
await group(chunkRows.length, `real Store table: ${chunkRows.length} chunks, limit ${LIMIT}`, [
  { variant: "store.search, whole call", run: (i) => store.search(qs[i % n1] as string, 10) },
  { variant: "embed query", run: (i) => embedder.embed([qs[i % n1] as string], "query") },
  {
    variant: "dense: cosine, all columns, rci=0 (shipped)",
    run: dense(strongReal, "cosine", true),
  },
  { variant: "dense: cosine, no vector column, rci=0", run: dense(strongReal, "cosine", false) },
  { variant: "dense: dot, no vector column, rci=0", run: dense(strongReal, "dot", false) },
  { variant: "dense: cosine, all columns, rci unset", run: dense(looseReal, "cosine", true) },
  { variant: "dense: dot, no vector column, rci unset", run: dense(looseReal, "dot", false) },
  { variant: "fts: all columns, rci=0 (shipped)", run: fts(strongReal, true) },
  { variant: "fts: no vector column, rci=0", run: fts(strongReal, false) },
  { variant: "fts: all columns, rci unset", run: fts(looseReal, true) },
]);

// ---- 2 and 3. scale ----
const queryVectors = Array.from({ length: QUERIES }, (_, i) =>
  jitter(qvs[i % n1] as Float32Array, 0.01),
);
const folderOf = (i: number) => i % FOLDERS;
const byFolder = (i: number) => `folder = 'f${folderOf(i)}'`;
const byPath = (i: number) => `starts_with(path, 'f${folderOf(i)}/')`;

for (const n of SIZES) {
  const flat = scaledVectors(chunkRows, n, dim);
  const wantAll = queryVectors.map((q) => truth(flat, dim, q, LIMIT));
  const wantFolder = queryVectors.map((q, i) => truth(flat, dim, q, LIMIT, folderOf(i)));

  const dir = mkdtempSync(join(here, `.lance-tuning-${n}-`));
  const strong = await lancedb.connect(dir, { readConsistencyInterval: 0 });
  const loose = await lancedb.connect(dir);
  /** A compacted table of the N rows, opened on the rci=0 connection as the Store opens it. */
  const makeTable = async (name: string) => {
    let table: lancedb.Table | undefined;
    for (let i = 0; i < n; i += 10_000) {
      const rows = [];
      for (let r = i; r < Math.min(n, i + 10_000); r++) {
        rows.push({
          id: r,
          path: `f${folderOf(r)}/note-${r}.md`,
          folder: `f${folderOf(r)}`,
          text: chunkRows[r % chunkRows.length]?.text ?? "",
          vector: Array.from(flat.subarray(r * dim, (r + 1) * dim)),
        });
      }
      if (table) await table.add(rows);
      else table = await strong.createTable(name, rows);
    }
    await (table as lancedb.Table).optimize();
    return table as lancedb.Table;
  };

  interface Search {
    distance?: "cosine" | "dot";
    allColumns?: boolean;
    where?: (i: number) => string;
    postfilter?: boolean;
    tune?: (q: lancedb.VectorQuery) => lancedb.VectorQuery;
  }
  const search =
    (t: lancedb.Table, s: Search = {}) =>
    async (i: number) => {
      let q = t
        .vectorSearch(queryVectors[i % QUERIES] as Float32Array)
        .distanceType(s.distance ?? "cosine")
        .limit(LIMIT);
      if (!s.allColumns) q = q.select(["id", "path", "text"]);
      if (s.where) q = q.where(s.where(i));
      if (s.postfilter) q = q.postfilter();
      if (s.tune) q = s.tune(q);
      return ((await q.toArray()) as { id: number }[]).map((r) => r.id);
    };

  // Flat: one plain table, one with btrees on path and folder, one with a bitmap on folder.
  const plain = await makeTable("plain");
  const plainLoose = await loose.openTable("plain");
  const btree = await makeTable("btree");
  const btreeMs =
    (await time(() => btree.createIndex("path", { config: lancedb.Index.btree() }))) +
    (await time(() => btree.createIndex("folder", { config: lancedb.Index.btree() })));
  const bitmap = await makeTable("bitmap");
  const bitmapMs = await time(() =>
    bitmap.createIndex("folder", { config: lancedb.Index.bitmap() }),
  );

  await group(n, `N=${n} flat, unfiltered`, [
    {
      variant: "cosine, all columns, rci=0 (shipped)",
      run: search(plain, { allColumns: true }),
      want: wantAll,
    },
    { variant: "cosine, no vector column, rci=0", run: search(plain), want: wantAll },
    {
      variant: "dot, no vector column, rci=0",
      run: search(plain, { distance: "dot" }),
      want: wantAll,
    },
    { variant: "cosine, no vector column, rci unset", run: search(plainLoose), want: wantAll },
  ]);

  await group(n, `N=${n} flat, 10% filter`, [
    {
      variant: "starts_with(path), no index (shipped)",
      run: search(plain, { where: byPath }),
      want: wantFolder,
    },
    {
      variant: "starts_with(path), postfilter",
      run: search(plain, { where: byPath, postfilter: true }),
      want: wantFolder,
    },
    { variant: "folder =, no index", run: search(plain, { where: byFolder }), want: wantFolder },
    {
      variant: "starts_with(path), btree",
      run: search(btree, { where: byPath }),
      want: wantFolder,
      buildMs: btreeMs,
    },
    { variant: "folder =, btree", run: search(btree, { where: byFolder }), want: wantFolder },
    {
      variant: "folder =, bitmap",
      run: search(bitmap, { where: byFolder }),
      want: wantFolder,
      buildMs: bitmapMs,
    },
  ]);

  // Vector indexes: a table per index, each with a bitmap on folder for the filtered queries.
  const indexed = async (name: string, config: lancedb.Index) => {
    const t = await makeTable(name);
    const buildMs = await time(() => t.createIndex("vector", { config }));
    await t.createIndex("folder", { config: lancedb.Index.bitmap() });
    return { t, buildMs };
  };
  const hnswDefault = await indexed(
    "hnsw_default",
    lancedb.Index.hnswSq({ distanceType: "cosine" }),
  );
  const hnswOne = await indexed(
    "hnsw_one",
    lancedb.Index.hnswSq({ distanceType: "cosine", numPartitions: 1 }),
  );
  const ivfFlat = await indexed("ivf_flat", lancedb.Index.ivfFlat({ distanceType: "cosine" }));
  const ivfPq = await indexed("ivf_pq", lancedb.Index.ivfPq({ distanceType: "cosine" }));

  const indexEntries = (filtered: boolean): Entry[] => {
    const where = filtered ? byFolder : undefined;
    const want = filtered ? wantFolder : wantAll;
    return [
      {
        variant: "hnsw-sq default partitions, ef default",
        run: search(hnswDefault.t, { where }),
        want,
        buildMs: hnswDefault.buildMs,
      },
      ...[60, 150, 400].map((ef, k) => ({
        variant: `hnsw-sq 1 partition, ef ${ef}${ef === 60 ? " (default)" : ""}`,
        run: search(hnswOne.t, { where, tune: (q) => q.ef(ef) }),
        want,
        buildMs: k === 0 ? hnswOne.buildMs : undefined,
      })),
      ...[20, 50, 100].map((p, k) => ({
        variant: `ivf-flat, nprobes ${p}${p === 20 ? " (default)" : ""}`,
        run: search(ivfFlat.t, { where, tune: (q) => q.nprobes(p) }),
        want,
        buildMs: k === 0 ? ivfFlat.buildMs : undefined,
      })),
      ...[20, 50].map((p, k) => ({
        variant: `ivf-pq, nprobes ${p}, refine 10`,
        run: search(ivfPq.t, { where, tune: (q) => q.nprobes(p).refineFactor(10) }),
        want,
        buildMs: k === 0 ? ivfPq.buildMs : undefined,
      })),
    ];
  };
  await group(n, `N=${n} vector indexes, unfiltered`, indexEntries(false));
  await group(n, `N=${n} vector indexes, 10% filter (bitmap on folder)`, indexEntries(true));
}

writeFileSync(
  join(here, "lance-tuning.json"),
  JSON.stringify({ model: embedder.name, limit: LIMIT, results }, null, 2),
);
