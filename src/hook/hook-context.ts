import { formatHit } from "../indexing/format.ts";
import { exactNames, holdsName } from "../indexing/identifiers.ts";
import { callsByAlias, capPerDocument, type Hit } from "../indexing/store.ts";
import { defaults } from "../shared/defaults.ts";
import type { HookSettings } from "./hook-settings.ts";

/** What the hook did with one prompt, gate by gate: what the query log records of a hook call. */
export interface HookTrace {
  /** Why nothing was searched: a prompt too short to retrieve on, or a slash command. */
  skipped?: "short" | "command";
  /** The floor this call applied. */
  minScore: number;
  /** What search returned, before any gate. */
  candidates: Hit[];
  /** Dropped because the session was already given them. */
  seen: number;
  /** Dropped by `minScore`. */
  belowMinScore: number;
  /** Dropped by `minRatio`. */
  belowRatio: number;
  /** Passed the gates, but past `topK` once the per-document cap had ordered them. */
  overTopK: number;
  /** Past `maxChars`. */
  overBudget: number;
  /** What the block holds. */
  injected: Hit[];
}

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
  /** Told what each gate did, once the block is built; for the query log. */
  trace?: (trace: HookTrace) => void;
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
  trace,
}: HookContextInput): Promise<string | undefined> {
  const { topK, minScore, minRatio, maxChars } = settings;
  const trimmed = prompt.trim();
  // A slash command or a one-word reply ("yes", "go on") has nothing to retrieve on.
  const skipped =
    trimmed.length < defaults.minPromptChars ? "short" : trimmed.startsWith("/") ? "command" : null;
  if (skipped) {
    trace?.({ ...EMPTY_TRACE, minScore, skipped });
    return undefined;
  }

  const seen = seenBy();
  const found = await recall(trimmed, topK * 2);
  const candidates = found.filter((hit) => !seen.has(hit.id));
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
  const close = ranked.filter((hit) => hit.similarity >= best * minRatio);
  // Search capped the candidates by fused rank; re-sorted by cosine, one document can lead again.
  const hits = capPerDocument([...named, ...close], perDocument, (hit) => hit.path).slice(0, topK);

  const blocks: string[] = [];
  const injected: Hit[] = [];
  let used = 0;
  for (const hit of hits) {
    const block = formatHit(hit, Math.min(textLimit, maxChars));
    if (blocks.length > 0 && used + block.length > maxChars) {
      break;
    }
    blocks.push(block);
    injected.push(hit);
    used += block.length;
    seen.add(hit.id);
  }
  trace?.({
    minScore,
    candidates: found,
    seen: found.length - candidates.length,
    belowMinScore: candidates.length - named.length - ranked.length,
    belowRatio: ranked.length - close.length,
    overTopK: named.length + close.length - hits.length,
    overBudget: hits.length - injected.length,
    injected,
  });
  if (injected.length === 0) {
    return undefined;
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

const EMPTY_TRACE: Omit<HookTrace, "minScore"> = {
  candidates: [],
  seen: 0,
  belowMinScore: 0,
  belowRatio: 0,
  overTopK: 0,
  overBudget: 0,
  injected: [],
};
