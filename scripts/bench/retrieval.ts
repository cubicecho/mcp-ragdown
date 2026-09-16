// Retrieval benchmark: ragdown's real Store (LanceDB FTS + bge-small, RRF) per format.
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Chunk, chunkMarkdown, embeddingText } from "../../src/chunk.ts";
import { createEmbedder } from "../../src/embedder.ts";
import { Store } from "../../src/store.ts";
import { docs, type Fmt, FORMATS, questions, renderBlocks, renderDoc } from "./gen.ts";

const here = import.meta.dirname;
const modelsDir = join(process.env.HOME ?? "", ".cache/ragdown-bench-models");
const embedder = await createEmbedder({ embedder: "bge-small", modelsDir, threads: 0 } as never);
const { AutoTokenizer } = await import("@huggingface/transformers");
const tok = await AutoTokenizer.from_pretrained("Xenova/bge-small-en-v1.5");
const ntok = (s: string) => (tok.encode(s) as number[]).length;

const chunksFor = (f: Fmt) =>
  docs.map((d) => {
    let chunks: (Chunk & { key: string })[];
    if (f === "md") {
      const md = chunkMarkdown(renderDoc(d, "md"), `${d.slug}.md`);
      if (md.length !== d.sections.length) throw new Error(`md chunk mismatch ${d.slug}`);
      chunks = md.map((c, i) => ({ ...c, key: d.sections[i]?.key as string }));
    } else {
      chunks = d.sections.map((s, i) => ({
        index: i,
        title: d.title,
        heading: `${d.title} › ${s.path.join(" › ")}`,
        text: renderBlocks(s.blocks, f),
        lineStart: 0,
        lineEnd: 0,
        key: s.key,
      }));
    }
    return { d, chunks };
  });

const results: Record<string, unknown> = {};
const retrieved: Record<
  string,
  Record<string, { path: string; heading: string; text: string }[]>
> = {};

for (const f of FORMATS) {
  const sets = chunksFor(f);
  const all = sets.flatMap((s) => s.chunks.map((c) => ({ path: s.d.slug, ...c })));
  const toks = all.map((c) => ntok(embeddingText(c)));
  const store = await Store.open(mkdtempSync(join(here, `.lance-${f}-`)), embedder, true);
  const t0 = Date.now();
  const updates = [];
  for (const s of sets) {
    const vectors = await embedder.embed(s.chunks.map(embeddingText), "document");
    updates.push({
      path: s.d.slug,
      hash: `${f}${s.d.slug}`,
      mtimeMs: 0,
      size: 0,
      chunks: s.chunks,
      vectors,
      supersedes: [],
    });
  }
  if (process.env.CTX)
    for (const u of updates) u.chunks = u.chunks.map((c) => ({ ...c, text: embeddingText(c) }));
  await store.apply(updates, []);
  await store.compact();
  const indexMs = Date.now() - t0;

  // biome-ignore lint: reach the private table for single-retriever ranks
  const table = (store as any).table;
  const rankOf = (rows: { path: string; heading: string }[], q: (typeof questions)[0]) => {
    const d = docs.find((x) => x.slug === q.doc);
    const gold = `${d?.title} › ${d?.sections.find((s) => s.key === q.section)?.path.join(" › ")}`;
    const r = rows.findIndex((h) => h.path === q.doc && h.heading === gold);
    return r === -1 ? Infinity : r + 1;
  };
  const per: { type: string; hybrid: number; dense: number; lexical: number }[] = [];
  retrieved[f] = {};
  for (const q of questions) {
    const hits = await store.search(q.q, 10);
    retrieved[f][q.id] = hits
      .slice(0, 5)
      .map((h) => ({ path: h.path, heading: h.heading, text: h.text }));
    if (!q.section) continue;
    const [qv] = await embedder.embed([q.q], "query");
    const dense = await table.vectorSearch(qv).distanceType("cosine").limit(10).toArray();
    let lexical = [];
    try {
      lexical = await table.search(q.q, "fts", "text").limit(10).toArray();
    } catch {}
    per.push({
      type: q.type,
      hybrid: rankOf(hits, q),
      dense: rankOf(dense, q),
      lexical: rankOf(lexical, q),
    });
  }
  const agg = (rows: typeof per) => {
    const m = (k: "hybrid" | "dense" | "lexical") => ({
      r1: rows.filter((r) => r[k] <= 1).length / rows.length,
      r3: rows.filter((r) => r[k] <= 3).length / rows.length,
      r5: rows.filter((r) => r[k] <= 5).length / rows.length,
      mrr: rows.reduce((n, r) => n + (r[k] === Infinity ? 0 : 1 / r[k]), 0) / rows.length,
    });
    return { hybrid: m("hybrid"), dense: m("dense"), lexical: m("lexical") };
  };
  const byType = Object.fromEntries(
    [...new Set(per.map((p) => p.type))].map((t) => [t, agg(per.filter((p) => p.type === t))]),
  );
  results[f] = {
    chunks: all.length,
    corpusChars: docs.reduce((n, d) => n + renderDoc(d, f).length, 0),
    chunkChars: all.reduce((n, c) => n + c.text.length, 0),
    embedTokensMean: toks.reduce((a, b) => a + b, 0) / toks.length,
    embedTokensMax: Math.max(...toks),
    truncatedChunks: toks.filter((t) => t > 512).length,
    corpusBgeTokens: docs.reduce((n, d) => n + ntok(renderDoc(d, f)), 0),
    indexMs,
    overall: agg(per),
    byType,
  };
  console.log(f, JSON.stringify(results[f], null, 1).slice(0, 1500));
}
writeFileSync(
  join(here, process.env.CTX ? "retrieval-ctx.json" : "retrieval.json"),
  JSON.stringify(results, null, 2),
);
writeFileSync(
  join(here, process.env.CTX ? "retrieved-ctx.json" : "retrieved.json"),
  JSON.stringify(retrieved),
);
