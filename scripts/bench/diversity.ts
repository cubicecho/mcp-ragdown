// Whether search should spread its results over more documents: a cap on the sections of one
// document (`RAGDOWN_MAX_PER_DOCUMENT`, which moves the rest behind the other documents' sections),
// or maximal marginal relevance over the fused pool. The same corpus and the real index, the fusion
// reproduced offline so each variant reorders the same pool. Query sets: the answerable questions,
// each with one right section, and the hard count questions that span documents, each with one right
// section in every document it counts. The hook column runs each top 8 through the hook's own gates,
// re-applying the cap after its cosine sort as `hookContext` does.
//
//   node scripts/bench/diversity.ts
//   BENCH_SEED=42 node scripts/bench/diversity.ts      # a held-out corpus

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { chunkMarkdown, embeddingText } from "../../src/documents/chunk.ts";
import { embedderMinScore } from "../../src/hook/hook-settings.ts";
import { createEmbedder } from "../../src/indexing/embedder.ts";
import { namesSomething } from "../../src/indexing/identifiers.ts";
import { capPerDocument, Store } from "../../src/indexing/store.ts";
import { defaults } from "../../src/shared/defaults.ts";
import { blockAt, docs, hardQuestions, headingPath, questions, renderDoc } from "./gen.ts";

const here = import.meta.dirname;
const LIMIT = 8;
const POOL = Math.max(LIMIT * 4, 20);
const K = defaults.rrfK;

// --- the index, built once with the shipped embedder
const embedder = await createEmbedder({
  embedder: "granite-small",
  modelsDir: join(process.env.HOME ?? "", ".cache/ragdown/models"),
  threads: 4,
} as never);
const dataDir = mkdtempSync(join(here, ".dv-"));
const store = await Store.open(dataDir, embedder, true);
const updates = [];
for (const d of docs) {
  const chunks = chunkMarkdown(renderDoc(d, "md"), d.slug);
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
const db = await lancedb.connect(join(store.dataDir, "lance"));
const table = await db.openTable("chunks");
type Chunk = { id: string; path: string; heading: string; vector: Float32Array };
const chunks = (
  (await table.query().select(["id", "path", "heading", "vector"]).toArray()) as {
    id: string;
    path: string;
    heading: string;
    vector: ArrayLike<number>;
  }[]
).map((row) => ({ ...row, vector: Float32Array.from(row.vector) })) as Chunk[];
const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
const chunkOf = (id: string) => byId.get(id) as Chunk;
const pathOf = (id: string) => chunkOf(id).path;
const cos = (a: Float32Array, b: Float32Array) => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return dot / Math.sqrt(na * nb);
};

// --- the queries: one right section, or one in each document a count question spans
type Gold = { path: string; heading: string }[];
type Query = { q: string; multi: boolean; gold: Gold };
const queries: Query[] = [];
for (const q of [...questions, ...hardQuestions]) {
  if (!q.section || !q.doc || q.type === "unanswerable") continue;
  const d = docs.find((x) => x.slug === q.doc);
  if (!d) continue;
  queries.push({
    q: q.q,
    multi: false,
    gold: [{ path: q.doc, heading: `${d.title} › ${headingPath(d, q.section)}` }],
  });
}
const facts = docs.map((d) => ({
  d,
  team: (blockAt(d, 0, 0, "p") as unknown as { c: { v: string }[] }).c[1]?.v ?? "",
  deps: (blockAt(d, 4, 0, "deps") as unknown as { items: { name: string }[] }).items.map(
    (x) => x.name,
  ),
}));
for (const q of hardQuestions) {
  if (q.type !== "count-table" && q.type !== "count-list") continue;
  const spans =
    q.type === "count-table"
      ? facts.filter((x) => q.q.includes(`the ${x.team} team`))
      : facts.filter((x) => x.deps.some((dep) => q.q.includes(` list ${dep} `)));
  if (spans.length < 2) continue;
  queries.push({
    q: q.q,
    multi: true,
    gold: spans.map((x) => ({
      path: x.d.slug,
      heading: `${x.d.title} › ${headingPath(x.d, q.section as string)}`,
    })),
  });
}

// --- the fused pool, as `store.search` builds it
type Fused = { query: Query; vector: Float32Array; ids: string[]; score: Map<string, number> };
const normalise = (xs: number[]) => {
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  return xs.map((x) => (hi > lo ? (x - lo) / (hi - lo) : 1));
};
const fused: Fused[] = [];
let reproduced = 0;
for (const query of queries) {
  const [vector] = (await embedder.embed([query.q], "query")) as Float32Array[];
  const dense = (await table
    .vectorSearch(vector as Float32Array)
    .distanceType("cosine")
    .select(["id", "_distance"])
    .limit(POOL)
    .toArray()) as { id: string; _distance: number }[];
  let lexical: { id: string; _score: number }[] = [];
  try {
    lexical = (await table
      .search(query.q, "fts", "search_text")
      .select(["id"])
      .limit(POOL)
      .toArray()) as typeof lexical;
  } catch {}
  const score = new Map<string, number>();
  const add = (id: string, x: number) => score.set(id, (score.get(id) ?? 0) + x);
  if (namesSomething(query.q)) {
    const w = defaults.namedQueryDenseWeight;
    const d = normalise(dense.map((r) => 1 - r._distance));
    const l = normalise(lexical.map((r) => r._score));
    for (const [i, r] of dense.entries()) add(r.id, w * (d[i] as number));
    for (const [i, r] of lexical.entries()) add(r.id, (1 - w) * (l[i] as number));
  } else {
    for (const [i, r] of dense.entries()) add(r.id, 1 / (K + i + 1));
    for (const [i, r] of lexical.entries()) add(r.id, 1 / (K + i + 1));
  }
  const ids = [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  const shipped = (await store.search(query.q, LIMIT)).map((hit) => hit.id);
  if (ids.slice(0, LIMIT).join() === shipped.join()) reproduced++;
  fused.push({ query, vector: vector as Float32Array, ids, score });
}

// --- the variants: each a top 8 from the same pool, and the cap the hook re-applies
type Variant = { top: (f: Fused) => string[]; hookCap: number };
const cap = (n: number): Variant => ({
  top: (f) => capPerDocument(f.ids, n, pathOf).slice(0, LIMIT),
  hookCap: n,
});
const mmr = (lambda: number): Variant => ({
  top: (f) => {
    const relevance = new Map(
      f.ids.map((id, i) => [
        id,
        normalise(f.ids.map((x) => f.score.get(x) as number))[i] as number,
      ]),
    );
    const left = [...f.ids];
    const out: string[] = [];
    while (out.length < LIMIT && left.length > 0) {
      let best = 0;
      let bestValue = Number.NEGATIVE_INFINITY;
      left.forEach((id, i) => {
        const redundancy = Math.max(
          0,
          ...out.map((o) => cos(chunkOf(id).vector, chunkOf(o).vector)),
        );
        const value = lambda * (relevance.get(id) as number) - (1 - lambda) * redundancy;
        if (value > bestValue) {
          bestValue = value;
          best = i;
        }
      });
      out.push(left.splice(best, 1)[0] as string);
    }
    return out;
  },
  hookCap: 0,
});
const variants: Record<string, Variant> = {
  none: cap(0),
  "cap 1": cap(1),
  "cap 2": cap(2),
  "cap 3": cap(3),
  "mmr 0.9": mmr(0.9),
  "mmr 0.7": mmr(0.7),
  "mmr 0.5": mmr(0.5),
};

const minScore = embedderMinScore("granite-small") ?? 0;
const hook = (ids: string[], f: Fused, perDocument: number) => {
  const ranked = ids
    .slice(0, defaults.hookTopK * 2)
    .map((id) => ({ id, similarity: cos(f.vector, chunkOf(id).vector) }))
    .filter((hit) => hit.similarity >= minScore)
    .sort((a, b) => b.similarity - a.similarity);
  const best = ranked[0]?.similarity ?? 0;
  return capPerDocument(
    ranked.filter((hit) => hit.similarity >= best * defaults.hookMinRatio),
    perDocument,
    (hit) => pathOf(hit.id),
  )
    .slice(0, defaults.hookTopK)
    .map((hit) => hit.id);
};
const isGold = (id: string, gold: Gold) =>
  gold.some((g) => g.path === chunkOf(id).path && g.heading === chunkOf(id).heading);
const goldDocs = (ids: string[], gold: Gold) =>
  new Set(ids.filter((id) => isGold(id, gold)).map(pathOf)).size;

const single = fused.filter((f) => !f.query.multi);
const multi = fused.filter((f) => f.query.multi);
const pct = (x: number, n: number) => ((100 * x) / n).toFixed(1).padStart(6);
console.log(
  `${fused.length} queries (${single.length} single, ${multi.length} across documents) · fusion reproduces store.search top ${LIMIT}: ${reproduced}/${fused.length}`,
);
console.log(
  "\n                 one right section                          across documents          all",
);
console.log(
  "variant       first   top4   top8   hook  other/q     docs top4  top8  hook/q     distinct docs",
);
for (const [name, variant] of Object.entries(variants)) {
  let first = 0;
  let top4 = 0;
  let top8 = 0;
  let injected = 0;
  let other = 0;
  for (const f of single) {
    const ids = variant.top(f);
    const rank = ids.findIndex((id) => isGold(id, f.query.gold));
    if (rank === 0) first++;
    if (rank >= 0 && rank < 4) top4++;
    if (rank >= 0) top8++;
    const block = hook(ids, f, variant.hookCap);
    if (block.some((id) => isGold(id, f.query.gold))) injected++;
    other += block.filter((id) => !isGold(id, f.query.gold)).length;
  }
  let docs4 = 0;
  let docs8 = 0;
  let possible4 = 0;
  let possible8 = 0;
  let docsHook = 0;
  for (const f of multi) {
    const ids = variant.top(f);
    docs4 += goldDocs(ids.slice(0, 4), f.query.gold);
    docs8 += goldDocs(ids, f.query.gold);
    possible4 += Math.min(4, f.query.gold.length);
    possible8 += Math.min(LIMIT, f.query.gold.length);
    docsHook += goldDocs(hook(ids, f, variant.hookCap), f.query.gold);
  }
  const distinct = fused.reduce((sum, f) => sum + new Set(variant.top(f).map(pathOf)).size, 0);
  console.log(
    `${name.padEnd(12)} ${pct(first, single.length)} ${pct(top4, single.length)} ${pct(top8, single.length)} ${pct(injected, single.length)} ${(other / single.length).toFixed(2).padStart(8)}   ` +
      `${pct(docs4, possible4)} ${pct(docs8, possible8)} ${(docsHook / multi.length).toFixed(2).padStart(7)}   ${(distinct / fused.length).toFixed(2).padStart(15)}`,
  );
}
rmSync(dataDir, { recursive: true, force: true });
