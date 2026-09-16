// A harder unanswerable slice: near-misses instead of nonsense.
//
// The shipped `unanswerable` questions ask about a concept no document contains at all (blue-green
// canary percentages). Closed book scores 100% on them, and so does the full corpus — the slice
// separates nothing, it just hands every condition free points.
//
// These ask for a field that IS in the corpus, in the right section of the right document, for
// every service except this one:
//   absent-dep     a dependency other services list and this one does not
//   absent-step    a command in this service's PRODUCTION steps, asked about its staging list
//   absent-setting a plausible setting name no document's table has
// Retrieval returns a chunk that looks like the answer. Abstaining now requires reading it.
//
// usage: node nearmiss.ts <model> [closed,oracle,haystack]
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { blockOf, type Doc, docs, renderDoc } from "./gen.ts";
import type { ChatResponse } from "./openai.ts";

const here = import.meta.dirname;
// Any OpenAI-compatible /chat/completions endpoint. The numbers in the README came from a local
// lemonade server; set BENCH_LLM_URL to point at yours.
const URL = process.env.BENCH_LLM_URL ?? "http://localhost:8000/v1/chat/completions";
const [model = "", condArg = "closed,oracle,haystack"] = process.argv.slice(2);
const out = join(here, "nearmiss.jsonl");
const done = new Set(
  existsSync(out)
    ? readFileSync(out, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l).key)
    : [],
);

const QA_SYSTEM =
  "Answer the question using only the provided documents. Reply with only the answer value (a name, number or short phrase), no explanation. If the documents do not contain the answer, reply exactly: NOT FOUND";

/** The commands of one deployment list, in order: each step is "Run `<cmd>`." */
const stepsOf = (d: Doc, key: string) =>
  blockOf(d, key, 1, "ol").items.map((item) => item.find((x) => x.t === "code")?.v ?? "");
const depsOf = (d: Doc) => blockOf(d, "deps", 0, "deps").items.map((x) => x.name);

const allDeps = [...new Set(docs.flatMap(depsOf))];

interface Probe {
  id: string;
  type: string;
  doc: string;
  q: string;
}
const probes: Probe[] = [];
for (const d of docs) {
  const mine = new Set(depsOf(d));
  const missing = allDeps.find((name) => !mine.has(name));
  if (missing) {
    probes.push({
      id: `${d.slug}:absent-dep`,
      type: "absent-dep",
      doc: d.slug,
      q: `Which version of ${missing} does ${d.title} depend on?`,
    });
  }
  const staging = new Set(stepsOf(d, "deploy-staging"));
  const prodOnly = stepsOf(d, "deploy-production").find((c) => c && !staging.has(c));
  if (prodOnly) {
    probes.push({
      id: `${d.slug}:absent-step`,
      type: "absent-step",
      doc: d.slug,
      q: `In the staging deployment of ${d.title}, which step number runs \`${prodOnly}\`?`,
    });
  }
  probes.push({
    id: `${d.slug}:absent-setting`,
    type: "absent-setting",
    doc: d.slug,
    q: `What is the production CPU limit for ${d.title}?`,
  });
}

async function chat(user: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: QA_SYSTEM },
            { role: "user", content: user },
          ],
          temperature: 0,
          max_tokens: 48,
          chat_template_kwargs: { enable_thinking: false },
        }),
        signal: AbortSignal.timeout(1_800_000),
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      const body = (await res.json()) as ChatResponse;
      return {
        text: (body.choices?.[0]?.message?.content ?? "") as string,
        promptTokens: body.usage?.prompt_tokens as number,
      };
    } catch (error) {
      if (attempt >= 3) throw error;
      console.error("retry", String(error).slice(0, 200));
      await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
    }
  }
}

const bySlug = new Map(docs.map((d) => [d.slug, d]));
const file = (slug: string) =>
  `=== file: ${slug}.md ===\n${renderDoc(bySlug.get(slug) as Doc, "md")}`;
const haystack = docs.map((d) => file(d.slug)).join("\n\n");

/**
 * What the hook would actually inject: the real retriever, then the shipped gates — min_score 0.8,
 * the 0.95 drop-off ratio, top 4. The point of the condition is that it sits between oracle and
 * haystack in size, so it says which of those two the hook behaves like.
 */
async function retriever() {
  const { mkdtempSync } = await import("node:fs");
  const { chunkMarkdown, embeddingText } = await import("../../src/chunk.ts");
  const { createEmbedder } = await import("../../src/embedder.ts");
  const { Store } = await import("../../src/store.ts");
  const embedder = await createEmbedder({
    embedder: "granite-small",
    modelsDir: join(process.env.HOME ?? "", ".cache/ragdown-bench-models"),
    threads: 4,
  } as never);
  const store = await Store.open(mkdtempSync(join(here, ".nm-")), embedder, true);
  const updates = [];
  for (const d of docs) {
    const chunks = chunkMarkdown(renderDoc(d, "md"), `${d.slug}.md`);
    const vectors = await embedder.embed(chunks.map(embeddingText), "document");
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
  return async (q: string) => {
    const ranked = (await store.search(q, 8))
      .filter((h) => h.similarity >= 0.8)
      .sort((a, b) => b.similarity - a.similarity);
    const best = ranked[0]?.similarity ?? 0;
    const hits = ranked.filter((h) => h.similarity >= best * 0.95).slice(0, 4);
    return hits.length === 0
      ? "(no documents were provided)"
      : hits.map((h) => `=== ${h.path}.md › ${h.heading} ===\n${h.text}`).join("\n\n");
  };
}

const conds = condArg.split(",");
const recall = conds.includes("retrieved") ? await retriever() : undefined;

for (const cond of conds) {
  for (const p of probes) {
    const key = `${model}|${cond}|${p.id}`;
    if (done.has(key)) continue;
    const context =
      cond === "closed"
        ? "(no documents were provided)"
        : cond === "oracle"
          ? file(p.doc)
          : cond === "retrieved"
            ? await (recall as (q: string) => Promise<string>)(p.q)
            : haystack;
    const r = await chat(`${context}\n\nQuestion: ${p.q}`);
    const abstained = /not found/i.test(r.text);
    appendFileSync(
      out,
      `${JSON.stringify({ key, model, cond, id: p.id, type: p.type, answer: r.text, abstained, promptTokens: r.promptTokens })}\n`,
    );
    done.add(key);
    console.log(
      cond,
      p.id,
      abstained ? "OK " : "HALLUCINATED",
      JSON.stringify(r.text).slice(0, 50),
    );
  }
}
