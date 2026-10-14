// Whether a document's own names — its title, its section headings, its frontmatter aliases — should
// count for more than the body's words. The same corpus and the real index, each document given a
// made-up codename as an alias, with the lexical side and the fusion varied offline:
//
//   - lexical text: as shipped (the breadcrumb on every chunk, the aliases on the first chunk only),
//     or the aliases on every chunk;
//   - a field list: BM25 over `title › heading` plus the aliases alone, a third list in RRF at a
//     weight;
//   - a phrase boost: a chunk of a document whose title or alias the query holds as a phrase gets one
//     extra rank-1 RRF share.
//
// A query that names something keeps `store.search`'s score fusion untouched in every variant; the
// field list and the boost only enter the RRF path. Query sets: the answerable questions, which name
// their service by title, and the same questions with the title swapped for the alias. The baseline
// reproduces `store.search`'s top 8, and misses are split into wrong document and wrong section.
//
//   node scripts/bench/fields.ts
//   BENCH_SEED=42 node scripts/bench/fields.ts      # a held-out corpus

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { breadcrumb, chunkMarkdown, embeddingText } from "../../src/documents/chunk.ts";
import { embedderMinScore } from "../../src/hook/hook-settings.ts";
import { createEmbedder } from "../../src/indexing/embedder.ts";
import { namesSomething } from "../../src/indexing/identifiers.ts";
import { Store } from "../../src/indexing/store.ts";
import { defaults } from "../../src/shared/defaults.ts";
import { docs, hardQuestions, headingPath, questions, renderDoc } from "./gen.ts";

const here = import.meta.dirname;
const POOL = 32;
const K = defaults.rrfK;
const suffix = process.env.BENCH_SEED ? `-seed${process.env.BENCH_SEED}` : "";

// --- a codename per document, none of them a word the corpus already uses
const corpusText = docs
  .map((d) => renderDoc(d, "md"))
  .join("\n")
  .toLowerCase();
const ONSETS = ["v", "br", "t", "qu", "z", "dr", "m", "sk", "pl", "f", "gr", "n"];
const NUCLEI = ["a", "o", "e", "i", "u", "ai"];
const CODAS = ["ndor", "lvex", "rrin", "maro", "stel", "quin", "dova", "rrak"];
const alias = new Map<string, string>();
let n = 0;
for (const d of docs) {
  for (;;) {
    const word = `${ONSETS[n % ONSETS.length]}${NUCLEI[Math.floor(n / ONSETS.length) % NUCLEI.length]}${CODAS[n % CODAS.length]}`;
    n++;
    if (!corpusText.includes(word) && ![...alias.values()].includes(word)) {
      alias.set(d.slug, `${(word[0] as string).toUpperCase()}${word.slice(1)}`);
      break;
    }
  }
}

// --- the index, built once with the shipped embedder
const embedder = await createEmbedder({
  embedder: "granite-small",
  modelsDir: join(process.env.HOME ?? "", ".cache/ragdown/models"),
  threads: Number(process.env.THREADS ?? 4),
} as never);
const dataDir = mkdtempSync(join(here, ".fi-"));
const store = await Store.open(dataDir, embedder, true);
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
    aliases: [alias.get(d.slug) as string],
  });
}
await store.apply(updates, []);
await store.compact();

const db = await lancedb.connect(join(store.dataDir, "lance"), { readConsistencyInterval: 0 });
const table = await db.openTable("chunks");
interface Chunk {
  id: string;
  path: string;
  title: string;
  heading: string;
  text: string;
  search_text: string;
  vector: Float32Array;
}
const chunks = (
  (await table
    .query()
    .select(["id", "path", "title", "heading", "text", "search_text", "vector"])
    .toArray()) as (Omit<Chunk, "vector"> & { vector: ArrayLike<number> })[]
).map((r) => ({ ...r, vector: Float32Array.from(r.vector) })) as Chunk[];
const byId = new Map(chunks.map((c) => [c.id, c]));

// --- the lexical variants, one FTS table each
const LEXICAL: Record<string, (c: Chunk) => string> = {
  shipped: (c) => c.search_text,
  "aliases everywhere": (c) =>
    `${embeddingText({ title: c.title, heading: c.heading, text: c.text })}\n\n${alias.get(c.path)}`,
  fields: (c) => `${breadcrumb(c.title, c.heading)}\n${alias.get(c.path)}`,
};
const ftsTables = new Map<string, lancedb.Table>();
for (const [name, text] of Object.entries(LEXICAL)) {
  const t = await db.createTable(
    `fts_${name.replace(/\W/g, "_")}`,
    chunks.map((c) => ({ id: c.id, search_text: text(c) })),
  );
  await t.createIndex("search_text", { config: lancedb.Index.fts() });
  ftsTables.set(name, t);
}

// --- queries
interface Query {
  id: string;
  q: string;
  set: "title" | "alias";
  type: string;
  doc: string;
  gold: { path: string; heading: string };
}
const queries: Query[] = [];
for (const q of [...questions, ...hardQuestions]) {
  if (!q.section || !q.doc || q.type === "unanswerable") continue;
  const d = docs.find((x) => x.slug === q.doc) as (typeof docs)[0];
  const gold = { path: q.doc, heading: `${d.title} › ${headingPath(d, q.section as string)}` };
  queries.push({ id: q.id, q: q.q, set: "title", type: q.type, doc: d.slug, gold });
  if (q.q.includes(d.title)) {
    const q2 = q.q.replaceAll(d.title, alias.get(d.slug) as string);
    queries.push({ id: `${q.id}:alias`, q: q2, set: "alias", type: q.type, doc: d.slug, gold });
  }
}

// --- the retrievers, run once per query
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
    try {
      rows = (await t.search(query.q, "fts", "search_text").limit(POOL).toArray()) as never;
    } catch {
      // The parser rejected it; dense only, as the store does.
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
interface Variant {
  lexical: string;
  fieldWeight: number;
  phraseBoost: number;
}
const order = (acc: Map<string, number>) =>
  [...acc.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
const minmax = (xs: Scored[]) => {
  const lo = Math.min(...xs.map((x) => x.score));
  const hi = Math.max(...xs.map((x) => x.score));
  return new Map(xs.map((x) => [x.id, hi > lo ? (x.score - lo) / (hi - lo) : 1]));
};
const namesDoc = (q: string, path: string) => {
  const lower = q.toLowerCase();
  const d = docs.find((x) => x.slug === path) as (typeof docs)[0];
  return [d.title, alias.get(path) as string].some((name) => lower.includes(name.toLowerCase()));
};
const fuse = (r: Retrieved, v: Variant) => {
  const lex = r.lex.get(v.lexical) ?? [];
  const acc = new Map<string, number>();
  if (namesSomething(r.query.q)) {
    // `store.search`'s score fusion, untouched.
    const w = defaults.namedQueryDenseWeight;
    const dense = minmax(r.dense);
    const lexical = minmax(lex);
    for (const s of r.dense) acc.set(s.id, (acc.get(s.id) ?? 0) + w * (dense.get(s.id) ?? 0));
    for (const s of lex) acc.set(s.id, (acc.get(s.id) ?? 0) + (1 - w) * (lexical.get(s.id) ?? 0));
    return order(acc);
  }
  const add = (list: Scored[], weight: number) => {
    for (const [i, s] of list.entries()) {
      acc.set(s.id, (acc.get(s.id) ?? 0) + weight / (K + i + 1));
    }
  };
  add(r.dense, 1);
  add(lex, 1);
  if (v.fieldWeight) add(r.lex.get("fields") ?? [], v.fieldWeight);
  if (v.phraseBoost) {
    for (const id of acc.keys()) {
      if (namesDoc(r.query.q, (byId.get(id) as Chunk).path)) {
        acc.set(id, (acc.get(id) ?? 0) + v.phraseBoost / (K + 1));
      }
    }
  }
  return order(acc);
};
const VARIANTS: Record<string, Variant> = {
  shipped: { lexical: "shipped", fieldWeight: 0, phraseBoost: 0 },
  "aliases everywhere": { lexical: "aliases everywhere", fieldWeight: 0, phraseBoost: 0 },
  "field list ×0.5": { lexical: "shipped", fieldWeight: 0.5, phraseBoost: 0 },
  "field list ×1": { lexical: "shipped", fieldWeight: 1, phraseBoost: 0 },
  "aliases everywhere + field ×0.5": {
    lexical: "aliases everywhere",
    fieldWeight: 0.5,
    phraseBoost: 0,
  },
  "phrase boost ×0.5": { lexical: "shipped", fieldWeight: 0, phraseBoost: 0.5 },
  "phrase boost ×1": { lexical: "shipped", fieldWeight: 0, phraseBoost: 1 },
  "aliases everywhere + phrase ×0.5": {
    lexical: "aliases everywhere",
    fieldWeight: 0,
    phraseBoost: 0.5,
  },
};
VARIANTS["aliases everywhere + phrase ×1"] = {
  lexical: "aliases everywhere",
  fieldWeight: 0,
  phraseBoost: 1,
};

// --- scoring
const rankOf = (ids: string[], gold: Query["gold"]) => {
  const i = ids.findIndex((id) => {
    const c = byId.get(id) as Chunk;
    return c.path === gold.path && c.heading === gold.heading;
  });
  return i === -1 ? Infinity : i + 1;
};
// The hook as `hookContext` runs it, without the exact-name rule (no query here quotes one).
const MIN_SCORE = embedderMinScore("granite-small");
// HOOK rules on top of the gates: `best` injects the best-fused candidate of a document the prompt
// names by title or alias whatever its cosine, ahead of the gated ones, as the exact-name rule does;
// `doc` puts every candidate of a named document that clears the floor first, by cosine.
type HookRule = "none" | "best" | "doc";
const injected = (ids: string[], qv: Float32Array, q = "", rule: HookRule = "none") => {
  const candidates = ids
    .slice(0, defaults.hookTopK * 2)
    .map((id) => ({ id, similarity: cosine(qv, (byId.get(id) as Chunk).vector) }));
  const named = candidates.filter((h) => namesDoc(q, (byId.get(h.id) as Chunk).path));
  const kept =
    rule === "best"
      ? named.slice(0, 1)
      : rule === "doc"
        ? named.filter((h) => h.similarity >= MIN_SCORE).sort((a, b) => b.similarity - a.similarity)
        : [];
  const ranked = candidates
    .filter((h) => !kept.includes(h) && h.similarity >= MIN_SCORE)
    .sort((a, b) => b.similarity - a.similarity);
  const best = ranked[0]?.similarity ?? 0;
  return [...kept, ...ranked.filter((h) => h.similarity >= best * defaults.hookMinRatio)]
    .map((h) => h.id)
    .slice(0, defaults.hookTopK);
};
const pct = (k: number, of: number) => (of ? (100 * k) / of : 0);
const types = [...new Set(queries.map((q) => q.type))];
interface SetResult {
  n: number;
  first: number;
  top4: number;
  top8: number;
  hook: number;
  wrongDoc: number;
  wrongSection: number;
  byType: Record<string, number>;
}
const evaluate = (v: Variant) => {
  const out: Record<string, SetResult> = {};
  for (const set of ["title", "alias"] as const) {
    const rs = retrieved.filter((r) => r.query.set === set);
    const ranked = rs.map((r) => ({ r, ids: fuse(r, v) }));
    const firstOf = (ids: string[]) => byId.get(ids[0] ?? "") as Chunk | undefined;
    const misses = ranked.filter(({ r, ids }) => rankOf(ids, r.query.gold) !== 1);
    out[set] = {
      n: rs.length,
      first: pct(ranked.filter(({ r, ids }) => rankOf(ids, r.query.gold) === 1).length, rs.length),
      top4: pct(ranked.filter(({ r, ids }) => rankOf(ids, r.query.gold) <= 4).length, rs.length),
      top8: pct(ranked.filter(({ r, ids }) => rankOf(ids, r.query.gold) <= 8).length, rs.length),
      hook: pct(
        ranked.filter(({ r, ids }) => rankOf(injected(ids, r.qv), r.query.gold) <= 4).length,
        rs.length,
      ),
      wrongDoc: pct(
        misses.filter(({ r, ids }) => firstOf(ids)?.path !== r.query.doc).length,
        rs.length,
      ),
      wrongSection: pct(
        misses.filter(({ r, ids }) => firstOf(ids)?.path === r.query.doc).length,
        rs.length,
      ),
      byType: Object.fromEntries(
        types.map((t) => {
          const of = ranked.filter(({ r }) => r.query.type === t);
          return [
            t,
            pct(of.filter(({ r, ids }) => rankOf(ids, r.query.gold) === 1).length, of.length),
          ];
        }),
      ),
    };
  }
  return out;
};

const mismatched = retrieved.filter(
  (r) =>
    fuse(r, VARIANTS.shipped as Variant)
      .slice(0, 8)
      .join() !== r.shipped.join(),
).length;
const results = Object.fromEntries(
  Object.entries(VARIANTS).map(([name, v]) => [name, evaluate(v)]),
);

// --- report
const f = (x: number) => x.toFixed(1).padStart(5);
const count = (set: string) => queries.filter((q) => q.set === set).length;
console.log(
  `${chunks.length} chunks · ${count("title")} questions · ${count("alias")} by alias · pool ${POOL}`,
);
console.log(
  `bench reproduces store.search top 8: ${retrieved.length - mismatched}/${retrieved.length}`,
);
console.log(
  `routed (score fusion, variants not applied): title ${queries.filter((q) => q.set === "title" && namesSomething(q.q)).length}, alias ${queries.filter((q) => q.set === "alias" && namesSomething(q.q)).length}`,
);
console.log(`\n${"".padEnd(34)} by title                               by alias`);
console.log(
  `${"".padEnd(34)} first  top4  top8  hook  wDoc  wSec    first  top4  top8  hook  wDoc  wSec`,
);
for (const [name, r] of Object.entries(results)) {
  const row = (s: SetResult) =>
    `${f(s.first)} ${f(s.top4)} ${f(s.top8)} ${f(s.hook)} ${f(s.wrongDoc)} ${f(s.wrongSection)}`;
  console.log(`${name.padEnd(34)} ${row(r.title as SetResult)}   ${row(r.alias as SetResult)}`);
}
console.log(
  `\nfirst by type, by title       ${types.map((t) => t.slice(0, 9).padStart(9)).join(" ")}`,
);
for (const [name, r] of Object.entries(results)) {
  const s = r.title as SetResult;
  console.log(`${name.padEnd(34)} ${types.map((t) => f(s.byType[t] ?? 0).padStart(9)).join(" ")}`);
}

const hookResults: Record<string, Record<string, { gold: number; noise: number }>> = {};
console.log(
  `\nhook, gold injected / non-gold chunks per prompt    ${["none", "best", "doc"].map((m) => `title ${m}`.padEnd(13)).join("")}${["none", "best", "doc"].map((m) => `alias ${m}`.padEnd(13)).join("")}`,
);
for (const name of ["shipped", "phrase boost ×1", "aliases everywhere + phrase ×1"]) {
  const v = VARIANTS[name] as Variant;
  const cells: string[] = [];
  hookResults[name] = {};
  for (const set of ["title", "alias"] as const) {
    const rs = retrieved.filter((r) => r.query.set === set);
    for (const rule of ["none", "best", "doc"] as HookRule[]) {
      let gold = 0;
      let noise = 0;
      for (const r of rs) {
        const got = injected(fuse(r, v), r.qv, r.query.q, rule);
        if (rankOf(got, r.query.gold) <= 4) gold++;
        noise += got.filter((id) => rankOf([id], r.query.gold) !== 1).length;
      }
      const res = { gold: pct(gold, rs.length), noise: noise / rs.length };
      hookResults[name][`${set} ${rule}`] = res;
      cells.push(`${f(res.gold)} ${res.noise.toFixed(2).padStart(5)}  `);
    }
  }
  console.log(`${name.padEnd(50)} ${cells.join("")}`);
}

writeFileSync(
  join(here, `fields${suffix}.json`),
  `${JSON.stringify({ aliases: Object.fromEntries(alias), mismatched, results, hookResults }, null, 2)}\n`,
);
rmSync(dataDir, { recursive: true, force: true });
