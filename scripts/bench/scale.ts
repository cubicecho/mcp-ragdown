// Shared by the vector-search benchmarks (qdrant.ts, lance-tuning.ts): the corpus embedded as the
// server would, its vectors jittered up to any N, exact ground truth, and a latency timer.
import { join } from "node:path";
import { type Chunk, chunkMarkdown, embeddingText } from "../../src/chunk.ts";
import { createEmbedder } from "../../src/embedder.ts";
import type { FileUpdate } from "../../src/store.ts";
import { docs, questions, renderDoc } from "./gen.ts";

/** Synthetic rows are spread over this many top-level folders; a filter on one keeps 10%. */
export const FOLDERS = 10;

export interface ChunkRow extends Chunk {
  path: string;
  v: Float32Array;
}

/** Every corpus chunk and question embedded with `model`, plus the updates a `Store` takes. */
export async function corpus(model: string) {
  const embedder = await createEmbedder({
    embedder: model,
    modelsDir: join(process.env.HOME ?? "", ".cache/ragdown-bench-models"),
    threads: 0,
  } as never);
  const updates: FileUpdate[] = [];
  const chunkRows: ChunkRow[] = [];
  for (const d of docs) {
    const chunks = chunkMarkdown(renderDoc(d, "md"), `${d.slug}.md`);
    const vectors = await embedder.embed(chunks.map(embeddingText), "document");
    chunks.forEach((c, i) => {
      chunkRows.push({ path: d.slug, ...c, v: vectors[i] as Float32Array });
    });
    updates.push({
      path: d.slug,
      hash: `b${d.slug}`,
      mtimeMs: 0,
      size: 0,
      chunks,
      vectors,
      supersedes: [],
    });
  }
  const qs = questions.map((q) => q.q);
  const qvs = await embedder.embed(qs, "query");
  return { embedder, updates, chunkRows, qs, qvs };
}

function gaussian() {
  return Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
}

/** `base` plus isotropic noise, renormalised: a near neighbour of a real embedding. */
export function jitter(base: Float32Array, sigma: number): Float32Array {
  const v = new Float32Array(base.length);
  let norm = 0;
  for (let j = 0; j < v.length; j++) {
    v[j] = (base[j] as number) + sigma * gaussian();
    norm += (v[j] as number) ** 2;
  }
  norm = Math.sqrt(norm);
  for (let j = 0; j < v.length; j++) v[j] = (v[j] as number) / norm;
  return v;
}

/** `n` jittered copies of the corpus vectors, packed row after row. */
export function scaledVectors(chunkRows: ChunkRow[], n: number, dim: number): Float32Array {
  const flat = new Float32Array(n * dim);
  for (let i = 0; i < n; i++) {
    flat.set(jitter((chunkRows[i % chunkRows.length] as ChunkRow).v, 0.03), i * dim);
  }
  return flat;
}

/**
 * Exact top-`k` row numbers by dot product (the vectors are unit length), optionally only rows in
 * one folder — row `i` is in folder `i % FOLDERS`.
 */
export function truth(
  flat: Float32Array,
  dim: number,
  q: Float32Array,
  k: number,
  folder?: number,
): number[] {
  const n = flat.length / dim;
  const best: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    if (folder !== undefined && i % FOLDERS !== folder) continue;
    let dot = 0;
    const o = i * dim;
    for (let j = 0; j < dim; j++) dot += (flat[o + j] as number) * (q[j] as number);
    if (best.length < k || dot > (best[best.length - 1] as [number, number])[1]) {
      best.push([i, dot]);
      best.sort((a, b) => b[1] - a[1]);
      if (best.length > k) best.pop();
    }
  }
  return best.map(([i]) => i);
}

/** Mean recall@k over the queries that were answered. */
export function recall(got: number[][], want: number[][], k: number): number {
  const answered = got.flatMap((ids, i) => (ids ? [i] : []));
  const found = answered.reduce(
    (n, i) => n + (got[i] as number[]).filter((id) => want[i]?.includes(id)).length,
    0,
  );
  return Number((found / (answered.length * k)).toFixed(3));
}

export interface Timing {
  n: number;
  p50: number;
  p95: number;
  p99: number;
  mean: number;
}

/**
 * Latency of `run(i)` over `n` sequential calls after `warmup` untimed ones. Stops early, after at
 * least 50 calls, once `budgetMs` is spent, so a slow variant costs minutes rather than hours.
 */
export async function timed(
  n: number,
  warmup: number,
  run: (i: number) => Promise<unknown>,
  budgetMs = Number.POSITIVE_INFINITY,
): Promise<Timing> {
  const { timings } = await interleaved([run], n, warmup, budgetMs);
  return timings[0] as Timing;
}

/**
 * `timed` for several variants at once: round `i` runs query `i` through every variant, starting
 * from a different one each round. On a machine with other load, drift then lands on all variants
 * alike, so they stay comparable with each other even when the absolute numbers move.
 */
export async function interleaved<T>(
  runs: ((i: number) => Promise<T>)[],
  rounds: number,
  warmup: number,
  budgetMs = Number.POSITIVE_INFINITY,
): Promise<{ timings: Timing[]; outputs: T[][] }> {
  for (let i = 0; i < warmup; i++) for (const run of runs) await run(i);
  const ms = runs.map((): number[] => []);
  const outputs = runs.map((): T[] => []);
  const began = performance.now();
  for (let i = 0; i < rounds; i++) {
    for (let k = 0; k < runs.length; k++) {
      const j = (i + k) % runs.length;
      const started = performance.now();
      (outputs[j] as T[])[i] = await (runs[j] as (i: number) => Promise<T>)(i);
      (ms[j] as number[]).push(performance.now() - started);
    }
    if (i >= 49 && performance.now() - began > budgetMs) break;
  }
  return { timings: ms.map(summarize), outputs };
}

function summarize(ms: number[]): Timing {
  ms.sort((a, b) => a - b);
  const at = (p: number) => ms[Math.min(ms.length - 1, Math.floor(p * ms.length))] as number;
  const round = (x: number) => Number(x.toFixed(2));
  return {
    n: ms.length,
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    p99: round(at(0.99)),
    mean: round(ms.reduce((a, b) => a + b, 0) / ms.length),
  };
}
