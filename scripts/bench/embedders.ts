// Same corpus, same chunks, same questions — only the embedding model changes.
// Each model is run with the shipped breadcrumb text (A) and with the selective context (E1).
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { type Chunk, chunkMarkdown, embeddingText } from "../../src/chunk.ts";
import type { Embedder } from "../../src/embedder.ts";
import { Store } from "../../src/store.ts";
import { docs, questions, renderDoc } from "./gen.ts";

const here = import.meta.dirname;
const CACHE = join(process.env.HOME ?? "", ".cache/ragdown-bench-models");

interface Spec {
  key: string;
  repo: string;
  dtype: "q8" | "fp32" | "q4" | "fp16";
  pooling: "cls" | "mean";
  /** Prepended to a query; passages get `docPrefix`. Asymmetric models need both. */
  queryPrefix: string;
  docPrefix: string;
}

const SPECS: Spec[] = [
  {
    key: "bge-small-q8",
    repo: "Xenova/bge-small-en-v1.5",
    dtype: "q8",
    pooling: "cls",
    queryPrefix: "Represent this sentence for searching relevant passages: ",
    docPrefix: "",
  },
  {
    key: "granite-r2-small",
    repo: "onnx-community/granite-embedding-small-english-r2-ONNX",
    dtype: "q8",
    pooling: "cls",
    queryPrefix: "",
    docPrefix: "",
  },
  {
    key: "arctic-embed-s",
    repo: "Snowflake/snowflake-arctic-embed-s",
    dtype: "q8",
    pooling: "cls",
    queryPrefix: "Represent this sentence for searching relevant passages: ",
    docPrefix: "",
  },
  {
    key: "gte-small",
    repo: "Xenova/gte-small",
    dtype: "q8",
    pooling: "mean",
    queryPrefix: "",
    docPrefix: "",
  },
  {
    key: "mxbai-xsmall",
    repo: "mixedbread-ai/mxbai-embed-xsmall-v1",
    dtype: "q8",
    pooling: "mean",
    queryPrefix: "",
    docPrefix: "",
  },
  {
    key: "embeddinggemma-300m",
    repo: "onnx-community/embeddinggemma-300m-ONNX",
    dtype: "q8",
    pooling: "mean",
    queryPrefix: "task: search result | query: ",
    docPrefix: "title: none | text: ",
  },
  // Bigger, 768-dimensional: the accuracy-for-speed end of the table.
  {
    key: "granite-r2-base",
    repo: "onnx-community/granite-embedding-english-r2-ONNX",
    dtype: "q8",
    pooling: "cls",
    queryPrefix: "",
    docPrefix: "",
  },
  {
    key: "bge-base",
    repo: "Xenova/bge-base-en-v1.5",
    dtype: "q8",
    pooling: "cls",
    queryPrefix: "Represent this sentence for searching relevant passages: ",
    docPrefix: "",
  },
  {
    key: "arctic-m-v1.5",
    repo: "Snowflake/snowflake-arctic-embed-m-v1.5",
    dtype: "q8",
    pooling: "cls",
    queryPrefix: "Represent this sentence for searching relevant passages: ",
    docPrefix: "",
  },
];

const only = (process.env.ONLY ?? "").split(",").filter(Boolean);

class OnnxEmbedder implements Embedder {
  readonly name: string;
  dim = 0;
  private extract: (
    texts: string[],
    o: { pooling: "cls" | "mean"; normalize: boolean },
  ) => Promise<{ data: Float32Array }>;
  private spec: Spec;
  /** Wall-clock milliseconds spent in the forward pass, for the cost column. */
  ms = 0;

  private constructor(spec: Spec, extract: OnnxEmbedder["extract"]) {
    this.spec = spec;
    this.name = spec.key;
    this.extract = extract;
  }

  static async load(spec: Spec): Promise<OnnxEmbedder> {
    const { pipeline, env } = await import("@huggingface/transformers");
    env.cacheDir = CACHE;
    const extract = await pipeline("feature-extraction", spec.repo, {
      dtype: spec.dtype,
      session_options: {
        intraOpNumThreads: Math.max(1, Math.floor(availableParallelism() / 2)),
        interOpNumThreads: 1,
      },
    });
    const e = new OnnxEmbedder(spec, extract as unknown as OnnxEmbedder["extract"]);
    const [probe] = await e.embed(["probe"], "document");
    e.dim = probe?.length ?? 0;
    return e;
  }

  async embed(texts: string[], kind: "query" | "document"): Promise<Float32Array[]> {
    const prefix = kind === "query" ? this.spec.queryPrefix : this.spec.docPrefix;
    const inputs = texts.map((t) => prefix + t);
    const order = inputs
      .map((_, i) => i)
      .sort((a, b) => (inputs[a]?.length ?? 0) - (inputs[b]?.length ?? 0));
    const out = new Array<Float32Array>(inputs.length);
    const started = performance.now();
    for (let i = 0; i < order.length; i += 16) {
      const idx = order.slice(i, i + 16);
      const tensor = await this.extract(
        idx.map((j) => inputs[j] ?? ""),
        { pooling: this.spec.pooling, normalize: true },
      );
      const dim = tensor.data.length / idx.length;
      idx.forEach((j, row) => {
        out[j] = tensor.data.slice(row * dim, (row + 1) * dim);
      });
    }
    this.ms += performance.now() - started;
    return out;
  }
}

// --- the two chunk-text variants, as in selective.ts
const leaf = (h: string) => h.split(" › ").pop() ?? "";
const parentOf = (h: string) => h.split(" › ").slice(0, -1).join(" › ");
function hasSiblings(chunk: Chunk, all: Chunk[]): boolean {
  const parent = parentOf(chunk.heading);
  if (!parent) return false;
  return (
    new Set(all.filter((c) => parentOf(c.heading) === parent).map((c) => leaf(c.heading))).size > 1
  );
}
function textFor(variant: string, c: Chunk, all: Chunk[]): string {
  if (variant === "E1" && hasSiblings(c, all)) return `${c.text}\n\n(${leaf(c.heading)})`;
  return c.text;
}

const answerable = questions.filter((q) => q.section);
const chunkSets = new Map(
  docs.map((d) => [d.slug, chunkMarkdown(renderDoc(d, "md"), `${d.slug}.md`)]),
);
const outPath = join(here, "embedders.json");
// Merged, so a second pass over a few models keeps the rows the first pass measured.
const out: Record<string, unknown> = existsSync(outPath)
  ? JSON.parse(readFileSync(outPath, "utf8"))
  : {};

for (const spec of SPECS) {
  if (only.length && !only.includes(spec.key)) continue;
  let embedder: OnnxEmbedder;
  try {
    embedder = await OnnxEmbedder.load(spec);
  } catch (e) {
    console.log(spec.key, "FAILED TO LOAD:", (e as Error).message.slice(0, 200));
    continue;
  }
  for (const variant of ["A", "E1"]) {
    embedder.ms = 0;
    const store = await Store.open(
      mkdtempSync(join(here, `.em-${spec.key}-${variant}-`)),
      embedder,
      true,
    );
    const updates = [];
    for (const d of docs) {
      const base = chunkSets.get(d.slug) as Chunk[];
      const chunks = base.map((c) => ({ ...c, text: textFor(variant, c, base) }));
      const vectors = await embedder.embed(chunks.map(embeddingText), "document");
      updates.push({
        path: d.slug,
        hash: `${spec.key}${variant}${d.slug}`,
        mtimeMs: 0,
        size: 0,
        chunks,
        vectors,
        supersedes: [],
      });
    }
    await store.apply(updates, []);
    await store.compact();
    const indexMs = embedder.ms;
    // biome-ignore lint: private table, for single-retriever ranks
    const table = (store as any).table;
    const rows: { type: string; hybrid: number; dense: number }[] = [];
    embedder.ms = 0;
    for (const q of answerable) {
      const d = docs.find((x) => x.slug === q.doc) as (typeof docs)[0];
      const gold = `${d.title} › ${d.sections.find((s) => s.key === q.section)?.path.join(" › ")}`;
      const rank = (rs: { path: string; heading: string }[]) => {
        const i = rs.findIndex((h) => h.path === q.doc && h.heading === gold);
        return i === -1 ? Infinity : i + 1;
      };
      const [qv] = await embedder.embed([q.q], "query");
      rows.push({
        type: q.type,
        hybrid: rank(await store.search(q.q, 10)),
        dense: rank(await table.vectorSearch(qv).distanceType("cosine").limit(10).toArray()),
      });
    }
    const agg = (rs: typeof rows) => {
      const m = (k: "hybrid" | "dense") => ({
        r1: rs.filter((r) => r[k] <= 1).length / rs.length,
        r5: rs.filter((r) => r[k] <= 5).length / rs.length,
        mrr: rs.reduce((n, r) => n + (r[k] === Infinity ? 0 : 1 / r[k]), 0) / rs.length,
      });
      return { hybrid: m("hybrid"), dense: m("dense") };
    };
    const o = {
      dim: embedder.dim,
      indexMs: Math.round(indexMs),
      queryMs: Number((embedder.ms / answerable.length).toFixed(2)),
      overall: agg(rows),
      byType: Object.fromEntries(
        [...new Set(rows.map((r) => r.type))].map((t) => [
          t,
          agg(rows.filter((r) => r.type === t)),
        ]),
      ),
      hits: rows.map((r) => r.hybrid <= 1),
    };
    out[`${spec.key}/${variant}`] = o;
    console.log(
      `${spec.key.padEnd(20)} ${variant}  dim ${o.dim}  index ${(indexMs / 1000).toFixed(1)}s  q ${o.queryMs}ms  ` +
        `hybrid r1 ${(100 * o.overall.hybrid.r1).toFixed(1)} r5 ${(100 * o.overall.hybrid.r5).toFixed(1)} mrr ${o.overall.hybrid.mrr.toFixed(3)}  ` +
        `dense r1 ${(100 * o.overall.dense.r1).toFixed(1)}`,
    );
    writeFileSync(outPath, JSON.stringify(out, null, 2));
  }
}
