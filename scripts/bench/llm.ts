// LLM benchmark: answer accuracy and edit fidelity per format against the lemonade server.
// usage: node llm.ts <model> <cond,cond> [perType]   (cond: closed|oracle|retrieved|haystack|edit)
//
// `closed` is the leakage control: the same questions and the same grader with no documents at all.
// Whatever it scores is what the benchmark measures without retrieval — parametric knowledge for a
// real corpus, guessing for this generated one — and every other condition has to be read as a
// delta over it, not as an absolute. The unanswerable slice is where it bites: abstaining is free
// when there is nothing to read, so a high NOT FOUND rate there is only meaningful if the same
// questions also get NOT FOUND when a full document set IS in the prompt.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { docs, edits, type Fmt, FORMATS, hardQuestions, questions, renderDoc } from "./gen.ts";
import type { ChatResponse } from "./openai.ts";

const here = import.meta.dirname;
// Any OpenAI-compatible /chat/completions endpoint. The numbers in the README came from a local
// lemonade server; set BENCH_LLM_URL to point at yours.
const URL = process.env.BENCH_LLM_URL ?? "http://localhost:8000/v1/chat/completions";
const [model = "", condArg = "oracle", perTypeArg = "10"] = process.argv.slice(2);
const conds = condArg.split(",");
const perType = Number(perTypeArg);
const out = join(here, "results.jsonl");
const done = new Set(
  existsSync(out)
    ? readFileSync(out, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l).key)
    : [],
);
const retrieved = JSON.parse(readFileSync(join(here, "retrieved.json"), "utf8"));
const bySlug = new Map(docs.map((d) => [d.slug, d]));

const types = [...new Set(questions.map((q) => q.type))];
const sampleQs = types.flatMap((t, ti) =>
  Array.from({ length: perType }, (_, i) => {
    const slug = docs[(ti * 3 + i) % docs.length]?.slug;
    return questions.find((q) => q.type === t && q.doc === slug);
  }).filter((q) => q !== undefined),
);
const editTypes = [...new Set(edits.map((e) => e.type))];
const sampleEdits = editTypes.flatMap((t, ti) =>
  Array.from({ length: perType }, (_, i) => {
    const slug = docs[(ti * 7 + i) % docs.length]?.slug;
    return edits.find((e) => e.type === t && e.doc === slug);
  }).filter((e) => e !== undefined),
);

const QA_SYSTEM =
  "Answer the question using only the provided documents. Reply with only the answer value (a name, number or short phrase), no explanation. If the documents do not contain the answer, reply exactly: NOT FOUND";
const EDIT_SYSTEM =
  'You maintain a notes file. Apply the requested change with the smallest exact-text replacement. Reply with only a JSON object {"edits":[{"old_string":"...","new_string":"..."}]}. Each old_string must be copied exactly from the document (including whitespace) and occur exactly once in it. Keep the file\'s existing format and style.';

const file = (slug: string, f: Fmt) =>
  `=== file: ${slug}.${f} ===\n${renderDoc(bySlug.get(slug) as never, f)}`;

async function chat(system: string, user: string, maxTokens: number, json = false) {
  const t0 = Date.now();
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          temperature: 0,
          max_tokens: maxTokens,
          chat_template_kwargs: { enable_thinking: false },
          ...(json ? { response_format: { type: "json_object" } } : {}),
        }),
        signal: AbortSignal.timeout(1_800_000),
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      const body = (await res.json()) as ChatResponse;
      return {
        text: (body.choices?.[0]?.message?.content ?? "") as string,
        promptTokens: body.usage?.prompt_tokens as number,
        completionTokens: body.usage?.completion_tokens as number,
        promptMs: body.timings?.prompt_ms as number,
        cached: body.timings?.cache_n as number,
        wallMs: Date.now() - t0,
      };
    } catch (error) {
      if (attempt >= 3) throw error;
      console.error("retry", String(error).slice(0, 200));
      await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
    }
  }
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[`*"']/g, "")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
function gradeQA(q: (typeof questions)[0], answer: string): boolean {
  const a = norm(answer);
  if (q.section === null) return a.includes("not found");
  return q.gold.some((g) => {
    const gg = norm(g);
    if (q.numeric)
      return new RegExp(`(^|[^0-9])${gg}([^0-9]|$)`).test(a) && !a.includes("not found");
    // a bare first name/word is not enough for people; the full value must be there
    return a.includes(gg);
  });
}

const htmlBalanced = (s: string) => {
  const stack: string[] = [];
  const voids = new Set(["meta", "br", "hr", "img", "input", "link"]);
  for (const m of s.matchAll(/<\/?([a-z0-9]+)[^>]*>/gi)) {
    const tag = (m[1] as string).toLowerCase();
    if (voids.has(tag) || m[0].startsWith("<!")) continue;
    if (m[0].startsWith("</")) {
      if (stack.pop() !== tag) return false;
    } else stack.push(tag);
  }
  return stack.length === 0;
};
const flat = (s: string, f: Fmt) => {
  let x = s.replace(/\s+/g, " ").trim();
  if (f === "html") x = x.replace(/>\s+</g, "><");
  return x;
};
function sectionSpan(text: string, f: Fmt, path: string[]): string {
  const find = (h: string, from: number) => {
    const re =
      f === "md"
        ? new RegExp(`^#{2,6} ${h}\\s*$`, "m")
        : f === "html"
          ? new RegExp(`<h[2-6][^>]*>${h}</h[2-6]>`)
          : new RegExp(`^${h}\\s*$`, "m");
    const m = re.exec(text.slice(from));
    return m ? from + m.index + m[0].length : -1;
  };
  let start = 0;
  for (const h of path) {
    start = find(h, start);
    if (start === -1) return "";
  }
  const rest = text.slice(start);
  const next =
    f === "md" ? /^#{2,6} /m.exec(rest) : f === "html" ? /<h[2-6][^>]*>/.exec(rest) : null;
  if (f === "txt") {
    // next heading: any of the doc's known heading lines
    const heads = [
      "Overview",
      "Configuration",
      "Deployment",
      "Staging",
      "Production",
      "Dependencies",
      "Troubleshooting",
      "Incidents",
    ];
    const m = new RegExp(`^(${heads.join("|")})\\s*$`, "m").exec(rest);
    return m ? rest.slice(0, m.index) : rest;
  }
  return next ? rest.slice(0, next.index) : rest;
}

function record(row: Record<string, unknown>) {
  appendFileSync(out, `${JSON.stringify(row)}\n`);
  done.add(row.key as string);
}

for (const cond of conds) {
  // Closed book has no document, so it has no format: one pass, labelled "none".
  for (const f of cond === "closed" ? (["none"] as unknown as Fmt[]) : FORMATS) {
    if (cond === "edit") {
      for (const e of sampleEdits) {
        const key = `${model}|edit|${f}|${e.id}`;
        if (done.has(key)) continue;
        const doc = bySlug.get(e.doc) as (typeof docs)[0];
        const before = renderDoc(doc, f);
        const r = await chat(
          EDIT_SYSTEM,
          `Document ${e.doc}.${f}:\n\n${before}\n\nChange: ${e.instruction}`,
          1024,
          true,
        );
        let after = before;
        let applied = true;
        let parsed = true;
        try {
          const j = JSON.parse(r.text);
          for (const ed of j.edits ?? []) {
            const n = after.split(ed.old_string).length - 1;
            if (n !== 1 || !ed.old_string) {
              applied = false;
              break;
            }
            after = after.replace(ed.old_string, () => ed.new_string);
          }
          if (!(j.edits ?? []).length) applied = false;
        } catch {
          parsed = false;
          applied = false;
        }
        const expectedDoc = structuredClone(doc);
        // structuredClone drops nothing here: docs are plain data; apply mutates the clone
        e.apply(expectedDoc);
        const expected = renderDoc(expectedDoc, f);
        const strict = applied && flat(after, f) === flat(expected, f);
        const path = doc.sections.find((s) => s.key === e.section)?.path ?? [];
        const span = sectionSpan(after, f, path);
        const valid = f !== "html" || htmlBalanced(after);
        const loose =
          applied &&
          valid &&
          e.expect.every((x) => span.includes(x)) &&
          (e.gone === undefined || e.type === "edit-cell" || !span.includes(e.gone));
        record({
          key,
          model,
          cond,
          f,
          id: e.id,
          type: e.type,
          parsed,
          applied,
          valid,
          strict,
          loose,
          ...r,
        });
        console.log(cond, f, e.id, { parsed, applied, strict, loose }, r.completionTokens);
      }
      continue;
    }
    const haystack = cond === "closed" ? "" : docs.map((d) => file(d.slug, f)).join("\n\n");
    for (const q of cond === "hard" ? hardQuestions : sampleQs) {
      const key = `${model}|${cond}|${f}|${q.id}`;
      if (done.has(key)) continue;
      let context: string;
      // Not "answer from memory": the same instructions, with the document set empty. Changing the
      // prompt as well would make the difference a prompt effect rather than a retrieval effect.
      if (cond === "closed") context = "(no documents were provided)";
      else if (cond === "oracle") context = file(q.doc, f);
      else if (cond === "haystack" || cond === "hard") context = haystack;
      else
        context = (retrieved[f][q.id] as { path: string; heading: string; text: string }[])
          .map((h) => `=== ${h.path}.${f} › ${h.heading} ===\n${h.text}`)
          .join("\n\n");
      const r = await chat(QA_SYSTEM, `${context}\n\nQuestion: ${q.q}`, 48);
      const correct = gradeQA(q, r.text);
      record({
        key,
        model,
        cond,
        f,
        id: q.id,
        type: q.type,
        answer: r.text,
        gold: q.gold,
        correct,
        ...r,
      });
      console.log(
        cond,
        f,
        q.id,
        correct ? "OK " : "BAD",
        JSON.stringify(r.text).slice(0, 60),
        r.promptTokens,
        r.wallMs,
      );
    }
  }
}
