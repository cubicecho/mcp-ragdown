// Does RRF bury an exact lexical hit the dense retriever missed?
//
// The claim: a chunk in BOTH result lists scores at least 1/(k+pool) twice, while a chunk at
// lexical rank 1 and absent from the dense list scores 1/(k+1) once. With k=60 and pool=20 that is
// 0.025 vs 0.0164, so every both-lists chunk outranks a perfect lexical hit the dense side missed.
//
// Probes are built from the corpus, not hand-picked: a token that occurs in exactly one chunk is an
// exact identifier by construction, and querying it alone is the case BM25 should win outright.
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { chunkMarkdown } from "../../src/chunk.ts";
import { createEmbedder } from "../../src/embedder.ts";
import { Store } from "../../src/store.ts";
import { docs, renderDoc } from "./gen.ts";

const here = import.meta.dirname;
const MODEL = process.env.MODEL ?? "granite-small";
/** `store.search` uses max(limit*4, 20); the hook asks for 8, a direct recall for 8. */
const POOL = 32;
const K_VALUES = [60, 20, 10, 0];

const tokens = (s: string) =>
  (s.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_.-]*/gu) ?? []).filter((t) => t.length >= 4);

// ---- build the same chunks the server would ----
interface Item {
  id: string;
  path: string;
  heading: string;
  text: string;
  search: string;
}
const items: Item[] = [];
const updates = [];
const embedder = await createEmbedder({
  embedder: MODEL,
  modelsDir: join(process.env.HOME ?? "", ".cache/ragdown-bench-models"),
  threads: 4,
} as never);

for (const d of docs) {
  const chunks = chunkMarkdown(renderDoc(d, "md"), `${d.slug}.md`);
  const search = chunks.map(
    (c) => `${c.title}${c.heading && c.heading !== c.title ? ` › ${c.heading}` : ""}\n\n${c.text}`,
  );
  const vectors = await embedder.embed(search, "document");
  const hash = `h${d.slug}`;
  chunks.forEach((c, i) => {
    items.push({
      id: `${d.slug}#${c.index}@${hash.slice(0, 12)}`,
      path: d.slug,
      heading: c.heading,
      text: c.text,
      search: search[i] as string,
    });
  });
  updates.push({ path: d.slug, hash, mtimeMs: 0, size: 0, chunks, vectors, supersedes: [] });
}

const store = await Store.open(mkdtempSync(join(here, `.rrf-${MODEL}-`)), embedder, true);
await store.apply(updates, []);
await store.compact();

// ---- probes: tokens that occur in exactly one chunk ----
const df = new Map<string, number>();
const per = items.map((it) => new Set(tokens(it.search)));
for (const set of per) for (const t of set) df.set(t, (df.get(t) ?? 0) + 1);

interface Probe {
  q: string;
  goldId: string;
  kind: "single" | "pair";
}
const probes: Probe[] = [];
items.forEach((it, i) => {
  const rare = [...(per[i] as Set<string>)]
    .filter((t) => df.get(t) === 1 && /^[\p{L}]/u.test(t))
    .sort((a, b) => b.length - a.length);
  if (rare[0]) probes.push({ q: rare[0], goldId: it.id, kind: "single" });
  if (rare[0] && rare[1]) probes.push({ q: `${rare[0]} ${rare[1]}`, goldId: it.id, kind: "pair" });
});

// ---- the two retrievers, separately, exactly as store.search runs them ----
const db = await lancedb.connect(join(store.dataDir, "lance"), { readConsistencyInterval: 0 });
const table = await db.openTable("chunks");

const rankOf = (rows: { id: string }[], id: string) => rows.findIndex((r) => r.id === id);

interface Row {
  id: string;
}
const results: {
  probe: Probe;
  dense: number;
  lex: number;
  fused: Record<number, number>;
}[] = [];

for (const probe of probes) {
  const [qv] = await embedder.embed([probe.q], "query");
  const dense = (await table
    .vectorSearch(qv as Float32Array)
    .distanceType("cosine")
    .limit(POOL)
    .toArray()) as Row[];
  let lex: Row[] = [];
  try {
    lex = (await table.search(probe.q, "fts", "search_text").limit(POOL).toArray()) as Row[];
  } catch {
    /* parser rejected it; dense only */
  }
  const fused: Record<number, number> = {};
  for (const k of K_VALUES) {
    const acc = new Map<string, number>();
    for (const rows of [dense, lex]) {
      for (const [rank, r] of rows.entries()) {
        acc.set(r.id, (acc.get(r.id) ?? 0) + 1 / (k + rank + 1));
      }
    }
    const order = [...acc.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    fused[k] = order.indexOf(probe.goldId);
  }
  results.push({
    probe,
    dense: rankOf(dense, probe.goldId),
    lex: rankOf(lex, probe.goldId),
    fused,
  });
}

// ---- report ----
const n = results.length;
const pctOf = (c: number) => `${((100 * c) / n).toFixed(1)}%`;
const top = (r: number, k: number) => r >= 0 && r < k;

console.log(
  `model ${MODEL} · ${items.length} chunks · ${n} exact-identifier probes · pool ${POOL}\n`,
);
console.log("retriever         top1    top4    top8   missed");
const line = (name: string, get: (r: (typeof results)[0]) => number) => {
  const rs = results.map(get);
  console.log(
    `${name.padEnd(16)} ${pctOf(rs.filter((r) => top(r, 1)).length).padStart(6)} ` +
      `${pctOf(rs.filter((r) => top(r, 4)).length).padStart(6)} ` +
      `${pctOf(rs.filter((r) => top(r, 8)).length).padStart(6)} ` +
      `${pctOf(rs.filter((r) => r < 0).length).padStart(7)}`,
  );
};
line("dense only", (r) => r.dense);
line("lexical only", (r) => r.lex);
for (const k of K_VALUES) line(`fused k=${k}`, (r) => r.fused[k] as number);

// The specific failure: lexical nailed it, fusion lost it.
const buried = results.filter((r) => r.lex === 0 && !top(r.fused[60] as number, 8));
const buried4 = results.filter((r) => r.lex === 0 && !top(r.fused[60] as number, 4));
console.log(
  `\nlexical rank 1 but outside fused top-8 (k=60): ${buried.length}/${results.filter((r) => r.lex === 0).length}` +
    ` (of all probes: ${pctOf(buried.length)})`,
);
console.log(`lexical rank 1 but outside fused top-4 (k=60): ${buried4.length}`);
for (const b of buried.slice(0, 8)) {
  console.log(`  "${b.probe.q}" dense=${b.dense} lex=${b.lex} fused60=${b.fused[60]}`);
}
