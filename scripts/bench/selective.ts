// Targeted context: add it only to chunks that cannot say what they are about.
//   A  breadcrumb only (shipped, post-fix)
//   E1 sibling emphasis   — leaf heading repeated at the end, only where the parent has >1 subsection
//   E2 breadcrumb sandwich — breadcrumb repeated at the end of every chunk (no rule)
//   E3 selective title     — title/tags prepended only where the body never names the document
//   E4 E1 + E3
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Chunk, chunkMarkdown, embeddingText } from "../../src/chunk.ts";
import { createEmbedder } from "../../src/embedder.ts";
import { Store } from "../../src/store.ts";
import { docs, questions, renderDoc } from "./gen.ts";

const here = import.meta.dirname;
const VARIANTS = ["A", "E1", "E2", "E3", "E4"];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ");
const leaf = (heading: string) => heading.split(" › ").pop() ?? "";
const parentOf = (heading: string) => heading.split(" › ").slice(0, -1).join(" › ");

/** Chunks whose parent heading has more than one child: the siblings a query has to choose between. */
function hasSiblings(chunk: Chunk, all: Chunk[]): boolean {
  const parent = parentOf(chunk.heading);
  if (!parent) return false;
  const children = new Set(
    all.filter((c) => parentOf(c.heading) === parent).map((c) => leaf(c.heading)),
  );
  return children.size > 1;
}

/** True when the body never names its own document, so only the breadcrumb identifies it. */
function namesDoc(chunk: Chunk): boolean {
  const body = norm(chunk.text);
  const words = norm(chunk.title)
    .split(" ")
    .filter((w) => w.length > 3);
  return words.length > 0 && words.every((w) => body.includes(w));
}

function textFor(variant: string, chunk: Chunk, all: Chunk[], tags: string[]): string {
  let text = chunk.text;
  if ((variant === "E3" || variant === "E4") && !namesDoc(chunk)) {
    text = `title: ${chunk.title}\ntags: ${tags.join(", ")}\n\n${text}`;
  }
  if ((variant === "E1" || variant === "E4") && hasSiblings(chunk, all)) {
    text = `${text}\n\n(${leaf(chunk.heading)})`;
  }
  if (variant === "E2") text = `${text}\n\n(${chunk.heading})`;
  return text;
}

const embedder = await createEmbedder({
  embedder: "bge-small",
  modelsDir: join(process.env.HOME ?? "", ".cache/ragdown-bench-models"),
  threads: 0,
} as never);
const { AutoTokenizer } = await import("@huggingface/transformers");
const tokr = await AutoTokenizer.from_pretrained("Xenova/bge-small-en-v1.5");

const answerable = questions.filter((q) => q.section);
const outcomes: Record<string, boolean[]> = {};
const out: Record<string, unknown> = {};

for (const variant of VARIANTS) {
  const store = await Store.open(mkdtempSync(join(here, `.sel-${variant}-`)), embedder, true);
  const updates = [];
  let tokens = 0;
  for (const d of docs) {
    const base = chunkMarkdown(renderDoc(d, "md"), `${d.slug}.md`);
    const chunks = base.map((c) => ({ ...c, text: textFor(variant, c, base, d.tags) }));
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
  const hits: boolean[] = [];
  for (const q of answerable) {
    const d = docs.find((x) => x.slug === q.doc) as (typeof docs)[0];
    const gold = `${d.title} › ${d.sections.find((s) => s.key === q.section)?.path.join(" › ")}`;
    const rank = (rs: { path: string; heading: string }[]) => {
      const i = rs.findIndex((h) => h.path === q.doc && h.heading === gold);
      return i === -1 ? Infinity : i + 1;
    };
    const [qv] = await embedder.embed([q.q], "query");
    const hybrid = rank(await store.search(q.q, 10));
    rows.push({
      type: q.type,
      hybrid,
      dense: rank(await table.vectorSearch(qv).distanceType("cosine").limit(10).toArray()),
      lexical: rank(await table.search(q.q, "fts", "search_text").limit(10).toArray()),
    });
    hits.push(hybrid <= 1);
  }
  outcomes[variant] = hits;
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
  const v = out[variant] as { overall: ReturnType<typeof agg> };
  console.log(variant, "tok", tokens, "hybrid r1", (100 * v.overall.hybrid.r1).toFixed(1));
}

// exact two-sided McNemar against A, on top-1 hits
function mcnemar(b: number, c: number) {
  const n = b + c;
  if (!n) return 1;
  const choose = (n: number, k: number) => {
    let r = 1;
    for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
    return r;
  };
  let p = 0;
  for (let i = 0; i <= Math.min(b, c); i++) p += choose(n, i) / 2 ** n;
  return Math.min(1, 2 * p);
}
const base = outcomes.A as boolean[];
const tests: Record<string, unknown> = {};
for (const v of VARIANTS.slice(1)) {
  const o = outcomes[v] as boolean[];
  let b = 0;
  let c = 0;
  answerable.forEach((_, i) => {
    if (base[i] && !o[i]) b++;
    if (!base[i] && o[i]) c++;
  });
  tests[v] = { aOnly: b, vOnly: c, p: Number(mcnemar(b, c).toFixed(4)) };
  console.log(`A vs ${v}: A-only ${b}, ${v}-only ${c}, p=${mcnemar(b, c).toFixed(4)}`);
}
writeFileSync(join(here, "selective.json"), JSON.stringify({ out, tests }, null, 2));
