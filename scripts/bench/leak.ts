// How much of the benchmark's score does not need the documents?
//
// Reads results.jsonl and compares the `closed` condition (same questions, same grader, no
// documents) against `haystack` (the whole corpus in the prompt). Per question type, because the
// answer is different for each: a name nobody could guess vs a step number out of five.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dirname;
interface Row {
  model: string;
  cond: string;
  f: string;
  id: string;
  type: string;
  correct?: boolean;
  answer?: string;
}
const rows = readFileSync(join(here, "results.jsonl"), "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Row)
  .filter((r) => r.correct !== undefined);

const FORMAT = process.argv[2] ?? "md";
const closed = new Map(rows.filter((r) => r.cond === "closed").map((r) => [r.id, r]));
const open = new Map(
  rows.filter((r) => r.cond === "haystack" && r.f === FORMAT).map((r) => [r.id, r]),
);
// Only questions both conditions answered: otherwise the delta mixes in a different question set.
const ids = [...closed.keys()].filter((id) => open.has(id));
const types = [...new Set(ids.map((id) => (closed.get(id) as Row).type))].sort();

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "  —  ");
console.log(`${rows[0]?.model} · haystack format ${FORMAT} · ${ids.length} questions\n`);
console.log("type              n   closed  haystack     delta");
const totals = { n: 0, c: 0, o: 0 };
for (const type of [...types, "ALL"]) {
  const set = type === "ALL" ? ids : ids.filter((id) => (closed.get(id) as Row).type === type);
  const c = set.filter((id) => (closed.get(id) as Row).correct).length;
  const o = set.filter((id) => (open.get(id) as Row).correct).length;
  if (type === "ALL") Object.assign(totals, { n: set.length, c, o });
  const delta = set.length ? (100 * (o - c)) / set.length : 0;
  console.log(
    `${type.padEnd(15)} ${String(set.length).padStart(3)} ${pct(c, set.length).padStart(8)} ` +
      `${pct(o, set.length).padStart(9)} ${`${delta >= 0 ? "+" : ""}${delta.toFixed(1)}pt`.padStart(9)}`,
  );
}

// The abstention trap: a closed-book model says NOT FOUND to everything, so the unanswerable slice
// scores 100% for free. What it is worth is how often the model still abstains with the corpus in
// front of it — and how often having the corpus makes it invent an answer it did not have before.
const notFound = (r: Row | undefined) => /not found/i.test(r?.answer ?? "");
const unanswerable = ids.filter((id) => (closed.get(id) as Row).type === "unanswerable");
const answerable = ids.filter((id) => (closed.get(id) as Row).type !== "unanswerable");
console.log(
  `\nunanswerable (${unanswerable.length}): abstains closed ${pct(unanswerable.filter((id) => notFound(closed.get(id))).length, unanswerable.length)}` +
    ` · with the corpus ${pct(unanswerable.filter((id) => notFound(open.get(id))).length, unanswerable.length)}`,
);
console.log(
  `answerable (${answerable.length}): abstains closed ${pct(answerable.filter((id) => notFound(closed.get(id))).length, answerable.length)}` +
    ` · with the corpus ${pct(answerable.filter((id) => notFound(open.get(id))).length, answerable.length)}`,
);
// Guessed right with nothing to read: the score the retrieval pipeline cannot take credit for.
const leaked = answerable.filter((id) => (closed.get(id) as Row).correct);
console.log(
  `\nanswered correctly closed book (leakage floor): ${leaked.length}/${answerable.length}`,
);
for (const id of leaked.slice(0, 10)) {
  console.log(`  ${id} → ${JSON.stringify((closed.get(id) as Row).answer).slice(0, 60)}`);
}
