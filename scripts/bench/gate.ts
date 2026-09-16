// What a relative drop-off gate would do on top of the absolute MIN_SCORE.
//
// The hook keeps hits above an absolute cosine. A relative gate additionally drops a hit far below
// the best one: if the top hit is 0.90 and the fourth is 0.81, the fourth is probably a distractor
// even though it cleared 0.80. The question is whether trimming those costs any real answers.
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { chunkMarkdown } from "../../src/chunk.ts";
import { createEmbedder } from "../../src/embedder.ts";
import { Store } from "../../src/store.ts";
import { docs, headingPath, questions, renderDoc } from "./gen.ts";

const here = import.meta.dirname;
const MODEL = process.env.MODEL ?? "granite-small";
const MIN_SCORE = Number(process.env.MIN_SCORE ?? 0.8);
const TOP_K = 4;
const RATIOS = [1.0, 0.99, 0.98, 0.97, 0.96, 0.95, 0.94, 0.92, 0.9, 0];
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

const embedder = await createEmbedder({
  embedder: MODEL,
  modelsDir: join(process.env.HOME ?? "", ".cache/ragdown-bench-models"),
  threads: 4,
} as never);
const store = await Store.open(mkdtempSync(join(here, `.gate-${MODEL}-`)), embedder, true);

const updates = [];
for (const d of docs) {
  const chunks = chunkMarkdown(renderDoc(d, "md"), `${d.slug}.md`);
  const vectors = await embedder.embed(
    chunks.map(
      (c) =>
        `${c.title}${c.heading && c.heading !== c.title ? ` › ${c.heading}` : ""}\n\n${c.text}`,
    ),
    "document",
  );
  updates.push({
    path: d.slug,
    hash: d.slug,
    mtimeMs: 0,
    size: 0,
    chunks,
    vectors,
    supersedes: [],
  });
}
await store.apply(updates, []);
await store.compact();

const bySlug = new Map(docs.map((d) => [d.slug, d]));
const onTopic = questions.filter((q) => q.section);

interface Row {
  gold: boolean[];
  sims: number[];
}
const rows: Row[] = [];
for (const q of onTopic) {
  const doc = bySlug.get(q.doc);
  if (!doc) continue;
  // A chunk's heading carries the document title; `headingPath` is the part below it.
  const want = `${doc.title} › ${headingPath(doc, q.section as string)}`;
  // The hook asks for topK*2 and keeps topK, so the candidate list is the same one it sees.
  const hits = await store.search(q.q, TOP_K * 2);
  const kept = hits
    .filter((h) => h.similarity >= MIN_SCORE)
    .sort((a, b) => b.similarity - a.similarity);
  rows.push({
    gold: kept.map(
      (h) => h.path === q.doc && (h.heading === want || h.heading.startsWith(`${want} ›`)),
    ),
    sims: kept.map((h) => h.similarity),
  });
}

const offRows: number[][] = [];
for (const q of OFF_TOPIC) {
  const hits = await store.search(q, TOP_K * 2);
  offRows.push(
    hits
      .filter((h) => h.similarity >= MIN_SCORE)
      .map((h) => h.similarity)
      .sort((a, b) => b - a),
  );
}

console.log(
  `model ${MODEL} · min_score ${MIN_SCORE} · top_k ${TOP_K} · ${rows.length} on-topic questions\n`,
);
console.log("ratio   recall  chunks/q  noise/q  off-topic injections");
for (const ratio of RATIOS) {
  const trim = (sims: number[]) => {
    const best = sims[0] ?? 0;
    return sims.filter((s) => s >= best * ratio).slice(0, TOP_K).length;
  };
  let found = 0;
  let injected = 0;
  let noise = 0;
  for (const row of rows) {
    const n = trim(row.sims);
    injected += n;
    const gold = row.gold.slice(0, n).some(Boolean);
    if (gold) found++;
    noise += row.gold.slice(0, n).filter((g) => !g).length;
  }
  const off = offRows.reduce((sum, sims) => sum + trim(sims), 0);
  console.log(
    `${ratio.toFixed(2).padStart(5)} ${((100 * found) / rows.length).toFixed(1).padStart(7)}% ` +
      `${(injected / rows.length).toFixed(2).padStart(8)} ${(noise / rows.length).toFixed(2).padStart(8)} ` +
      `${String(off).padStart(20)}`,
  );
}
