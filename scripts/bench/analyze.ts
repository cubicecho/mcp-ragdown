import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dirname;
const rows = readFileSync(join(here, "results.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / (a.length || 1);

// exact two-sided McNemar on discordant pairs
function mcnemar(b: number, c: number) {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let p = 0;
  const choose = (n: number, k: number) => {
    let r = 1;
    for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
    return r;
  };
  for (let i = 0; i <= k; i++) p += choose(n, i) / 2 ** n;
  return Math.min(1, 2 * p);
}

const summary: Record<string, unknown>[] = [];
const models = [...new Set(rows.map((r) => r.model))];
for (const model of models) {
  for (const cond of ["oracle", "retrieved", "haystack", "edit"]) {
    const sub = rows.filter((r) => r.model === model && r.cond === cond);
    if (!sub.length) continue;
    const byF: Record<string, typeof sub> = {};
    for (const r of sub) {
      const group = byF[r.f] ?? [];
      group.push(r);
      byF[r.f] = group;
    }
    const ok = (r: (typeof sub)[0]) => (cond === "edit" ? r.strict : r.correct);
    for (const [f, rs] of Object.entries(byF)) {
      const line: Record<string, unknown> = {
        model,
        cond,
        f,
        n: rs.length,
        acc: pct(mean(rs.map((r) => (ok(r) ? 1 : 0)))),
        promptTok: Math.round(mean(rs.map((r) => r.promptTokens))),
        outTok: Math.round(mean(rs.map((r) => r.completionTokens))),
        promptMs: Math.round(mean(rs.map((r) => r.promptMs))),
        wallMs: Math.round(mean(rs.map((r) => r.wallMs))),
      };
      if (cond === "edit") {
        line.parsed = pct(mean(rs.map((r) => (r.parsed ? 1 : 0))));
        line.applied = pct(mean(rs.map((r) => (r.applied ? 1 : 0))));
        line.loose = pct(mean(rs.map((r) => (r.loose ? 1 : 0))));
        line.validHtml = pct(mean(rs.map((r) => (r.valid ? 1 : 0))));
      }
      const types = [...new Set(rs.map((r) => r.type))];
      line.byType = Object.fromEntries(
        types.map((t) => [
          t,
          pct(mean(rs.filter((r) => r.type === t).map((r) => (ok(r) ? 1 : 0)))),
        ]),
      );
      summary.push(line);
    }
    for (const other of ["html", "txt"]) {
      const a = new Map((byF.md ?? []).map((r) => [r.id, ok(r)]));
      let b = 0,
        c = 0;
      for (const r of byF[other] ?? []) {
        if (!a.has(r.id)) continue;
        if (a.get(r.id) && !ok(r)) b++;
        if (!a.get(r.id) && ok(r)) c++;
      }
      summary.push({
        model,
        cond,
        compare: `md vs ${other}`,
        mdOnlyRight: b,
        otherOnlyRight: c,
        p: mcnemar(b, c).toFixed(3),
      });
    }
  }
}
for (const s of summary) console.log(JSON.stringify(s));
writeFileSync(join(here, "summary.json"), JSON.stringify(summary, null, 2));
const wrong = rows
  .filter((r) => r.cond !== "edit" && !r.correct)
  .map(
    (r) =>
      `${r.model.slice(0, 8)} ${r.cond} ${r.f} ${r.id} gold=${r.gold} got=${JSON.stringify(r.answer)}`,
  );
writeFileSync(join(here, "wrong.txt"), wrong.join("\n"));
