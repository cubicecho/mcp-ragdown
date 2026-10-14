import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { defaults } from "../shared/defaults.ts";
import { tempSetup } from "../shared/testing.ts";
import { type LoggedHit, QueryLog, type QueryRecord, type SearchRecord } from "./query-log.ts";
import { summarize } from "./usage-summary.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

async function log(env: Record<string, string> = {}) {
  const t = await tempSetup(env);
  cleanups.push(t.cleanup);
  await mkdir(t.config.dataDir, { recursive: true });
  return new QueryLog(t.config);
}

const hit = (path: string, similarity: number): LoggedHit => ({
  path,
  lines: [1, 5],
  similarity,
  score: similarity,
  sources: ["dense"],
});

const search = (
  time: string,
  query: string,
  hits: LoggedHit[],
  extra: Partial<SearchRecord> = {},
): SearchRecord => ({
  kind: "search",
  time,
  endpoint: "ragdown_recall",
  scope: "ops",
  query,
  hits,
  ms: 3,
  ...extra,
});

const hook = (injected: LoggedHit[], skipped?: "short") => ({
  ...(skipped ? { skipped } : {}),
  min_score: 0.5,
  seen: 0,
  below_min_score: 0,
  below_ratio: 0,
  over_top_k: 0,
  over_budget: 0,
  injected,
});

describe("QueryLog", () => {
  it("writes nothing while off", async () => {
    const queryLog = await log();
    queryLog.search({ endpoint: "ragdown_recall", scope: "ops", query: "x", hits: [], ms: 1 });
    queryLog.read("ops", "ops/a.md");
    expect(await queryLog.records()).toEqual([]);
    await expect(stat(queryLog.path)).rejects.toThrow();
  });

  it("appends searches and reads as JSON lines, skipping a torn one, and clears them", async () => {
    const queryLog = await log({ RAGDOWN_QUERY_LOG: "true" });
    queryLog.search({ endpoint: "ragdown_recall", scope: "ops", query: "pg", hits: [], ms: 1 });
    await writeFile(queryLog.path, `${await readFile(queryLog.path, "utf8")}{"kind":"sea`);
    await writeFile(queryLog.path, `${await readFile(queryLog.path, "utf8")}\n`);
    queryLog.read("ops", "ops/a.md");
    const records = await queryLog.records();
    expect(records.map((record) => record.kind)).toEqual(["search", "read"]);
    expect(records[1]).toMatchObject({ scope: "ops", path: "ops/a.md" });
    await queryLog.clear();
    expect(await queryLog.records()).toEqual([]);
  });

  it("rotates to one .1 file at its size limit and reads both, oldest first", async () => {
    const queryLog = await log({ RAGDOWN_QUERY_LOG: "true" });
    const old = JSON.stringify({
      kind: "read",
      time: "2026-01-01T00:00:00Z",
      scope: "",
      path: "old.md",
    });
    await writeFile(queryLog.path, `${old}\n`.padEnd(defaults.queryLogMaxBytes, " "));
    queryLog.read("ops", "ops/new.md");
    expect((await stat(`${queryLog.path}.1`)).size).toBe(defaults.queryLogMaxBytes);
    expect((await stat(queryLog.path)).size).toBeLessThan(200);
    expect((await queryLog.records()).map((record) => (record as { path: string }).path)).toEqual([
      "old.md",
      "ops/new.md",
    ]);
  });
});

describe("summarize", () => {
  it("lists the queries nothing answered, most asked first", () => {
    const records: QueryRecord[] = [
      search("2026-01-01T00:00:00Z", "restore postgres", [hit("ops/backups.md", 0.8)]),
      search("2026-01-01T00:01:00Z", "Rotate keys", [hit("ops/keys.md", 0.3)]),
      search("2026-01-01T00:02:00Z", "rotate keys ", [hit("ops/keys.md", 0.35)]),
      search("2026-01-01T00:03:00Z", "kafka", []),
      // A hook call is held to its own floor, and a skipped one is not a gap.
      search("2026-01-01T00:04:00Z", "deploy steps", [hit("ops/deploy.md", 0.45)], {
        endpoint: "ragdown_context",
        hook: hook([]),
      }),
      search("2026-01-01T00:05:00Z", "ok", [], {
        endpoint: "ragdown_context",
        hook: hook([], "short"),
      }),
    ];
    const summary = summarize(records, 0.4);
    expect(summary.since).toBe("2026-01-01T00:00:00Z");
    expect(summary.searches).toBe(6);
    expect(summary.gaps).toEqual([
      {
        query: "rotate keys ",
        endpoint: "ragdown_recall",
        scope: "ops",
        best: 0.35,
        count: 2,
        last: "2026-01-01T00:02:00Z",
      },
      {
        query: "deploy steps",
        endpoint: "ragdown_context",
        scope: "ops",
        best: 0.45,
        count: 1,
        last: "2026-01-01T00:04:00Z",
      },
      {
        query: "kafka",
        endpoint: "ragdown_recall",
        scope: "ops",
        best: null,
        count: 1,
        last: "2026-01-01T00:03:00Z",
      },
    ]);
  });

  it("counts hook injections, leaving skipped prompts out of the rate", () => {
    const context = { endpoint: "ragdown_context" as const };
    const summary = summarize(
      [
        search("2026-01-01T00:00:00Z", "a long prompt", [], {
          ...context,
          hook: hook([hit("a.md", 0.9), hit("b.md", 0.8)]),
        }),
        search("2026-01-01T00:01:00Z", "another prompt", [], { ...context, hook: hook([]) }),
        search("2026-01-01T00:02:00Z", "/clear", [], { ...context, hook: hook([], "short") }),
      ],
      0.4,
    );
    expect(summary.hook).toEqual({ calls: 2, injected: 1, chunks_per_call: 1, skipped: 1 });
  });

  it("counts a read as following a search that showed it in the minutes before", () => {
    const summary = summarize(
      [
        search("2026-01-01T00:00:00Z", "restore", [hit("ops/backups.md", 0.8)]),
        // Searched, but the hook injected only keys.md.
        search("2026-01-01T00:00:30Z", "keys and backups", [hit("ops/backups.md", 0.9)], {
          endpoint: "ragdown_context",
          hook: hook([hit("ops/keys.md", 0.9)]),
        }),
        { kind: "read", time: "2026-01-01T00:01:00Z", scope: "ops", path: "ops/backups.md" },
        { kind: "read", time: "2026-01-01T00:01:10Z", scope: "", path: "ops/keys.md" },
        { kind: "read", time: "2026-01-01T01:00:00Z", scope: "ops", path: "ops/backups.md" },
        { kind: "read", time: "2026-01-01T01:00:00Z", scope: "ops", path: "ops/other.md" },
      ],
      0.4,
    );
    expect(summary.reads).toEqual({ total: 4, after_search: 2 });
    expect(summary.documents).toEqual([
      { path: "ops/backups.md", reads: 2, returned: 1 },
      { path: "ops/keys.md", reads: 1, returned: 1 },
      { path: "ops/other.md", reads: 1, returned: 0 },
    ]);
  });
});
