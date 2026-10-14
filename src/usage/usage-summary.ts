import { defaults } from "../shared/defaults.ts";
import type { LoggedHit, QueryRecord, SearchRecord } from "./query-log.ts";

/** A query nothing answered: its best hit was under the floor, or it had none. */
export interface Gap {
  query: string;
  endpoint: SearchRecord["endpoint"];
  scope: string;
  /** The best hit's similarity the last time it was asked; null when nothing came back. */
  best: number | null;
  /** How often it was asked. */
  count: number;
  last: string;
}

/** What `GET /api/query-log` answers: what the log says about search on real queries. */
export interface UsageSummary {
  /** The oldest record's time; null for an empty log. */
  since: string | null;
  searches: number;
  /** Queries whose best hit was below the floor, most asked first. */
  gaps: Gap[];
  hook: {
    /** `ragdown_context` calls that searched, leaving out short prompts and slash commands. */
    calls: number;
    /** Calls that injected anything. */
    injected: number;
    /** Sections injected per call that searched. */
    chunks_per_call: number;
    skipped: number;
  };
  reads: {
    total: number;
    /** Reads of a path a search had returned (or the hook injected) in the minutes before. */
    after_search: number;
  };
  /** The documents read most, each with how often search returned it. */
  documents: { path: string; reads: number; returned: number }[];
}

/**
 * Sum the log up for the web UI. A read follows a search when a search in the
 * `defaults.queryLogFeedbackMs` before it returned that path, in any scope: over HTTP there is no
 * session to tie the two together, so this is a hint that a hit was used, not proof.
 *
 * @param minScore - the floor a search's best hit is held to when the record has none of its own;
 *   a hook call is held to the floor it applied.
 */
export function summarize(records: QueryRecord[], minScore: number): UsageSummary {
  const searches = records.filter((record) => record.kind === "search");
  const gaps = new Map<string, Gap>();
  const returned = new Map<string, number>();
  for (const search of searches) {
    for (const path of new Set(shown(search).map((hit) => hit.path))) {
      returned.set(path, (returned.get(path) ?? 0) + 1);
    }
    if (search.hook?.skipped) {
      continue;
    }
    const best = search.hits.reduce<number | null>(
      (top, hit) => (top === null || hit.similarity > top ? hit.similarity : top),
      null,
    );
    if (best !== null && best >= (search.hook?.min_score ?? minScore)) {
      continue;
    }
    const key = search.query.trim().toLowerCase();
    const gap = gaps.get(key);
    gaps.set(key, {
      query: search.query,
      endpoint: search.endpoint,
      scope: search.scope,
      best,
      count: (gap?.count ?? 0) + 1,
      last: search.time,
    });
  }

  const hookCalls = searches.filter((search) => search.endpoint === "ragdown_context");
  const searched = hookCalls.filter((search) => !search.hook?.skipped);
  const injected = searched.map((search) => search.hook?.injected.length ?? 0);

  // Each read against the searches in the window before it, walked in time order.
  const reads = records.filter((record) => record.kind === "read");
  const readCounts = new Map<string, number>();
  let afterSearch = 0;
  for (const read of reads) {
    readCounts.set(read.path, (readCounts.get(read.path) ?? 0) + 1);
    const at = Date.parse(read.time);
    const followed = searches.some((search) => {
      const searchedAt = Date.parse(search.time);
      return (
        searchedAt <= at &&
        at - searchedAt <= defaults.queryLogFeedbackMs &&
        shown(search).some((hit) => hit.path === read.path)
      );
    });
    if (followed) {
      afterSearch++;
    }
  }

  return {
    since: records[0]?.time ?? null,
    searches: searches.length,
    gaps: [...gaps.values()]
      .sort((a, b) => b.count - a.count || b.last.localeCompare(a.last))
      .slice(0, defaults.usageRows),
    hook: {
      calls: searched.length,
      injected: injected.filter((count) => count > 0).length,
      chunks_per_call:
        searched.length > 0
          ? Number((injected.reduce((sum, count) => sum + count, 0) / searched.length).toFixed(2))
          : 0,
      skipped: hookCalls.length - searched.length,
    },
    reads: { total: reads.length, after_search: afterSearch },
    documents: [...readCounts.entries()]
      .map(([path, count]) => ({ path, reads: count, returned: returned.get(path) ?? 0 }))
      .sort((a, b) => b.reads - a.reads || a.path.localeCompare(b.path))
      .slice(0, defaults.usageRows),
  };
}

/** What a search put in front of its caller: the hits, or for a hook call what it injected. */
function shown(search: SearchRecord): LoggedHit[] {
  return search.hook ? search.hook.injected : search.hits;
}
