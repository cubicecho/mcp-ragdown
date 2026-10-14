// Cross-encoder rerankers over the shipped retriever: the same corpus, the default embedder, the real
// `Store.search` (dense + FTS + RRF), and its fused pool re-sorted by each reranker. Only the order
// changes, so the pool's own recall is the ceiling. Measures rank quality per question type, the
// time a rerank adds to one query on CPU, and whether a reranker's score separates on-topic prompts
// from off-topic ones better than cosine does (the hook's gate).
//
//   node scripts/bench/rerank.ts                      # every reranker, 10 candidates each
//   ONLY=ettin-17m,minilm-l6 node scripts/bench/rerank.ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chunkMarkdown, embeddingText } from "../../src/documents/chunk.ts";
import { createEmbedder } from "../../src/indexing/embedder.ts";
import { type Hit, Store } from "../../src/indexing/store.ts";
import { docs, hardQuestions, headingPath, questions, renderDoc } from "./gen.ts";
import { interleaved } from "./scale.ts";

const here = import.meta.dirname;
const CACHE = join(process.env.HOME ?? "", ".cache/ragdown-bench-models");
const THREADS = Number(process.env.THREADS ?? 4);
// 20 candidates doubled the time and gained under a point: the answer is rarely ranked 11-20.
const POOLS = [10];

interface Spec {
  key: string;
  kind: "fast" | "better";
  repo: string;
  /** File under `onnx/`, without `.onnx`. Every one is an int8 export, as the shipped embedder is. */
  file: string;
  /**
   * `st`: the ONNX file is the bare encoder and the scoring head is sentence-transformers modules
   * beside it (CLS pooling, Dense+GELU, LayerNorm, Dense), applied here. Otherwise the export is a
   * sequence-classification model with `logits`.
   */
  head?: "st";
}

// Cut from a first pass of six (int8, 10 candidates, 270 questions): ettin-32m (no better than the
// fused order, at twice ettin-17m's time), ettin-68m and ettin-150m (below gte-modernbert on first
// place, and as slow or slower: ModernBERT costs more per parameter on CPU than its blog suggests).
const SPECS: Spec[] = [
  {
    key: "ettin-17m",
    kind: "fast",
    repo: "cross-encoder/ettin-reranker-17m-v1",
    file: "model_quint8_avx2",
    head: "st",
  },
  {
    key: "minilm-l6",
    kind: "fast",
    repo: "cross-encoder/ms-marco-MiniLM-L6-v2",
    file: "model_quint8_avx2",
  },
  {
    key: "gte-modernbert",
    kind: "better",
    repo: "Alibaba-NLP/gte-reranker-modernbert-base",
    file: "model_quantized",
  },
];

const OFF_TOPIC = [
  "what is the weather in Paris tomorrow",
  "a recipe for carbonara",
  "who won the world cup in 1998",
  "refactor this function to async/await",
  "write a haiku about autumn",
  "how do I train a golden retriever puppy",
  "explain the plot of Hamlet",
  "best hiking boots for wet weather",
  "convert 40 degrees celsius to fahrenheit",
  "what year did the Berlin Wall fall",
];

type Scorer = (query: string, passages: string[]) => Promise<number[]>;

/** A safetensors file's F32 tensors by name. */
async function safetensors(url: string): Promise<Map<string, Float32Array>> {
  const path = join(CACHE, "st-heads", url.replace(/[^\w.-]+/g, "_"));
  if (!existsSync(path)) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    mkdirSync(join(CACHE, "st-heads"), { recursive: true });
    writeFileSync(path, Buffer.from(await response.arrayBuffer()));
  }
  const bytes = readFileSync(path);
  const headerLength = Number(bytes.readBigUInt64LE(0));
  const header = JSON.parse(bytes.subarray(8, 8 + headerLength).toString("utf8")) as Record<
    string,
    { dtype: string; data_offsets: [number, number] }
  >;
  const tensors = new Map<string, Float32Array>();
  for (const [name, t] of Object.entries(header)) {
    if (name === "__metadata__") continue;
    const [from, to] = t.data_offsets;
    const raw = bytes.subarray(8 + headerLength + from, 8 + headerLength + to);
    tensors.set(
      name,
      new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length)),
    );
  }
  return tensors;
}

/** erf by Abramowitz and Stegun 7.1.26, |error| < 1.5e-7: enough for torch's exact GELU. */
function erf(x: number): number {
  const sign = Math.sign(x);
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-a * a);
  return sign * y;
}

/** CLS vector -> Dense(no bias)+GELU -> LayerNorm -> Dense: the Ettin rerankers' head. */
async function stHead(repo: string): Promise<(cls: Float32Array) => number> {
  const base = `https://huggingface.co/${repo}/resolve/main`;
  const w1 = (await safetensors(`${base}/2_Dense/model.safetensors`)).get(
    "linear.weight",
  ) as Float32Array;
  const norm = await safetensors(`${base}/3_LayerNorm/model.safetensors`);
  const g = norm.get("norm.weight") as Float32Array;
  const b = norm.get("norm.bias") as Float32Array;
  const last = await safetensors(`${base}/4_Dense/model.safetensors`);
  const w2 = last.get("linear.weight") as Float32Array;
  const b2 = (last.get("linear.bias") as Float32Array)[0] as number;
  const dim = g.length;
  return (cls) => {
    const h = new Float64Array(dim);
    for (let o = 0; o < dim; o++) {
      let sum = 0;
      for (let i = 0; i < dim; i++) sum += (w1[o * dim + i] as number) * (cls[i] as number);
      h[o] = 0.5 * sum * (1 + erf(sum / Math.SQRT2));
    }
    const mean = h.reduce((s, v) => s + v, 0) / dim;
    const variance = h.reduce((s, v) => s + (v - mean) ** 2, 0) / dim;
    const inv = 1 / Math.sqrt(variance + 1e-5);
    let score = b2;
    for (let i = 0; i < dim; i++) {
      score +=
        (w2[i] as number) * (((h[i] as number) - mean) * inv * (g[i] as number) + (b[i] as number));
    }
    return score;
  };
}

async function loadReranker(spec: Spec): Promise<{ score: Scorer; loadMs: number }> {
  const { AutoTokenizer, AutoModel, AutoModelForSequenceClassification, env } = await import(
    "@huggingface/transformers"
  );
  env.cacheDir = CACHE;
  const started = performance.now();
  const tokenizer = await AutoTokenizer.from_pretrained(spec.repo);
  const options = {
    dtype: "fp32" as const,
    model_file_name: spec.file,
    session_options: { intraOpNumThreads: THREADS, interOpNumThreads: 1 },
  };
  const model = spec.head
    ? await AutoModel.from_pretrained(spec.repo, options)
    : await AutoModelForSequenceClassification.from_pretrained(spec.repo, options);
  const head = spec.head ? await stHead(spec.repo) : undefined;
  const loadMs = performance.now() - started;
  const score: Scorer = async (query, passages) => {
    if (passages.length === 0) return [];
    const inputs = tokenizer(new Array(passages.length).fill(query), {
      text_pair: passages,
      padding: true,
      truncation: true,
      max_length: 512,
    });
    const output = await model(inputs);
    if (head) {
      const hidden = output.last_hidden_state;
      const [, tokens, dim] = hidden.dims as [number, number, number];
      const data = hidden.data as Float32Array;
      return passages.map((_, i) => head(data.subarray(i * tokens * dim, i * tokens * dim + dim)));
    }
    const data = output.logits.data as Float32Array;
    const width = data.length / passages.length;
    // One logit per pair for every model here; with two, the second is "relevant".
    return passages.map((_, i) => data[i * width + width - 1] as number);
  };
  return { score, loadMs };
}

// PAIRS=<file of [query, passage] pairs>: print each reranker's scores for them and stop. Checks a
// head applied here against sentence-transformers' own CrossEncoder.predict on the same pairs.
// FILE=model swaps in the fp32 export, to tell a wrong head from int8 drift.
const only = (process.env.ONLY ?? "").split(",").filter(Boolean);
if (process.env.PAIRS) {
  const pairs = JSON.parse(readFileSync(process.env.PAIRS, "utf8")) as [string, string][];
  for (const spec of SPECS) {
    if (only.length && !only.includes(spec.key)) continue;
    const { score } = await loadReranker({ ...spec, file: process.env.FILE ?? spec.file });
    const scores = [];
    for (const [query, passage] of pairs) scores.push(...(await score(query, [passage])));
    console.log(spec.key, JSON.stringify(scores.map((x) => Number(x.toFixed(4)))));
  }
  process.exit(0);
}

// --- the index, built once with the shipped embedder
const embedder = await createEmbedder({
  embedder: "granite-small",
  modelsDir: join(process.env.HOME ?? "", ".cache/ragdown/models"),
  threads: THREADS,
} as never);
const store = await Store.open(mkdtempSync(join(here, ".rr-")), embedder, true);
const updates = [];
for (const d of docs) {
  const chunks = chunkMarkdown(renderDoc(d, "md"), `${d.slug}.md`);
  updates.push({
    path: d.slug,
    hash: d.slug,
    mtimeMs: 0,
    size: 0,
    chunks,
    vectors: await embedder.embed(chunks.map(embeddingText), "document"),
    supersedes: [],
  });
}
await store.apply(updates, []);
await store.compact();

// Questions with one answering section: the standard set and the two single-document hard types.
const asked = [...questions, ...hardQuestions].filter(
  (q) => q.section && q.doc && q.type !== "unanswerable",
);
const goldOf = (q: (typeof asked)[0]) => {
  const d = docs.find((x) => x.slug === q.doc) as (typeof docs)[0];
  return { path: q.doc, heading: `${d.title} › ${headingPath(d, q.section as string)}` };
};
const maxPool = Math.max(...POOLS);
const pools = new Map<string, Hit[]>();
for (const q of asked) pools.set(q.id, await store.search(q.q, maxPool));
const offPools = new Map<string, Hit[]>();
for (const p of OFF_TOPIC) offPools.set(p, await store.search(p, maxPool));
const unanswerable = questions.filter((q) => q.type === "unanswerable");
for (const q of unanswerable) offPools.set(q.q, await store.search(q.q, maxPool));

const rankOf = (hits: Hit[], gold: { path: string; heading: string }) => {
  const i = hits.findIndex((h) => h.path === gold.path && h.heading === gold.heading);
  return i === -1 ? Infinity : i + 1;
};
const summarize = (ranks: number[]) => ({
  n: ranks.length,
  r1: ranks.filter((r) => r <= 1).length / ranks.length,
  r4: ranks.filter((r) => r <= 4).length / ranks.length,
  r10: ranks.filter((r) => r <= 10).length / ranks.length,
  inPool: ranks.filter((r) => r !== Infinity).length / ranks.length,
  mrr: ranks.reduce((s, r) => s + (r === Infinity ? 0 : 1 / r), 0) / ranks.length,
});
const pct = (xs: number[], p: number) =>
  xs.slice().sort((a, b) => a - b)[Math.floor(p * (xs.length - 1))] ?? 0;
/** Share of (on, off) pairs where the on-topic prompt's best score is higher: ROC AUC. */
const auc = (on: number[], off: number[]) => {
  let wins = 0;
  for (const a of on) for (const b of off) wins += a > b ? 1 : a === b ? 0.5 : 0;
  return wins / (on.length * off.length);
};

const types = [...new Set(asked.map((q) => q.type))];
const report = (ranksById: Map<string, number>) => ({
  overall: summarize(asked.map((q) => ranksById.get(q.id) as number)),
  byType: Object.fromEntries(
    types.map((t) => [
      t,
      summarize(asked.filter((q) => q.type === t).map((q) => ranksById.get(q.id) as number)),
    ]),
  ),
});

// TIMING=1: latency only, every reranker loaded at once and run round-robin per query, so load from
// anything else on the machine lands on all of them alike. Each Ettin model also runs its fp32
// export, to tell a slow architecture from a slow int8 kernel.
if (process.env.TIMING) {
  const pool = Number(process.env.POOL ?? 10);
  const variants = SPECS.filter((spec) => !only.length || only.includes(spec.key)).flatMap(
    (spec) => (spec.head ? [spec, { ...spec, key: `${spec.key}-fp32`, file: "model" }] : [spec]),
  );
  const loaded = [];
  for (const spec of variants) loaded.push({ spec, ...(await loadReranker(spec)) });
  const passages = asked.map((q) =>
    (pools.get(q.id) ?? []).slice(0, pool).map((h) => embeddingText(h)),
  );
  const { timings } = await interleaved(
    loaded.map(
      ({ score }) =>
        (i: number) =>
          score(asked[i % asked.length]?.q ?? "", passages[i % asked.length] ?? []),
    ),
    Number(process.env.ROUNDS ?? 120),
    5,
  );
  const timingPath = join(here, "rerank-timing.json");
  const rows = loaded.map(({ spec, loadMs }, k) => ({
    key: spec.key,
    loadMs: Math.round(loadMs),
    ...timings[k],
  }));
  writeFileSync(timingPath, JSON.stringify({ pool, threads: THREADS, rows }, null, 2));
  for (const row of rows.sort((a, b) => (a.p50 ?? 0) - (b.p50 ?? 0))) {
    console.log(
      `${row.key.padEnd(18)} p50 ${String(row.p50).padStart(8)}ms  p95 ${String(row.p95).padStart(8)}ms  load ${row.loadMs}ms`,
    );
  }
  process.exit(0);
}

// BLEND=1: instead of replacing the fused order with the reranker's, combine the two. Every
// reranker scores each question's pool once (cached in rerank-scores*.json, so a new blend costs no
// model time), then each blend is graded per question type against the fused order alone. A blend
// that keeps a reranker's gains without its regressions is what could ship on by default.
if (process.env.BLEND) {
  const pool = Number(process.env.POOL ?? 10);
  // One cache and one result file per corpus: BENCH_SEED draws a held-out one.
  const suffix = process.env.BENCH_SEED ? `-seed${process.env.BENCH_SEED}` : "";
  const cachePath = join(here, `rerank-scores${suffix}.json`);
  const cache: Record<string, Record<string, number[]>> = existsSync(cachePath)
    ? JSON.parse(readFileSync(cachePath, "utf8"))
    : {};
  const specs = SPECS.filter((spec) => !only.length || only.includes(spec.key));
  for (const spec of specs) {
    const key = `${spec.key}/${pool}`;
    if (cache[key] && asked.every((q) => cache[key]?.[q.id])) continue;
    const { score } = await loadReranker(spec);
    const scores: Record<string, number[]> = {};
    for (const q of asked) {
      scores[q.id] = await score(
        q.q,
        (pools.get(q.id) ?? []).slice(0, pool).map((h) => embeddingText(h)),
      );
    }
    cache[key] = scores;
    writeFileSync(cachePath, JSON.stringify(cache));
    console.log(`scored ${spec.key}`);
  }

  /** Each blend orders a pool from its fused order (index = fused rank - 1) and the reranker's scores. */
  const rankFrom = (scores: number[]) => {
    const order = scores.map((_, i) => i).sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0));
    const rank = new Array<number>(scores.length);
    order.forEach((i, r) => {
      rank[i] = r + 1;
    });
    return rank;
  };
  const minmax = (xs: number[]) => {
    const lo = Math.min(...xs);
    const hi = Math.max(...xs);
    return xs.map((x) => (hi === lo ? 0 : (x - lo) / (hi - lo)));
  };
  type Blend = (hits: Hit[], scores: number[]) => number[];
  const rrf =
    (k: number, w: number): Blend =>
    (_, scores) => {
      const rr = rankFrom(scores);
      return scores.map((_, i) => 1 / (k + i + 1) + w / (k + (rr[i] as number)));
    };
  /** `against`: the fused RRF score, or the chunk's cosine similarity to the query. */
  const linear =
    (alpha: number, against: "score" | "similarity" = "score"): Blend =>
    (hits, scores) => {
      const r = minmax(scores);
      const f = minmax(hits.map((h) => h[against]));
      return scores.map((_, i) => alpha * (r[i] as number) + (1 - alpha) * (f[i] as number));
    };
  const blends: [string, Blend][] = [
    ["replace", (_, scores) => scores],
    ["rrf k60 w1", rrf(60, 1)],
    ["rrf k10 w1", rrf(10, 1)],
    ["rrf k2 w1", rrf(2, 1)],
    ["rrf k10 w2", rrf(10, 2)],
    ["rrf k2 w2", rrf(2, 2)],
    ["linear 0.5", linear(0.5)],
    ["linear 0.7", linear(0.7)],
    ["linear-cos 0.5", linear(0.5, "similarity")],
    ["linear-cos 0.7", linear(0.7, "similarity")],
  ];

  const fusedRanks = new Map(
    asked.map((q) => [q.id, rankOf((pools.get(q.id) ?? []).slice(0, pool), goldOf(q))]),
  );
  const base = report(fusedRanks);
  const fmt = (x: number) => (100 * x).toFixed(1).padStart(5);
  console.log(
    `\n${"".padEnd(28)} first   mrr  ${types.map((t) => t.slice(0, 9).padStart(9)).join(" ")}  worst`,
  );
  console.log(
    `${"fused (shipped)".padEnd(28)} ${fmt(base.overall.r1)} ${base.overall.mrr.toFixed(3)}  ${types.map((t) => fmt(base.byType[t]?.r1 ?? 0).padStart(9)).join(" ")}`,
  );
  const results: Record<string, unknown> = {};
  for (const spec of specs) {
    for (const [name, blend] of blends) {
      const ranks = new Map<string, number>();
      for (const q of asked) {
        const hits = (pools.get(q.id) ?? []).slice(0, pool);
        const scores = cache[`${spec.key}/${pool}`]?.[q.id] ?? [];
        const blended = blend(hits, scores);
        // Ties keep the fused order: a stable sort over the pool as fused returned it.
        const order = hits.map((h, i) => ({ h, s: blended[i] ?? 0 })).sort((a, b) => b.s - a.s);
        ranks.set(
          q.id,
          rankOf(
            order.map((o) => o.h),
            goldOf(q),
          ),
        );
      }
      const r = report(ranks);
      // The largest drop in first-place rate on any question type, against the fused order.
      const worst = Math.min(
        ...types.map((t) => (r.byType[t]?.r1 ?? 0) - (base.byType[t]?.r1 ?? 0)),
      );
      results[`${spec.key}/${name}`] = { ...r, worst };
      console.log(
        `${`${spec.key} ${name}`.padEnd(28)} ${fmt(r.overall.r1)} ${r.overall.mrr.toFixed(3)}  ${types.map((t) => fmt(r.byType[t]?.r1 ?? 0).padStart(9)).join(" ")}  ${fmt(worst)}`,
      );
    }
  }
  writeFileSync(
    join(here, `rerank-blend${suffix}.json`),
    JSON.stringify({ pool, base, results }, null, 2),
  );
  process.exit(0);
}

const outPath = join(here, "rerank.json");
const out: Record<string, unknown> = existsSync(outPath)
  ? JSON.parse(readFileSync(outPath, "utf8"))
  : {};

// Baseline: the fused order as shipped, and the ceiling each pool size sets.
for (const pool of POOLS) {
  const fused = new Map(
    asked.map((q) => [q.id, rankOf((pools.get(q.id) ?? []).slice(0, pool), goldOf(q))]),
  );
  out[`fused/${pool}`] = report(fused);
}
const onCos = asked.map((q) => pools.get(q.id)?.[0]?.similarity ?? 0);
const offCos = [...offPools.values()].map((h) => h[0]?.similarity ?? 0);
out.fusedGate = { auc: auc(onCos, offCos), onP10: pct(onCos, 0.1), offMax: Math.max(...offCos) };
for (const pool of POOLS) {
  const f = out[`fused/${pool}`] as ReturnType<typeof report>;
  console.log(
    `fused (shipped)       r1 ${(100 * f.overall.r1).toFixed(1)}  r4 ${(100 * f.overall.r4).toFixed(1)}  ` +
      `ceiling@${pool} ${(100 * f.overall.inPool).toFixed(1)}  gate AUC ${(out.fusedGate as { auc: number }).auc.toFixed(3)}`,
  );
}

for (const spec of SPECS) {
  if (only.length && !only.includes(spec.key)) continue;
  let reranker: Awaited<ReturnType<typeof loadReranker>>;
  try {
    reranker = await loadReranker(spec);
  } catch (error) {
    console.log(spec.key, "FAILED TO LOAD:", (error as Error).message.slice(0, 300));
    continue;
  }
  const passage = (h: Hit) => embeddingText(h);
  // Warm the session so the first timed query does not pay for allocation.
  for (const q of asked.slice(0, 5)) {
    await reranker.score(q.q, (pools.get(q.id) ?? []).map(passage));
  }
  for (const pool of POOLS) {
    const ranks = new Map<string, number>();
    const ms: number[] = [];
    const bestOn: number[] = [];
    for (const q of asked) {
      const hits = (pools.get(q.id) ?? []).slice(0, pool);
      const started = performance.now();
      const scores = await reranker.score(q.q, hits.map(passage));
      ms.push(performance.now() - started);
      const order = hits
        .map((h, i) => ({ h, s: scores[i] ?? -Infinity }))
        .sort((a, b) => b.s - a.s);
      ranks.set(
        q.id,
        rankOf(
          order.map((o) => o.h),
          goldOf(q),
        ),
      );
      bestOn.push(order[0]?.s ?? -Infinity);
    }
    // Each off-topic prompt and unanswerable question against its own pool.
    const bestOff: number[] = [];
    for (const [prompt, hits] of offPools) {
      const scores = await reranker.score(prompt, hits.slice(0, pool).map(passage));
      bestOff.push(Math.max(...scores));
    }
    const row = {
      kind: spec.kind,
      repo: spec.repo,
      file: spec.file,
      loadMs: Math.round(reranker.loadMs),
      pool,
      msP50: Number(pct(ms, 0.5).toFixed(1)),
      msP95: Number(pct(ms, 0.95).toFixed(1)),
      ...report(ranks),
      gate: { auc: auc(bestOn, bestOff), onP10: pct(bestOn, 0.1), offMax: Math.max(...bestOff) },
    };
    out[`${spec.key}/${pool}`] = row;
    console.log(
      `${spec.key.padEnd(15)} pool ${String(pool).padStart(2)}  p50 ${String(row.msP50).padStart(6)}ms  p95 ${String(row.msP95).padStart(6)}ms  ` +
        `r1 ${(100 * row.overall.r1).toFixed(1)}  r4 ${(100 * row.overall.r4).toFixed(1)}  mrr ${row.overall.mrr.toFixed(3)}  ` +
        `gate AUC ${row.gate.auc.toFixed(3)}`,
    );
    writeFileSync(outPath, JSON.stringify(out, null, 2));
  }
}
writeFileSync(outPath, JSON.stringify(out, null, 2));
