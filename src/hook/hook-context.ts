import { formatHit } from "../indexing/format.ts";
import { exactNames, holdsName } from "../indexing/identifiers.ts";
import { callsByAlias, capPerDocument, type Hit } from "../indexing/store.ts";
import { defaults } from "../shared/defaults.ts";
import type { HookSettings } from "./hook-settings.ts";

/** What `hookContext` needs of the scope it answers for. */
export interface HookContextInput {
  prompt: string;
  /** The scope's absolute directory, named in the block so the reader knows where it came from. */
  source: string;
  settings: HookSettings;
  /** The most characters of one chunk, before `settings.maxChars` is applied. */
  textLimit: number;
  /** The most chunks of one document in the block, as search caps them; 0 is no cap. */
  perDocument: number;
  /**
   * The ids of the chunks this session was already given; the ones returned here are added. Asked
   * for only once the prompt is worth a search, so a one-word reply does not touch the session.
   */
  seenBy: () => Set<string>;
  recall: (query: string, topK: number) => Promise<Hit[]>;
}

/**
 * The context block a hook injects for a prompt, or undefined when nothing is similar enough or the
 * prompt has nothing to retrieve on.
 */
export async function hookContext({
  prompt,
  source,
  settings,
  textLimit,
  perDocument,
  seenBy,
  recall,
}: HookContextInput): Promise<string | undefined> {
  const { topK, minScore, minRatio, maxChars } = settings;
  const trimmed = prompt.trim();
  // A slash command or a one-word reply ("yes", "go on") has nothing to retrieve on.
  if (trimmed.length < defaults.minPromptChars || trimmed.startsWith("/")) {
    return undefined;
  }

  const seen = seenBy();
  const candidates = (await recall(trimmed, topK * 2)).filter((hit) => !seen.has(hit.id));
  // A chunk the prompt points at exactly is kept whatever its cosine, the best-ranked one of each
  // kind only: one that holds a name the prompt quotes, which can sit below either gate since
  // everything around the name is prose the prompt does not share; and one of a document the
  // prompt calls by an alias, which the embedder has never seen.
  const names = exactNames(trimmed);
  const named = [
    ...new Set(
      [
        candidates.find((hit) => holdsName(`${hit.title}\n${hit.heading}\n${hit.text}`, names)),
        candidates.find((hit) => callsByAlias(trimmed, hit.aliases)),
      ].filter((hit) => hit !== undefined),
    ),
  ];
  const ranked = candidates
    .filter((hit) => !named.includes(hit) && hit.similarity >= minScore)
    .sort((a, b) => b.similarity - a.similarity);
  // Then the relative floor: whatever the best hit scored, a hit well below it is noise beside
  // it, and injected noise costs accuracy rather than merely costing tokens.
  const best = ranked[0]?.similarity ?? 0;
  // Search capped the candidates by fused rank; re-sorted by cosine, one document can lead again.
  const hits = capPerDocument(
    [...named, ...ranked.filter((hit) => hit.similarity >= best * minRatio)],
    perDocument,
    (hit) => hit.path,
  ).slice(0, topK);
  if (hits.length === 0) {
    return undefined;
  }

  const blocks: string[] = [];
  let used = 0;
  for (const hit of hits) {
    const block = formatHit(hit, Math.min(textLimit, maxChars));
    if (blocks.length > 0 && used + block.length > maxChars) {
      break;
    }
    blocks.push(block);
    used += block.length;
    seen.add(hit.id);
  }
  return [
    `<ragdown-context source="${source}">`,
    "Excerpts from the user's Markdown documents that look related to this prompt, found by search, not chosen by the user.",
    "They may be irrelevant or out of date: each says when its file last changed. Use ragdown_read_doc for the whole file before relying on a fragment.",
    "",
    blocks.join("\n\n"),
    "</ragdown-context>",
  ].join("\n");
}
