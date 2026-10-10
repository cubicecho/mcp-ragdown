import { Refusal } from "../shared/refusal.ts";

/** One change to part of a document: an exact passage, and the text that takes its place. */
export interface Replacement {
  oldText: string;
  /** Empty to delete the passage. */
  newText: string;
  /** Replace every occurrence of `oldText`, where otherwise it must occur exactly once. */
  replaceAll?: boolean;
}

/**
 * `text` with each replacement made in order, each on the result of the one before. Line endings
 * are compared as `\n`, which is how `readDocument` returns a CRLF file, and the result has `\n`.
 *
 * @returns the new text, and `replaced`: how many passages were swapped.
 * @throws with `status: 400` for a replacement that changes nothing, `404` for a passage the text
 *   does not have, and `409` for one it has more than once without `replaceAll`.
 */
export function applyReplacements(
  text: string,
  replacements: Replacement[],
): { text: string; replaced: number } {
  let next = withUnixNewlines(text);
  let replaced = 0;
  for (const [index, replacement] of replacements.entries()) {
    const which = `edit ${index + 1} of ${replacements.length}`;
    const oldText = withUnixNewlines(replacement.oldText);
    const newText = withUnixNewlines(replacement.newText);
    if (oldText === newText) {
      throw new Refusal(
        400,
        `${which}: old_text and new_text are the same, so nothing was written`,
      );
    }

    const pieces = next.split(oldText);
    const occurrences = pieces.length - 1;
    if (occurrences === 0) {
      const nearest = nearestPassage(next, oldText);
      // Lines are numbered as on disk only until an earlier edit has moved them.
      const lines = nearest && index === 0 ? ` (lines ${nearest.start}-${nearest.end})` : "";
      const fix = nearest
        ? `The nearest passage${lines} follows; copy old_text from it exactly:\n${nearest.text}`
        : "It must match character for character, whitespace included: read the document again and copy the passage from it";
      throw new Refusal(
        404,
        `${which}: old_text is not in the document, so nothing was written. ${fix}`,
      );
    }
    const isAmbiguous = occurrences > 1 && replacement.replaceAll !== true;
    if (isAmbiguous) {
      throw new Refusal(
        409,
        `${which}: old_text is in the document ${occurrences} times, so nothing was written. Add the text around the one you mean until it matches once, or pass replace_all: true`,
      );
    }

    next = pieces.join(newText);
    replaced += occurrences;
  }
  return { text: next, replaced };
}

/** A passage of a text, with the 1-based, inclusive lines it is on. */
interface Passage {
  start: number;
  end: number;
  text: string;
}

/**
 * The passage of `text` an `oldText` that matched nothing most likely meant, so that the refusal
 * can show it and the agent need not read the document again. It is the passage that differs from
 * `oldText` only in whitespace, or else the lines from the one `oldText` starts with.
 */
function nearestPassage(text: string, oldText: string): Passage | undefined {
  const words = oldText.split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return undefined;
  }
  const spacedAnyhow = new RegExp(words.map(escapeRegExp).join("\\s+")).exec(text);
  if (spacedAnyhow) {
    const start = text.slice(0, spacedAnyhow.index).split("\n").length;
    const end = start + spacedAnyhow[0].split("\n").length - 1;
    return { start, end, text: spacedAnyhow[0] };
  }

  const oldLines = oldText.trim().split("\n");
  const firstLine = (oldLines[0] ?? "").trim();
  const lines = text.split("\n");
  const first = lines.findIndex((line) => line.trim() === firstLine);
  if (first === -1) {
    return undefined;
  }
  const passage = lines.slice(first, first + oldLines.length);
  return { start: first + 1, end: first + passage.length, text: passage.join("\n") };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function withUnixNewlines(text: string): string {
  return text.replaceAll("\r\n", "\n");
}
