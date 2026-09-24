import { breadcrumb } from "./chunk.ts";
import type { Hit } from "./store.ts";

/**
 * One block per hit, for pasting into a prompt. A hit longer than `maxChars` is cut, and the cut
 * always names the call that returns the rest: a model handed an unmarked fragment concludes the
 * notes are incomplete and goes looking elsewhere.
 */
export function formatHits(hits: Hit[], maxChars: number): string {
  if (hits.length === 0) return "No matching notes.";
  return hits.map((hit, i) => `[${i + 1}] ${formatHit(hit, maxChars)}`).join("\n\n");
}

export function formatHit(hit: Hit, maxChars: number): string {
  const where = breadcrumb(hit.title, hit.heading);
  const tags = hit.tags.length > 0 ? ` [${hit.tags.map((tag) => `#${tag}`).join(" ")}]` : "";
  const header = `${hit.path}:${hit.lineStart}-${hit.lineEnd} — ${where}${tags} (similarity ${hit.similarity.toFixed(2)})`;
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
    text: hit.text,
  };
}

function clip(hit: Hit, maxChars: number): string {
  if (maxChars <= 0 || hit.text.length <= maxChars) return hit.text;
  const call = `ragdown_read_doc {path: ${JSON.stringify(hit.path)}, start_line: ${hit.lineStart}, end_line: ${hit.lineEnd}}`;
  return `${hit.text.slice(0, maxChars)}… [clipped: ${maxChars} of ${hit.text.length} characters — ${call}]`;
}
