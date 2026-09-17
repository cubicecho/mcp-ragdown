// Would Qdrant make dense retrieval faster than the LanceDB table ragdown ships?
//
// Two parts, both on the same machine with the same vectors:
//
// 1. The real pipeline on the synthetic corpus: how long a query spends embedding, in LanceDB's
//    dense and full-text searches, and in the equivalent Qdrant dense search. This is the number a
//    hook pays today, so it says whether the vector search is worth replacing at all.
// 2. Scale: the corpus's own chunk vectors, jittered and replicated to N points, searched top-10
//    unfiltered and with a 10% payload filter. LanceDB flat (what ships) and HNSW-SQ, against
//    Qdrant's default HNSW and its exact search. Recall@10 is against brute force, so a fast
//    index that misses neighbours shows it.
//
// Qdrant has no in-process Node binding, so its timings include a localhost HTTP round trip and
// JSON — which is exactly what ragdown would pay if it used it. Run a local server first:
//
//   qdrant   # or QDRANT_URL=http://host:6333; SIZES=1000,10000,100000 by default
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { Store } from "../../src/store.ts";
import { corpus, FOLDERS, jitter, recall, scaledVectors, timed, truth } from "./scale.ts";

const here = import.meta.dirname;
const QDRANT = process.env.QDRANT_URL ?? "http://127.0.0.1:6333";
const MODEL = process.env.MODEL ?? "granite-small";
const SIZES = (process.env.SIZES ?? "1000,10000,100000").split(",").map(Number);
const QUERIES = 200;
const WARMUP = 20;
const K = 10;

async function qd(method: string, path: string, body?: unknown) {
  const res = await fetch(QDRANT + path, {
    method,
    // fetch asks for gzip/br by default, and Qdrant then compresses any response over a few KB into
    // a write pattern that waits out a 40 ms delayed ACK. Ragdown would have to opt out too.
    headers: { "content-type": "application/json", "accept-encoding": "identity" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as { result: unknown };
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
  // biome-ignore lint: untyped REST results
  return json.result as any;
}

async function qdCollection(name: string, dim: number) {
  await qd("DELETE", `/collections/${name}`);
  await qd("PUT", `/collections/${name}`, { vectors: { size: dim, distance: "Cosine" } });
}

async function qdUpload(name: string, points: unknown[]) {
  for (let i = 0; i < points.length; i += 1000) {
    await qd("PUT", `/collections/${name}/points?wait=true`, { points: points.slice(i, i + 1000) });
  }
  // Wait out the optimizer, so HNSW is built before anything is timed.
  for (;;) {
    const info = await qd("GET", `/collections/${name}`);
    if (info.status === "green") return info;
    await new Promise((done) => setTimeout(done, 250));
  }
}

const { embedder, updates, chunkRows, qs, qvs } = await corpus(MODEL);
const dim = embedder.dim;
const qdrantVersion = (await (await fetch(`${QDRANT}/`)).json()) as { version: string };
const out: Record<string, unknown> = { model: embedder.name, qdrant: qdrantVersion.version };

// ---- part 1: the real pipeline ----
const store = await Store.open(mkdtempSync(join(here, `.qdrant-${MODEL}-`)), embedder, true);
await store.apply(updates, []);
await store.compact();
// biome-ignore lint: reach the private table to time each retriever alone
const table = (store as any).table as lancedb.Table;

await qdCollection("ragdown_real", dim);
await qdUpload(
  "ragdown_real",
  chunkRows.map((c, id) => ({
    id,
    vector: Array.from(c.v),
    payload: { path: c.path, title: c.title, heading: c.heading, text: c.text },
  })),
);

const pool = Math.max(K * 4, 20);
const n1 = qs.length;
const real = {
  chunks: chunkRows.length,
  queries: n1,
  embedQuery: await timed(n1, WARMUP, (i) => embedder.embed([qs[i % n1] as string], "query")),
  storeSearch: await timed(n1, WARMUP, (i) => store.search(qs[i % n1] as string, K)),
  lanceDense: await timed(n1, WARMUP, (i) =>
    table
      .vectorSearch(qvs[i % n1] as Float32Array)
      .distanceType("cosine")
      .limit(pool)
      .toArray(),
  ),
  lanceFts: await timed(n1, WARMUP, (i) =>
    table
      .search(qs[i % n1] as string, "fts", "search_text")
      .limit(pool)
      .toArray(),
  ),
  qdrantDense: await timed(n1, WARMUP, (i) =>
    qd("POST", "/collections/ragdown_real/points/query", {
      query: Array.from(qvs[i % n1] as Float32Array),
      limit: pool,
      with_payload: true,
    }),
  ),
};
out.real = real;
console.log(`\nreal corpus: ${real.chunks} chunks, ${real.queries} queries (ms)`);
console.log("step              p50     p95    mean");
for (const [k, v] of Object.entries(real)) {
  if (typeof v !== "object") continue;
  console.log(
    `${k.padEnd(14)} ${String(v.p50).padStart(6)}  ${String(v.p95).padStart(6)}  ${String(v.mean).padStart(6)}`,
  );
}

// ---- part 2: scale ----
const queryVectors = Array.from({ length: QUERIES }, (_, i) =>
  jitter(qvs[i % n1] as Float32Array, 0.01),
);
const queryFolders = Array.from({ length: QUERIES }, (_, i) => `f${i % FOLDERS}`);

const scale: Record<string, unknown>[] = [];
for (const n of SIZES) {
  const flat = scaledVectors(chunkRows, n, dim);
  const vec = (i: number) => Array.from(flat.subarray(i * dim, (i + 1) * dim));
  const wantAll = queryVectors.map((q) => truth(flat, dim, q, K));
  const wantFolder = queryVectors.map((q, i) => truth(flat, dim, q, K, i % FOLDERS));

  // LanceDB: batches, compacted, a bitmap on the filter column as Qdrant gets a payload index.
  const db = await lancedb.connect(mkdtempSync(join(here, `.qdrant-scale-${n}-`)));
  let lt: lancedb.Table | undefined;
  let started = performance.now();
  for (let i = 0; i < n; i += 10_000) {
    const rows = [];
    for (let r = i; r < Math.min(n, i + 10_000); r++)
      rows.push({ id: r, folder: `f${r % FOLDERS}`, vector: vec(r) });
    if (lt) await lt.add(rows);
    else lt = await db.createTable("t", rows);
  }
  const lance = lt as lancedb.Table;
  await lance.optimize();
  await lance.createIndex("folder", { config: lancedb.Index.bitmap() });
  const lanceLoadMs = Math.round(performance.now() - started);

  const runLance = async (label: string, hnsw: boolean) => {
    const got: number[][] = [];
    const gotF: number[][] = [];
    const search = (i: number) =>
      lance
        .vectorSearch(queryVectors[i % QUERIES] as Float32Array)
        .distanceType("cosine")
        .limit(K)
        .select(["id"]);
    const all = await timed(QUERIES, WARMUP, async (i) => {
      got[i] = ((await search(i).toArray()) as { id: number }[]).map((r) => r.id);
    });
    const filtered = await timed(QUERIES, WARMUP, async (i) => {
      const rows = await search(i).where(`folder = '${queryFolders[i]}'`).toArray();
      gotF[i] = (rows as { id: number }[]).map((r) => r.id);
    });
    const row = {
      n,
      engine: label,
      hnsw,
      all,
      recall: recall(got, wantAll, K),
      filtered,
      recallFiltered: recall(gotF, wantFolder, K),
    };
    scale.push(row);
    return row;
  };
  const rows = [await runLance("lance flat", false)];
  if (n >= 10_000) {
    started = performance.now();
    await lance.createIndex("vector", { config: lancedb.Index.hnswSq({ distanceType: "cosine" }) });
    const buildMs = Math.round(performance.now() - started);
    rows.push({ ...(await runLance("lance hnsw-sq", true)), buildMs } as never);
  }

  started = performance.now();
  await qdCollection("ragdown_scale", dim);
  await qd("PUT", "/collections/ragdown_scale/index?wait=true", {
    field_name: "folder",
    field_schema: "keyword",
  });
  const points = [];
  for (let i = 0; i < n; i++)
    points.push({ id: i, vector: vec(i), payload: { folder: `f${i % FOLDERS}` } });
  const info = await qdUpload("ragdown_scale", points);
  const qdrantLoadMs = Math.round(performance.now() - started);

  for (const exact of [false, true]) {
    const got: number[][] = [];
    const gotF: number[][] = [];
    const body = (i: number, filter: boolean) => ({
      query: Array.from(queryVectors[i % QUERIES] as Float32Array),
      limit: K,
      params: { exact },
      ...(filter
        ? { filter: { must: [{ key: "folder", match: { value: queryFolders[i] } }] } }
        : {}),
    });
    const all = await timed(QUERIES, WARMUP, async (i) => {
      const r = await qd("POST", "/collections/ragdown_scale/points/query", body(i, false));
      got[i] = r.points.map((p: { id: number }) => p.id);
    });
    const filtered = await timed(QUERIES, WARMUP, async (i) => {
      const r = await qd("POST", "/collections/ragdown_scale/points/query", body(i, true));
      gotF[i] = r.points.map((p: { id: number }) => p.id);
    });
    const row = {
      n,
      engine: exact ? "qdrant exact" : "qdrant default",
      indexedVectors: info.indexed_vectors_count,
      all,
      recall: recall(got, wantAll, K),
      filtered,
      recallFiltered: recall(gotF, wantFolder, K),
    };
    scale.push(row);
    rows.push(row as never);
  }
  console.log(
    `\nN=${n}  load: lance ${lanceLoadMs}ms, qdrant ${qdrantLoadMs}ms (indexed ${info.indexed_vectors_count})`,
  );
  console.log("engine            all p50   p95  recall   filtered p50   p95  recall");
  for (const r of rows as unknown as {
    engine: string;
    all: { p50: number; p95: number };
    recall: number;
    filtered: { p50: number; p95: number };
    recallFiltered: number;
  }[]) {
    console.log(
      `${r.engine.padEnd(16)} ${String(r.all.p50).padStart(7)} ${String(r.all.p95).padStart(5)}  ${r.recall.toFixed(3)}   ${String(r.filtered.p50).padStart(12)} ${String(r.filtered.p95).padStart(5)}  ${r.recallFiltered.toFixed(3)}`,
    );
  }
}
out.scale = scale;
writeFileSync(join(here, "qdrant.json"), JSON.stringify(out, null, 2));
await qd("DELETE", "/collections/ragdown_real");
await qd("DELETE", "/collections/ragdown_scale");
