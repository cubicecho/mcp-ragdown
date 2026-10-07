import { breadcrumb } from "../documents/chunk.ts";
import type { Hit } from "./store.ts";

/**
 * One block per hit, for pasting into a prompt. A hit longer than `maxChars` is cut, and the cut
 * always names the call that returns the rest: a model handed an unmarked fragment concludes the
 * documents are incomplete and goes looking elsewhere.
 */
export function formatHits(hits: Hit[], maxChars: number): string {
  if (hits.length === 0) {
    return "No matching documents.";
  }
  return hits.map((hit, i) => `[${i + 1}] ${formatHit(hit, maxChars)}`).join("\n\n");
}

/**
 * One hit as text: where it is, its tags, similarity and the day its file last changed, then its
 * text cut to `maxChars`. The date is what lets a reader doubt an old fact; a document an agent
 * wrote says so, since a reader should weigh it differently from one the user wrote.
 */
export function formatHit(hit: Hit, maxChars: number): string {
  const where = breadcrumb(hit.title, hit.heading);
  const tags = hit.tags.length > 0 ? ` [${hit.tags.map((tag) => `#${tag}`).join(" ")}]` : "";
  const author = hit.createdBy ? `, written by an agent with ${hit.createdBy}` : "";
  const header = `${hit.path}:${hit.lineStart}-${hit.lineEnd} — ${where}${tags} (similarity ${hit.similarity.toFixed(2)}, changed ${day(hit.mtimeMs)}${author})`;
  return `${header}\n${clip(hit, maxChars)}`;
}

/** The JSON shape of a hit: snake_case, rounded, and without the internal id. */
export function hitJson(hit: Hit) {
  return {
    path: hit.path,
    title: hit.title,
    heading: hit.heading,
    line_start: hit.lineStart,
    line_end: hit.lineEnd,
    similarity: Number(hit.similarity.toFixed(4)),
    score: Number(hit.score.toFixed(5)),
    sources: hit.sources,
    tags: hit.tags,
    modified: new Date(hit.mtimeMs).toISOString(),
    ...(hit.createdBy ? { created_by: hit.createdBy } : {}),
    text: hit.text,
  };
}

/** The UTC day of a time, as `2026-09-15`. */
function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function clip(hit: Hit, maxChars: number): string {
  if (maxChars <= 0 || hit.text.length <= maxChars) {
    return hit.text;
  }
  const call = `ragdown_read_doc {path: ${JSON.stringify(hit.path)}, start_line: ${hit.lineStart}, end_line: ${hit.lineEnd}}`;
  return `${hit.text.slice(0, maxChars)}… [clipped: ${maxChars} of ${hit.text.length} characters — ${call}]`;
}
