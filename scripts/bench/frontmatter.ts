// Does derived front matter, added at index time, improve retrieval?
//   A none      — the shipped behaviour after the fix (breadcrumb only)
//   B headings  — deterministic: title, tags and the doc's heading list
//   C summary   — B plus an LLM one-line summary of the document
//   D context   — C plus an LLM one-line context sentence per chunk (Anthropic Contextual Retrieval)
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Chunk, chunkMarkdown, embeddingText } from "../../src/chunk.ts";
import { createEmbedder } from "../../src/embedder.ts";
import { Store } from "../../src/store.ts";
import { docs, questions, renderDoc } from "./gen.ts";
import type { ChatResponse } from "./openai.ts";

const here = import.meta.dirname;
const MODEL = "Qwen3.6-35B-A3B-MTP-GGUF";
// Any OpenAI-compatible /chat/completions endpoint. The numbers in the README came from a local
// lemonade server; set BENCH_LLM_URL to point at yours.
const URL = process.env.BENCH_LLM_URL ?? "http://localhost:8000/v1/chat/completions";
const cachePath = join(here, "fm-cache.json");
const cache: Record<string, string> = existsSync(cachePath)
  ? JSON.parse(readFileSync(cachePath, "utf8"))
  : {};

async function llm(key: string, system: string, user: string): Promise<string> {
  if (cache[key]) return cache[key];
  const res = await fetch(URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0,
      max_tokens: 90,
      chat_template_kwargs: { enable_thinking: false },
    }),
    signal: AbortSignal.timeout(600_000),
  });
  const body = (await res.json()) as ChatResponse;
  const text = (body.choices?.[0]?.message?.content ?? "").replace(/\s+/g, " ").trim();
  cache[key] = text;
  writeFileSync(cachePath, JSON.stringify(cache, null, 1));
  return text;
}

const md = new Map(docs.map((d) => [d.slug, renderDoc(d, "md")]));
const chunksOf = new Map(
  docs.map((d) => [d.slug, chunkMarkdown(md.get(d.slug) as string, `${d.slug}.md`)]),
);

const SUM_SYS =
  "Summarise the document in one sentence of at most 25 words: what it covers and the names a reader might search for. Reply with the sentence only.";
const CTX_SYS =
  "Give one short sentence (at most 20 words) situating this excerpt within its document, for search. Name the document and what the excerpt is about. Reply with the sentence only.";

for (const d of docs) {
  await llm(`sum:${d.slug}`, SUM_SYS, md.get(d.slug) as string);
  const cs = chunksOf.get(d.slug) as Chunk[];
  for (const c of cs) {
    await llm(
      `ctx:${d.slug}:${c.index}`,
      CTX_SYS,
      `Document:\n${md.get(d.slug)}\n\nExcerpt (${c.heading}):\n${c.text}`,
    );
  }
  console.error("generated", d.slug);
}

function prefix(variant: string, slug: string, c: Chunk): string {
  const d = docs.find((x) => x.slug === slug) as (typeof docs)[0];
  if (variant === "A") return "";
  const headings = [...new Set(d.sections.map((s) => s.path.join(" › ")))].join("; ");
  const b = `title: ${d.title}\ntags: ${d.tags.join(", ")}\nheadings: ${headings}`;
  if (variant === "B") return b;
  const s = `${b}\nsummary: ${cache[`sum:${slug}`]}`;
  if (variant === "C") return s;
  return `${s}\ncontext: ${cache[`ctx:${slug}:${c.index}`]}`;
}

const embedder = await createEmbedder({
  embedder: "bge-small",
  modelsDir: join(process.env.HOME ?? "", ".cache/ragdown-bench-models"),
  threads: 0,
} as never);
const { AutoTokenizer } = await import("@huggingface/transformers");
const tokr = await AutoTokenizer.from_pretrained("Xenova/bge-small-en-v1.5");

const out: Record<string, unknown> = {};
for (const variant of ["A", "B", "C", "D"]) {
  const store = await Store.open(mkdtempSync(join(here, `.fm-${variant}-`)), embedder, true);
  const updates = [];
  let tokens = 0;
  for (const d of docs) {
    const chunks = (chunksOf.get(d.slug) as Chunk[]).map((c) => {
      const p = prefix(variant, d.slug, c);
      return { ...c, text: p ? `${p}\n\n${c.text}` : c.text };
    });
    for (const c of chunks) tokens += (tokr.encode(embeddingText(c)) as number[]).length;
    const vectors = await embedder.embed(chunks.map(embeddingText), "document");
    updates.push({
      path: d.slug,
      hash: variant + d.slug,
      mtimeMs: 0,
      size: 0,
      chunks,
      vectors,
      supersedes: [],
    });
  }
  await store.apply(updates, []);
  await store.compact();
  // biome-ignore lint: private table, for single-retriever ranks
  const table = (store as any).table;
  const rows: { type: string; hybrid: number; dense: number; lexical: number }[] = [];
  for (const q of questions) {
    if (!q.section) continue;
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
      lexical: rank(await table.search(q.q, "fts", "search_text").limit(10).toArray()),
    });
  }
  const agg = (rs: typeof rows) => {
    const m = (k: "hybrid" | "dense" | "lexical") => ({
      r1: rs.filter((r) => r[k] <= 1).length / rs.length,
      r5: rs.filter((r) => r[k] <= 5).length / rs.length,
      mrr: rs.reduce((n, r) => n + (r[k] === Infinity ? 0 : 1 / r[k]), 0) / rs.length,
    });
    return { hybrid: m("hybrid"), dense: m("dense"), lexical: m("lexical") };
  };
  out[variant] = {
    embedTokens: tokens,
    overall: agg(rows),
    byType: Object.fromEntries(
      [...new Set(rows.map((r) => r.type))].map((t) => [t, agg(rows.filter((r) => r.type === t))]),
    ),
  };
  const p = (x: number) => `${(100 * x).toFixed(0)}`.padStart(4);
  const v = out[variant] as { overall: ReturnType<typeof agg> };
  console.log(
    variant,
    "tokens",
    tokens,
    (["hybrid", "dense", "lexical"] as const)
      .map((k) => `${k} ${p(v.overall[k].r1)}${p(v.overall[k].r5)}${p(v.overall[k].mrr)}`)
      .join(" | "),
  );
}
writeFileSync(join(here, "frontmatter.json"), JSON.stringify(out, null, 2));
