// How dense and BM25 are combined, and how BM25 tokenizes. The same corpus, the default embedder and
// the real index, with the two retrievers run separately (pool 32, as the hook's `limit 8` asks for)
// and their lists fused offline by each method:
//
//   - RRF k=60, the shipped fusion, and RRF with the lexical side weighted up;
//   - relative score fusion (RSF): each side's scores min-max normalised over its own list, absent
//     counts as 0, weighted sum. `rsf-cos` takes the dense side from cosine over every candidate
//     instead, since a lexical-only row's cosine is known anyway;
//   - distribution-based score fusion (DBSF): each side normalised by its mean ± 3σ;
//   - routed: a query that looks like it holds an identifier (backticks, snake_case, a dotted or
//     slashed name, a flag, camelCase, a hyphenated name with a digit) leans on BM25.
//
// Tokenizer variants are each their own small FTS table over the same `search_text`. The first,
// `default`, is the shipped `Index.fts()`, and which explicit variant ranks identically to it says
// what that default is.
//
// Query sets: the 270 answerable questions; identifier probes, identifier-shaped tokens that
// occur in exactly one chunk, asked inside a sentence. Ranks are what `ragdown_recall` returns; the
// hook column runs the fused top 8 through `hookContext`'s own gates, which re-sort by cosine.
//
//   node scripts/bench/fusion.ts
//   BENCH_SEED=42 node scripts/bench/fusion.ts      # a held-out corpus
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { chunkMarkdown, embeddingText } from "../../src/documents/chunk.ts";
import { embedderMinScore } from "../../src/hook/hook-settings.ts";
import { createEmbedder } from "../../src/indexing/embedder.ts";
import { Store } from "../../src/indexing/store.ts";
import { defaults } from "../../src/shared/defaults.ts";
import { docs, hardQuestions, headingPath, questions, renderDoc } from "./gen.ts";

const here = import.meta.dirname;
const POOL = 32;
const suffix = process.env.BENCH_SEED ? `-seed${process.env.BENCH_SEED}` : "";

// --- the index, built once with the shipped embedder
const embedder = await createEmbedder({
  embedder: "granite-small",
  modelsDir: join(process.env.HOME ?? "", ".cache/ragdown/models"),
  threads: Number(process.env.THREADS ?? 4),
} as never);
const store = await Store.open(mkdtempSync(join(here, ".fu-")), embedder, true);
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

const db = await lancedb.connect(join(store.dataDir, "lance"), { readConsistencyInterval: 0 });
const table = await db.openTable("chunks");
interface Chunk {
  id: string;
  path: string;
  heading: string;
  search_text: string;
  vector: Float32Array;
}
const chunks = (
  (await table.query().select(["id", "path", "heading", "search_text", "vector"]).toArray()) as {
    id: string;
    path: string;
    heading: string;
    search_text: string;
    vector: ArrayLike<number>;
  }[]
).map((r) => ({ ...r, vector: Float32Array.from(r.vector) })) as Chunk[];
const byId = new Map(chunks.map((c) => [c.id, c]));

// --- tokenizer variants, one FTS table each
const TOKENIZERS: Record<string, Partial<lancedb.FtsOptions>> = {
  default: {},
  plain: { stem: false, removeStopWords: false, asciiFolding: false },
  stem: { stem: true, removeStopWords: false, language: "English" },
  stop: { stem: false, removeStopWords: true, language: "English" },
  "stem+stop": { stem: true, removeStopWords: true, language: "English" },
};
const ftsTables = new Map<string, lancedb.Table>();
for (const [name, options] of Object.entries(TOKENIZERS)) {
  const t = await db.createTable(
    `fts_${name.replace(/\W/g, "_")}`,
    chunks.map((c) => ({ id: c.id, search_text: c.search_text })),
  );
  await t.createIndex("search_text", { config: lancedb.Index.fts(options) });
  ftsTables.set(name, t);
}

// --- queries
const IDENT =
  /`[^`]+`|[\p{L}\p{N}]+(?:[_./:=][\p{L}\p{N}]+)+|\p{Ll}+\p{Lu}[\p{L}\p{N}]*|(?:^|\s)--?\p{L}[\w-]*|[\p{L}\p{N}]*(?:\p{L}\d|\d\p{L})[\p{L}\p{N}]*|[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+){2,}|[\p{L}\p{N}]*\d[\p{L}\p{N}]*-[\p{L}\p{N}-]+|[\p{L}\p{N}]+-[\p{L}\p{N}]*\d[\p{L}\p{N}]*/u;
const looksLikeIdentifier = (q: string) => IDENT.test(q);

interface Query {
  id: string;
  q: string;
  set: "questions" | "ident";
  type: string;
  /** A chunk id, or a section as `path` + breadcrumb heading. */
  gold: { id: string } | { path: string; heading: string };
}
const queries: Query[] = [];
for (const q of [...questions, ...hardQuestions]) {
  if (!q.section || !q.doc || q.type === "unanswerable") continue;
  const d = docs.find((x) => x.slug === q.doc) as (typeof docs)[0];
  queries.push({
    id: q.id,
    q: q.q,
    set: "questions",
    type: q.type,
    gold: { path: q.doc, heading: `${d.title} › ${headingPath(d, q.section as string)}` },
  });
}
// Probes: a token found in exactly one chunk is that chunk's identifier by construction.
const lower = chunks.map((c) => c.search_text.toLowerCase());
const onlyIn = (token: string) => {
  const t = token.toLowerCase();
  const hits = lower.flatMap((s, i) => (s.includes(t) ? [i] : []));
  return hits.length === 1 ? hits[0] : undefined;
};
const seen = new Set<string>();
for (const [i, c] of chunks.entries()) {
  const words = c.search_text
    .split(/\s+/)
    .map((w) => w.replace(/^[`("'[]+|[`)"',.:;?!\]]+$/g, ""))
    .filter((w) => w.length >= 4 && !seen.has(w.toLowerCase()));
  const ident = words.find(
    (w) => /^[\p{L}\p{N}_.\-/:=]+$/u.test(w) && looksLikeIdentifier(w) && onlyIn(w) === i,
  );
  if (ident) {
    seen.add(ident.toLowerCase());
    queries.push({
      id: `ident-${i}`,
      q: `where is \`${ident}\` used?`,
      set: "ident",
      type: "ident",
      gold: { id: c.id },
    });
  }
}

// --- the two retrievers, run once per query
const cosine = (a: Float32Array, b: Float32Array) => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] as number) * (b[i] as number);
    na += (a[i] as number) ** 2;
    nb += (b[i] as number) ** 2;
  }
  return dot / Math.sqrt(na * nb);
};
interface Scored {
  id: string;
  score: number;
}
interface Retrieved {
  query: Query;
  qv: Float32Array;
  dense: Scored[];
  lex: Map<string, Scored[]>;
  shipped: string[];
}
const retrieved: Retrieved[] = [];
for (const query of queries) {
  const [qv] = await embedder.embed([query.q], "query");
  const denseRows = (await table
    .vectorSearch(qv as Float32Array)
    .distanceType("cosine")
    .select(["id", "_distance"])
    .limit(POOL)
    .toArray()) as { id: string; _distance: number }[];
  const lex = new Map<string, Scored[]>();
  for (const [name, t] of ftsTables) {
    let rows: { id: string; _score: number }[] = [];
    if (/[\p{L}\p{N}]/u.test(query.q)) {
      try {
        rows = (await t.search(query.q, "fts", "search_text").limit(POOL).toArray()) as never;
      } catch {
        // The parser rejected it; dense only, as the store does.
      }
    }
    lex.set(
      name,
      rows.map((r) => ({ id: r.id, score: r._score })),
    );
  }
  retrieved.push({
    query,
    qv: qv as Float32Array,
    dense: denseRows.map((r) => ({ id: r.id, score: 1 - r._distance })),
    lex,
    shipped: (await store.search(query.q, 8)).map((h) => h.id),
  });
}

// --- fusions
type Fusion = (r: Retrieved, lex: Scored[]) => string[];
// A stable sort over insertion order (dense first, then lexical-only), as `store.search` ties.
const order = (acc: Map<string, number>) =>
  [...acc.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
const rrf =
  (k: number, lexWeight: number): Fusion =>
  (r, lex) => {
    const acc = new Map<string, number>();
    for (const [i, s] of r.dense.entries()) acc.set(s.id, (acc.get(s.id) ?? 0) + 1 / (k + i + 1));
    for (const [i, s] of lex.entries()) {
      acc.set(s.id, (acc.get(s.id) ?? 0) + lexWeight / (k + i + 1));
    }
    return order(acc);
  };
const minmax = (xs: Scored[]) => {
  const lo = Math.min(...xs.map((x) => x.score));
  const hi = Math.max(...xs.map((x) => x.score));
  return new Map(xs.map((x) => [x.id, hi > lo ? (x.score - lo) / (hi - lo) : 1]));
};
const dist = (xs: Scored[]) => {
  const mean = xs.reduce((s, x) => s + x.score, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x.score - mean) ** 2, 0) / xs.length) || 1;
  return new Map(xs.map((x) => [x.id, (x.score - (mean - 3 * sd)) / (6 * sd)]));
};
const weighted = (dense: Map<string, number>, lex: Map<string, number>, alpha: number) => {
  const acc = new Map<string, number>();
  for (const id of new Set([...dense.keys(), ...lex.keys()])) {
    acc.set(id, alpha * (dense.get(id) ?? 0) + (1 - alpha) * (lex.get(id) ?? 0));
  }
  return order(acc);
};
const rsf =
  (alpha: number): Fusion =>
  (r, lex) =>
    weighted(minmax(r.dense), minmax(lex), alpha);
const rsfCos =
  (alpha: number): Fusion =>
  (r, lex) => {
    const ids = new Set([...r.dense.map((s) => s.id), ...lex.map((s) => s.id)]);
    const cos = [...ids].map((id) => ({
      id,
      score: cosine(r.qv, (byId.get(id) as Chunk).vector),
    }));
    return weighted(minmax(cos), minmax(lex), alpha);
  };
const dbsf: Fusion = (r, lex) => weighted(dist(r.dense), lex.length ? dist(lex) : new Map(), 0.5);
const routed =
  (plain: Fusion, ident: Fusion): Fusion =>
  (r, lex) =>
    (looksLikeIdentifier(r.query.q) ? ident : plain)(r, lex);

const FUSIONS: Record<string, Fusion> = {
  "rrf k60 (shipped)": rrf(60, 1),
  "rrf k60 lex×2": rrf(60, 2),
  "rsf 0.3": rsf(0.3),
  "rsf 0.5": rsf(0.5),
  "rsf 0.7": rsf(0.7),
  "rsf-cos 0.5": rsfCos(0.5),
  "rsf-cos 0.7": rsfCos(0.7),
  dbsf: dbsf,
  "routed rrf lex×2": routed(rrf(60, 1), rrf(60, 2)),
  "routed rrf lex×3": routed(rrf(60, 1), rrf(60, 3)),
  "routed rsf 0.5/0.3": routed(rsf(0.5), rsf(0.3)),
  "routed rsf-cos 0.7/0.5": routed(rsfCos(0.7), rsfCos(0.5)),
  "routed rrf / rsf 0.3": routed(rrf(60, 1), rsf(0.3)),
  "routed rrf / rsf 0.2": routed(rrf(60, 1), rsf(0.2)),
};

// --- scoring
const rankOf = (ids: string[], gold: Query["gold"]) => {
  const i = ids.findIndex((id) => {
    if ("id" in gold) return id === gold.id;
    const c = byId.get(id) as Chunk;
    return c.path === gold.path && c.heading === gold.heading;
  });
  return i === -1 ? Infinity : i + 1;
};
// The hook as `hookContext` runs it: the top 8 of the fused order, re-sorted by cosine, gated on
// the model's floor and then on a ratio of the best, top 4. Fusion only decides the candidates.
const MIN_SCORE = embedderMinScore("granite-small");
const injected = (ids: string[], qv: Float32Array) => {
  const ranked = ids
    .slice(0, defaults.hookTopK * 2)
    .map((id) => ({ id, similarity: cosine(qv, (byId.get(id) as Chunk).vector) }))
    .filter((h) => h.similarity >= MIN_SCORE)
    .sort((a, b) => b.similarity - a.similarity);
  const best = ranked[0]?.similarity ?? 0;
  return ranked
    .filter((h) => h.similarity >= best * defaults.hookMinRatio)
    .slice(0, defaults.hookTopK)
    .map((h) => h.id);
};
const types = [...new Set(queries.filter((q) => q.set === "questions").map((q) => q.type))];
const evaluate = (fuse: (r: Retrieved) => string[]) => {
  const scored = retrieved.map((r) => {
    const ids = fuse(r);
    const hook = injected(ids, r.qv);
    return {
      query: r.query,
      rank: rankOf(ids, r.query.gold),
      hook,
      hookRank: rankOf(hook, r.query.gold),
    };
  });
  const of = (pick: (q: Query) => boolean) => {
    const xs = scored.filter((x) => pick(x.query));
    const share = (test: (x: (typeof xs)[0]) => boolean) => xs.filter(test).length / xs.length;
    return {
      n: xs.length,
      r1: share((x) => x.rank <= 1),
      r4: share((x) => x.rank <= 4),
      r8: share((x) => x.rank <= 8),
      mrr: xs.reduce((s, x) => s + (x.rank === Infinity ? 0 : 1 / x.rank), 0) / xs.length,
      hook: share((x) => x.hookRank !== Infinity),
      hookChunks: xs.reduce((s, x) => s + x.hook.length, 0) / xs.length,
    };
  };
  return {
    questions: of((q) => q.set === "questions"),
    ident: of((q) => q.set === "ident"),
    byType: Object.fromEntries(types.map((t) => [t, of((q) => q.type === t)])),
  };
};
type Result = ReturnType<typeof evaluate>;
const results: Record<string, Result> = {};

// The bench's own shipped fusion must reproduce `store.search`, or nothing below means anything.
const mismatched = retrieved.filter((r) => {
  const mine = (FUSIONS["rrf k60 (shipped)"] as Fusion)(r, r.lex.get("default") ?? []).slice(0, 8);
  return mine.join() !== r.shipped.join();
}).length;

for (const name of ftsTables.keys()) {
  results[`lexical only · ${name}`] = evaluate((r) => (r.lex.get(name) ?? []).map((s) => s.id));
}
results["dense only"] = evaluate((r) => r.dense.map((s) => s.id));
for (const [tok] of ftsTables) {
  for (const [name, fuse] of Object.entries(FUSIONS)) {
    if (tok !== "default" && name !== "rrf k60 (shipped)") continue;
    results[`${name} · ${tok}`] = evaluate((r) => fuse(r, r.lex.get(tok) ?? []));
  }
}

// Which explicit variant is the shipped default?
const sameAsDefault = Object.fromEntries(
  [...ftsTables.keys()]
    .filter((n) => n !== "default")
    .map((n) => [
      n,
      retrieved.filter(
        (r) =>
          (r.lex.get(n) ?? []).map((s) => s.id).join() ===
          (r.lex.get("default") ?? []).map((s) => s.id).join(),
      ).length,
    ]),
);

// --- report
const f = (x: number) => (100 * x).toFixed(1).padStart(5);
const baseline = results["rrf k60 (shipped) · default"] as Result;
const fires = (set: string) => {
  const qs = queries.filter((q) => q.set === set || q.type === set);
  return `${qs.filter((q) => looksLikeIdentifier(q.q)).length}/${qs.length}`;
};
const count = (set: Query["set"]) => queries.filter((q) => q.set === set).length;
console.log(
  `${chunks.length} chunks · ${count("questions")} questions · ${count("ident")} identifier probes · pool ${POOL} · hook min ${MIN_SCORE} ratio ${defaults.hookMinRatio}`,
);
console.log(
  `shipped fusion reproduces store.search top 8: ${retrieved.length - mismatched}/${retrieved.length}`,
);
console.log(
  `lexical lists identical to default, of ${retrieved.length}: ${Object.entries(sameAsDefault)
    .map(([n, c]) => `${n} ${c}`)
    .join(", ")}`,
);
console.log(
  `identifier detector fires on: questions ${fires("questions")}, ident probes ${fires("ident")}; ` +
    `by type ${types.map((t) => `${t} ${fires(t)}`).join(", ")}`,
);
console.log(`\n${"".padEnd(34)} questions (ranked)          worst  questions hook  ident probes`);
console.log(`${"".padEnd(34)} first  top4  top8   mrr    type   injected  ch/q  first  top4  hook`);
for (const [name, r] of Object.entries(results)) {
  const worst = Math.min(
    ...types.map((t) => (r.byType[t]?.r1 ?? 0) - (baseline.byType[t]?.r1 ?? 0)),
  );
  const q = r.questions;
  console.log(
    `${name.padEnd(34)} ${f(q.r1)} ${f(q.r4)} ${f(q.r8)}  ${q.mrr.toFixed(3)}  ${f(worst)}    ${f(q.hook)}  ${q.hookChunks.toFixed(2)}  ${f(r.ident.r1)} ${f(r.ident.r4)} ${f(r.ident.hook)}`,
  );
}
console.log(`\nfirst by type    ${types.map((t) => t.slice(0, 9).padStart(9)).join(" ")}`);
for (const [name, r] of Object.entries(results)) {
  if (name.startsWith("lexical") || name === "dense only") continue;
  console.log(
    `${name.slice(0, 34).padEnd(34)} ${types.map((t) => f(r.byType[t]?.r1 ?? 0).padStart(9)).join(" ")}`,
  );
}

writeFileSync(
  join(here, `fusion${suffix}.json`),
  `${JSON.stringify({ mismatched, sameAsDefault, results }, null, 2)}\n`,
);
