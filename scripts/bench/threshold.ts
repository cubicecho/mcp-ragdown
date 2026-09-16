// What MIN_SCORE should be for each model: the best-hit cosine for on-topic questions against the
// same for prompts the corpus cannot answer. A model's scale is its own; 0.7 means nothing across them.
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { chunkMarkdown } from "../../src/chunk.ts";
import { createEmbedder } from "../../src/embedder.ts";
import { Store } from "../../src/store.ts";
import { docs, questions, renderDoc } from "./gen.ts";

const here = import.meta.dirname;
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

const onTopic = questions.filter((q) => q.section).slice(0, 60);
const pct = (xs: number[], p: number) =>
  xs.slice().sort((a, b) => a - b)[Math.floor(p * (xs.length - 1))] ?? 0;

for (const name of ["bge-small", "granite-small", "embeddinggemma"]) {
  const embedder = await createEmbedder({
    embedder: name,
    modelsDir: join(process.env.HOME ?? "", ".cache/ragdown-bench-models"),
    threads: 4,
  } as never);
  const store = await Store.open(mkdtempSync(join(here, `.th-${name}-`)), embedder, true);
  const updates = [];
  for (const d of docs) {
    const chunks = chunkMarkdown(renderDoc(d, "md"), `${d.slug}.md`);
    const vectors = await embedder.embed(
      chunks.map((c) => `${c.title}${c.heading ? ` › ${c.heading}` : ""}\n\n${c.text}`),
      "document",
    );
    updates.push({
      path: d.slug,
      hash: name + d.slug,
      mtimeMs: 0,
      size: 0,
      chunks,
      vectors,
      supersedes: [],
    });
  }
  await store.apply(updates, []);
  await store.compact();

  const best = async (qs: string[]) => {
    const out: number[] = [];
    for (const q of qs) out.push((await store.search(q, 1))[0]?.similarity ?? 0);
    return out;
  };
  const on = await best(onTopic.map((q) => q.q));
  const off = await best(OFF_TOPIC);
  console.log(
    `${name.padEnd(16)} on-topic p10 ${pct(on, 0.1).toFixed(2)} median ${pct(on, 0.5).toFixed(2)} | ` +
      `off-topic median ${pct(off, 0.5).toFixed(2)} max ${Math.max(...off).toFixed(2)}`,
  );
}
