import { appendFileSync, renameSync, statSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join, posix } from "node:path";
import type { HookTrace } from "../hook/hook-context.ts";
import type { Hit } from "../indexing/store.ts";
import type { Config } from "../shared/config.ts";
import { defaults } from "../shared/defaults.ts";
import { errorMessage, hasCode } from "../shared/errors.ts";
import { isRecord } from "../shared/json.ts";

/** In the data dir, beside the index; `.1` is the one rotated file. */
export const QUERY_LOG_FILE = "query-log.jsonl";

/** Where a search came from. */
export type SearchEndpoint = "ragdown_recall" | "ragdown_context" | "/api/search";

/** A hit as the log keeps it: enough to judge the ranking again, none of the text. */
export interface LoggedHit {
  /** Relative to the docs dir, folder first, whichever endpoint returned it. */
  path: string;
  lines: [number, number];
  similarity: number;
  /** The fused score, comparable only within its own search. */
  score: number;
  sources: Hit["sources"];
}

/** One search: a `ragdown_recall`, a `ragdown_context` or an `/api/search`. */
export interface SearchRecord {
  kind: "search";
  time: string;
  endpoint: SearchEndpoint;
  /** The endpoint's directory relative to the docs dir; `*` for the root endpoint. */
  scope: string;
  query: string;
  filters?: Record<string, string>;
  /** What search returned, in its order; for a hook call, before the gates. */
  hits: LoggedHit[];
  ms: number;
  /** For a hook call, what each of its gates did. */
  hook?: {
    skipped?: HookTrace["skipped"];
    min_score: number;
    seen: number;
    below_min_score: number;
    below_ratio: number;
    over_top_k: number;
    over_budget: number;
    injected: LoggedHit[];
  };
}

/** One `ragdown_read_doc`: read soon after a search that returned it, it is the hit having helped. */
export interface ReadRecord {
  kind: "read";
  time: string;
  scope: string;
  /** Relative to the docs dir, as `LoggedHit.path` is. */
  path: string;
}

export type QueryRecord = SearchRecord | ReadRecord;

/**
 * The opt-in record of how search is used (`RAGDOWN_QUERY_LOG`, or the web UI's server settings):
 * every search and hook call with its hits, and every read, as JSON lines in the data dir. Never
 * sent anywhere. Off, it writes nothing. Each process appends on its own, so a reader and the
 * primary share one file; an append is one `write`, which keeps their lines whole.
 */
export class QueryLog {
  readonly path: string;
  private readonly config: Config;
  private failed = false;

  constructor(config: Config) {
    this.config = config;
    this.path = join(config.dataDir, QUERY_LOG_FILE);
  }

  get enabled(): boolean {
    return this.config.queryLog;
  }

  /** Record a search, when the log is on. */
  search(record: Omit<SearchRecord, "kind" | "time">): void {
    if (this.enabled) {
      this.append({ kind: "search", time: new Date().toISOString(), ...record });
    }
  }

  /** Record a read, when the log is on. */
  read(scope: string, path: string): void {
    if (this.enabled) {
      this.append({ kind: "read", time: new Date().toISOString(), scope, path });
    }
  }

  /** Every record, oldest first, the rotated file's included; a line that does not parse is skipped. */
  async records(): Promise<QueryRecord[]> {
    const records: QueryRecord[] = [];
    for (const file of [`${this.path}.1`, this.path]) {
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch (error) {
        if (hasCode(error, "ENOENT")) {
          continue;
        }
        throw error;
      }
      for (const line of text.split("\n")) {
        if (!line) {
          continue;
        }
        try {
          const record: unknown = JSON.parse(line);
          if (isRecord(record) && (record.kind === "search" || record.kind === "read")) {
            records.push(record as unknown as QueryRecord);
          }
        } catch {
          // A line cut short by a crash mid-write.
        }
      }
    }
    return records;
  }

  /** Delete every record. */
  async clear(): Promise<void> {
    await rm(this.path, { force: true });
    await rm(`${this.path}.1`, { force: true });
  }

  private append(record: QueryRecord): void {
    const line = `${JSON.stringify(record)}\n`;
    try {
      const size = statSync(this.path, { throwIfNoEntry: false })?.size ?? 0;
      if (size > 0 && size + line.length > defaults.queryLogMaxBytes) {
        renameSync(this.path, `${this.path}.1`);
      }
      appendFileSync(this.path, line);
      this.failed = false;
    } catch (error) {
      // Said once, not on every search: a log that cannot be written must not fail the search.
      if (!this.failed) {
        console.error(`[ragdown] cannot write the query log ${this.path}: ${errorMessage(error)}`);
      }
      this.failed = true;
    }
  }
}

/**
 * A hit as the log keeps it.
 *
 * @param dir - the scope's directory relative to the docs dir, which the hit's path is relative
 *   to; undefined at the root endpoint, whose hits each name their folder.
 */
export function loggedHit(hit: Hit, dir: string | undefined): LoggedHit {
  return {
    path: docsPath(dir ?? hit.folder ?? "", hit.path),
    lines: [hit.lineStart, hit.lineEnd],
    similarity: round(hit.similarity),
    score: round(hit.score),
    sources: hit.sources,
  };
}

/** A path relative to the scope's directory, made relative to the docs dir. */
export function docsPath(dir: string, path: string): string {
  return dir ? posix.join(dir, path) : path;
}

/** What the log records of a hook call's trace. */
export function loggedTrace(
  trace: HookTrace,
  dir: string | undefined,
): NonNullable<SearchRecord["hook"]> {
  return {
    ...(trace.skipped ? { skipped: trace.skipped } : {}),
    min_score: trace.minScore,
    seen: trace.seen,
    below_min_score: trace.belowMinScore,
    below_ratio: trace.belowRatio,
    over_top_k: trace.overTopK,
    over_budget: trace.overBudget,
    injected: trace.injected.map((hit) => loggedHit(hit, dir)),
  };
}

const round = (value: number) => Number(value.toFixed(4));
