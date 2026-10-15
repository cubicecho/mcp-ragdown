// Whether the wikilink graph should move the ranking (#51): a boost for a hit whose document links
// to, or is linked from, another top hit's document, and expansion, which pulls in the best section
// (by cosine to the query) of the documents the top hits link to or are linked from, at a discount
// of the hit's score. The linked corpus from `gen.ts`: the runbooks as an Obsidian vault, each
// linking the service it calls and its team's other runbooks, and each incident linking a shared
// recovery procedure. The real index, the fusion reproduced offline so every variant reorders the
// same pool. Query sets: the answerable questions (one right section, which a link never holds),
// and two that only a link answers — the first command of the procedure a runbook's incident links
// (`linked-procedure`), and the health port of the service a runbook calls (`upstream-hop`). The
// hook column runs each top 8 through the hook's own gates, on the chunk's own cosine.
//
//   node scripts/bench/links.ts
//   BENCH_SEED=42 node scripts/bench/links.ts      # a held-out corpus

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { chunkMarkdown, embeddingText } from "../../src/documents/chunk.ts";
import { findLinks, resolveRef } from "../../src/documents/links.ts";
import { embedderMinScore } from "../../src/hook/hook-settings.ts";
import { createEmbedder } from "../../src/indexing/embedder.ts";
import { namesSomething } from "../../src/indexing/identifiers.ts";
import { Store } from "../../src/indexing/store.ts";
import { defaults } from "../../src/shared/defaults.ts";
import {
  docs as baseDocs,
  hardQuestions,
  headingPath,
  linkedDocs,
  linkQuestions,
  questions,
  renderDoc,
} from "./gen.ts";

const here = import.meta.dirname;
const LIMIT = 8;
const POOL = Math.max(LIMIT * 4, 20);
const K = defaults.rrfK;
const pathOfTitle = (title: string) => `${title}.md`;

// --- the index and the link graph, built once with the shipped embedder
const embedder = await createEmbedder({
  embedder: "granite-small",
  modelsDir: join(process.env.HOME ?? "", ".cache/ragdown/models"),
  threads: 4,
} as never);
const dataDir = mkdtempSync(join(here, ".ln-"));
const store = await Store.open(dataDir, embedder, true);
const documents = linkedDocs.map((d) => ({ path: pathOfTitle(d.title), aliases: [] }));
const out = new Map<string, Set<string>>();
const into = new Map<string, Set<string>>();
const updates = [];
let edges = 0;
for (const d of linkedDocs) {
  const path = pathOfTitle(d.title);
  const text = renderDoc(d, "md");
  for (const ref of findLinks(text)) {
    const target = resolveRef(ref, path, documents);
    if (!target || target === path) continue;
    if (!out.get(path)?.has(target)) edges++;
    out.set(path, (out.get(path) ?? new Set()).add(target));
    into.set(target, (into.get(target) ?? new Set()).add(path));
  }
  const chunks = chunkMarkdown(text, path);
  updates.push({
    path,
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
type Chunk = { id: string; path: string; heading: string; vector: Float32Array; links: string[] };
const chunks: Chunk[] = (
  (await table.query().select(["id", "path", "heading", "text", "vector"]).toArray()) as {
    id: string;
    path: string;
    heading: string;
    text: string;
    vector: ArrayLike<number>;
  }[]
).map(({ text, ...row }) => ({
  ...row,
  vector: Float32Array.from(row.vector),
  // The documents this section itself links, as against every link in its document.
  links: [
    ...new Set(
      findLinks(text)
        .map((ref) => resolveRef(ref, row.path, documents))
        .filter((target): target is string => !!target && target !== row.path),
    ),
  ],
}));
const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
const byPath = new Map<string, Chunk[]>();
for (const chunk of chunks) byPath.set(chunk.path, [...(byPath.get(chunk.path) ?? []), chunk]);
const chunkOf = (id: string) => byId.get(id) as Chunk;
const pathOf = (id: string) => chunkOf(id).path;
const dot = (a: Float32Array, b: Float32Array) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] as number) * (b[i] as number);
  return sum;
};

// --- the queries
type Query = { q: string; type: string; path: string; heading: string };
const titleOfSlug = new Map(baseDocs.map((d) => [d.slug, d.title]));
const docOfTitle = new Map(linkedDocs.map((d) => [d.title, d]));
const queries: Query[] = [];
for (const q of [...questions, ...hardQuestions, ...linkQuestions]) {
  if (!q.section || !q.doc || q.type === "unanswerable") continue;
  const title = titleOfSlug.get(q.doc) ?? q.doc;
  const d = docOfTitle.get(title);
  if (!d) continue;
  queries.push({
    q: q.q,
    type: q.type,
    path: pathOfTitle(title),
    heading: `${d.title} › ${headingPath(d, q.section)}`,
  });
}

// --- the fused pool, as `store.search` builds it
type Ranked = { ids: string[]; expanded: Set<string> };
type Fused = {
  query: Query;
  vector: Float32Array;
  ids: string[];
  score: Map<string, number>;
  /** What `store.search` returns with `followLinks: 1`, and which of it a link brought in. */
  shipped: Ranked;
};
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
  const following = await store.search(query.q, LIMIT, undefined, undefined, undefined, {
    followLinks: 1,
  });
  fused.push({
    query,
    vector: vector as Float32Array,
    ids,
    score,
    shipped: {
      ids: following.map((hit) => hit.id),
      expanded: new Set(
        following.filter((hit) => hit.sources.includes("link")).map((hit) => hit.id),
      ),
    },
  });
}

// --- the variants: each a top 8 from the same pool, and which of it expansion brought in
type Links = "section" | "out" | "both";
const neighbours = (id: string, links: Links) => {
  const path = pathOf(id);
  if (links === "section") return chunkOf(id).links;
  return [...(out.get(path) ?? []), ...(links === "both" ? (into.get(path) ?? []) : [])];
};
const sorted = (score: Map<string, number>) =>
  [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);

/** A hit among the first `within` whose document links another of their documents gains `share` of its score. */
const boost =
  (share: number, within: number) =>
  (f: Fused): Ranked => {
    const top = f.ids.slice(0, within);
    const paths = new Set(top.map(pathOf));
    const score = new Map(f.score);
    for (const id of top) {
      const path = pathOf(id);
      const linked = [...(out.get(path) ?? []), ...(into.get(path) ?? [])];
      if (linked.some((other) => other !== path && paths.has(other))) {
        score.set(id, (score.get(id) as number) * (1 + share));
      }
    }
    return { ids: sorted(score).slice(0, LIMIT), expanded: new Set() };
  };

/**
 * For each of the first `from` hits, the best section by cosine of each document it links, placed
 * by `place`: `×d` at d of the hit's score, `+n` just above whatever ranked n places after the hit.
 * A section already ranked higher stays where it is.
 */
const expand =
  (from: number, links: Links, place: string, sections = 1) =>
  (f: Fused): Ranked => {
    const score = new Map(f.score);
    const expanded = new Set<string>();
    f.ids.slice(0, from).forEach((id, rank) => {
      for (const other of neighbours(id, links)) {
        const bests = [...(byPath.get(other) ?? [])]
          .sort((a, b) => dot(f.vector, b.vector) - dot(f.vector, a.vector))
          .slice(0, sections);
        for (const [n, best] of bests.entries()) {
          const own = f.score.get(id) as number;
          const after = f.score.get(f.ids[rank + Number(place.slice(1))] ?? "") ?? 0;
          const candidate = place.startsWith("×")
            ? Number(place.slice(1)) * own
            : after + (own - after) * 1e-3;
          // A second section of the same document goes just below the first.
          const placed = candidate * (1 - n * 1e-4);
          if (placed > (score.get(best.id) ?? 0)) {
            score.set(best.id, placed);
            expanded.add(best.id);
          }
        }
      }
    });
    const ids = sorted(score).slice(0, LIMIT);
    return { ids, expanded: new Set(ids.filter((id) => expanded.has(id))) };
  };

const variants: Record<string, (f: Fused) => Ranked> = {
  none: (f) => ({ ids: f.ids.slice(0, LIMIT), expanded: new Set() }),
  "boost 0.1 /8": boost(0.1, 8),
  "boost 0.25 /8": boost(0.25, 8),
  "boost 0.25 /4": boost(0.25, 4),
  "exp 3 out ×0.8": expand(3, "out", "×0.8"),
  "exp 3 out +3": expand(3, "out", "+3"),
  "exp 3 both +3": expand(3, "both", "+3"),
  "exp 1 sect +1": expand(1, "section", "+1"),
  "exp 3 sect +1": expand(3, "section", "+1"),
  "exp 3 sect +3": expand(3, "section", "+3"),
  "exp 5 sect +3": expand(5, "section", "+3"),
  "exp 1 sect +1 ×2": expand(1, "section", "+1", 2),
  "exp 3 sect +3 ×2": expand(3, "section", "+3", 2),
  "shipped, follow 1": (f) => f.shipped,
};

// The hook's gates on each chunk's own cosine; `exempt` lets an expanded chunk past the ratio to
// the best hit (never past the floor), as the alias and exact-name rules let theirs.
const minScore = embedderMinScore("granite-small") ?? 0;
const hook = (ranked: Ranked, f: Fused, exempt: boolean) => {
  const scored = ranked.ids
    .slice(0, defaults.hookTopK * 2)
    .map((id) => ({ id, similarity: dot(f.vector, chunkOf(id).vector) }))
    .filter((hit) => hit.similarity >= minScore)
    .sort((a, b) => b.similarity - a.similarity);
  const best = scored[0]?.similarity ?? 0;
  const kept = scored.filter((hit) => exempt && ranked.expanded.has(hit.id));
  const close = scored.filter(
    (hit) => !kept.includes(hit) && hit.similarity >= best * defaults.hookMinRatio,
  );
  return [...kept, ...close].slice(0, defaults.hookTopK).map((hit) => hit.id);
};
const isGold = (id: string, query: Query) =>
  chunkOf(id).path === query.path && chunkOf(id).heading === query.heading;

const linkTypes = new Set(["linked-procedure", "upstream-hop"]);
const groups: [string, Fused[]][] = [
  ["answerable", fused.filter((f) => !linkTypes.has(f.query.type))],
  ["linked-procedure", fused.filter((f) => f.query.type === "linked-procedure")],
  ["upstream-hop", fused.filter((f) => f.query.type === "upstream-hop")],
];
const pct = (x: number, n: number) => ((100 * x) / n).toFixed(0).padStart(4);
console.log(
  `seed ${process.env.BENCH_SEED ?? "default"} · ${linkedDocs.length} documents, ${edges} links · ${groups.map(([name, fs]) => `${name} ${fs.length}`).join(", ")} · fusion reproduces store.search top ${LIMIT}: ${reproduced}/${fused.length}`,
);
console.log(`\n${"".padEnd(16)}${groups.map(([name]) => name.padEnd(39)).join("")}`);
console.log(
  `${"variant".padEnd(16)}${groups.map(() => "1st top4 top8 doc8 hook  +ex other  ").join(" ")}`,
);
const worst = new Map<string, number>();
for (const [name, variant] of Object.entries(variants)) {
  const byType = new Map<string, number>();
  const cells = groups.map(([, fs]) => {
    let first = 0;
    let top4 = 0;
    let top8 = 0;
    let doc8 = 0;
    let injected = 0;
    let injectedExempt = 0;
    let other = 0;
    for (const f of fs) {
      const ranked = variant(f);
      const rank = ranked.ids.findIndex((id) => isGold(id, f.query));
      if (rank === 0) first++;
      if (rank >= 0 && rank < 4) top4++;
      if (rank >= 0) top8++;
      if (rank === 0) byType.set(f.query.type, (byType.get(f.query.type) ?? 0) + 1);
      if (ranked.ids.some((id) => pathOf(id) === f.query.path)) doc8++;
      if (hook(ranked, f, false).some((id) => isGold(id, f.query))) injected++;
      const block = hook(ranked, f, true);
      if (block.some((id) => isGold(id, f.query))) injectedExempt++;
      other += block.filter((id) => !isGold(id, f.query)).length;
    }
    const n = fs.length;
    return `${pct(first, n)} ${pct(top4, n)} ${pct(top8, n)} ${pct(doc8, n)} ${pct(injected, n)} ${pct(injectedExempt, n)} ${(other / n).toFixed(2).padStart(5)}  `;
  });
  // The largest drop in first place on any answerable question type, against `none`.
  if (name === "none") for (const [type, n] of byType) worst.set(type, n);
  const drop = Math.max(0, ...[...worst].map(([type, n]) => n - (byType.get(type) ?? 0)));
  console.log(`${name.padEnd(16)}${cells.join(" ")} worst -${drop}`);
}
rmSync(dataDir, { recursive: true, force: true });
