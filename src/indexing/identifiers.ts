/**
 * Names in a query: a quoted command, a key, a path, a flag. An embedding blurs them and BM25 finds
 * them exactly, so `Store.search` leans on BM25 for a query that holds one, and the hook keeps a
 * chunk that holds one verbatim whatever its cosine (`scripts/bench/fusion.ts`).
 */

/**
 * One alternative per shape: a backtick span; words joined by `_ . / : =` (`max_batch`, `app.ts`,
 * `src/cli.ts`, `4.2`); camelCase and PascalCase with a capital inside (`fetchUser`, `KeyError`); a
 * flag (`--dry-run`); letters and digits in one word (`k8s`, `v2`); a hyphenated word with a digit
 * (`utf-8`). Hyphenated words without one are left out: `up-to-date` is English, and a kebab-case
 * name in prose is usually also a phrase.
 */
const SHAPE =
  /`[^`\n]+`|[\p{L}\p{N}]+(?:[_./:=][\p{L}\p{N}]+)+|(?<![\p{L}\p{N}])\p{Lu}?\p{Ll}+\p{Lu}[\p{L}\p{N}]*|(?<!\S)--?\p{L}[\p{L}\p{N}-]*|(?<![\p{L}\p{N}])[\p{L}\p{N}]*(?:\p{L}\p{N}|\p{N}\p{L})[\p{L}\p{N}]*|(?<![\p{L}\p{N}-])[\p{L}\p{N}]*\p{N}[\p{L}\p{N}]*-[\p{L}\p{N}-]+|(?<![\p{L}\p{N}-])[\p{L}\p{N}]+-[\p{L}\p{N}]*\p{N}[\p{L}\p{N}]*/gu;

/** Shapes that are prose after all: `e.g.`, `1st`, `10:30`. */
const PROSE = /^(?:(?:\p{L}\.)+\p{L}?|\d+(?:st|nd|rd|th)|\d{1,2}:\d{2})$/iu;

function shapesIn(query: string): string[] {
  return [...query.matchAll(SHAPE)]
    .map((match) => match[0].trim())
    .filter((name) => !PROSE.test(name.replace(/\.$/, "")));
}

/** Whether a query names something exactly, and so should be ranked mostly by BM25. */
export function namesSomething(query: string): boolean {
  return shapesIn(query).length > 0;
}

/**
 * The names in a query that are strong enough to keep a chunk on their own. Weaker than
 * `namesSomething`: a plain word in backticks (`` `typescript` ``) or an unquoted number (`4.2`)
 * says which way to rank but is too common to vouch for a chunk.
 */
export function exactNames(query: string): string[] {
  const names = shapesIn(query).flatMap((shape) => {
    if (!shape.startsWith("`")) {
      const name = shape.replace(/[.,:;]+$/, "");
      // "after the 4.2 release" is prose; a version quoted in backticks is not.
      return /^[\d.]+$/.test(name) ? [] : [name];
    }
    const inner = shape.slice(1, -1).trim();
    // Quoted, a command, a URL, a version or a kebab-case name is exact as a whole; a word is not.
    return /^\p{L}+$/u.test(inner) ? [] : [inner];
  });
  return [...new Set(names.map((name) => name.toLowerCase()).filter((name) => name.length >= 3))];
}

/** Whether `text` holds one of `names` as a whole name, not inside a longer one. Case-insensitive. */
export function holdsName(text: string, names: string[]): boolean {
  if (names.length === 0) {
    return false;
  }
  const lower = text.toLowerCase();
  return names.some((name) => {
    for (let at = lower.indexOf(name); at !== -1; at = lower.indexOf(name, at + 1)) {
      const before = lower[at - 1] ?? " ";
      const after = lower[at + name.length] ?? " ";
      if (!/[\p{L}\p{N}_]/u.test(before) && !/[\p{L}\p{N}_]/u.test(after)) {
        return true;
      }
    }
    return false;
  });
}
