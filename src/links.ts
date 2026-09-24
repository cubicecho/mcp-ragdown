import { posix } from "node:path";
import { MARKDOWN } from "./indexer.ts";

/** A note a wikilink may point at, relative to the folder. */
export interface LinkNote {
  path: string;
  aliases: string[];
}

export interface ResolvedLink {
  /** Relative to the folder, `/`-separated: a note or an attachment. */
  path: string;
  /** The heading after `#`, when the link names one. Block references (`#^id`) are dropped. */
  anchor?: string;
}

/**
 * The target and heading of a wikilink, from any of `[[Note]]`, `![[Note#Heading|shown]]`, or the
 * bare `Note#Heading` inside the brackets. An empty target is a link to a heading of the same note.
 */
export function parseLink(raw: string): { target: string; anchor: string | undefined } {
  let text = raw.trim();
  if (text.startsWith("!")) text = text.slice(1);
  if (text.startsWith("[[") && text.endsWith("]]")) text = text.slice(2, -2);
  text = text.split("|")[0] ?? "";
  const hash = text.indexOf("#");
  const target = (hash === -1 ? text : text.slice(0, hash)).trim();
  let anchor = hash === -1 ? undefined : text.slice(hash + 1).trim();
  if (!anchor || anchor.startsWith("^")) anchor = undefined;
  return { target: normalize(target), anchor };
}

/**
 * Resolve a wikilink the way Obsidian does, within one folder: an exact path (with or without
 * `.md`, or relative to the linking note), then a note or attachment whose name — or trailing
 * path — matches, then a note that lists it as an alias. Ties between name matches go to the one
 * beside the linking note, then the shortest path, then the first alphabetically. Case is ignored
 * except to prefer an exact match.
 *
 * @param from the linking note, relative to the folder; decides ties and relative links.
 * @param attachments every non-Markdown file in the folder, relative to it.
 */
export function resolveLink(
  raw: string,
  from: string | undefined,
  notes: LinkNote[],
  attachments: string[] = [],
): ResolvedLink | undefined {
  const { target, anchor } = parseLink(raw);
  const withAnchor = (path: string): ResolvedLink => (anchor ? { path, anchor } : { path });
  if (!target) return from ? withAnchor(from) : undefined;

  const fromDir = from ? posix.dirname(from) : ".";
  const notePaths = notes.map((note) => note.path);
  const all = [...notePaths, ...attachments];
  const wanted = [target, ...(fromDir !== "." ? [posix.normalize(`${fromDir}/${target}`)] : [])];
  const markdown = (path: string) => (MARKDOWN.test(path) ? [path] : [path, `${path}.md`]);

  // Exact paths, case-sensitive first.
  for (const insensitive of [false, true]) {
    for (const want of wanted.flatMap(markdown)) {
      const key = insensitive ? want.toLowerCase() : want;
      const hit = all.find((path) => (insensitive ? path.toLowerCase() : path) === key);
      if (hit) return withAnchor(hit);
    }
  }

  // By name, or by trailing path for `sub/Note`.
  const needle = target.toLowerCase();
  const matches = (name: string) => {
    const lower = name.toLowerCase();
    return lower === needle || lower.endsWith(`/${needle}`);
  };
  const byName = [
    ...notePaths.filter((path) => matches(stripMarkdown(path)) || matches(path)),
    ...attachments.filter(matches),
  ];
  const best = pick(byName, fromDir);
  if (best) return withAnchor(best);

  const byAlias = notes
    .filter((note) => note.aliases.some((alias) => alias.toLowerCase() === needle))
    .map((note) => note.path);
  const alias = pick(byAlias, fromDir);
  return alias ? withAnchor(alias) : undefined;
}

function pick(paths: string[], fromDir: string): string | undefined {
  return [...new Set(paths)].sort((a, b) => {
    const sameA = posix.dirname(a) === fromDir ? 0 : 1;
    const sameB = posix.dirname(b) === fromDir ? 0 : 1;
    return sameA - sameB || a.length - b.length || a.localeCompare(b);
  })[0];
}

function stripMarkdown(path: string): string {
  return path.replace(MARKDOWN, "");
}

/** `/`-separated, without a leading `./` or `/`, and URL escapes (`%20`) decoded when valid. */
function normalize(target: string): string {
  let text = target.replaceAll("\\", "/");
  try {
    text = decodeURIComponent(text);
  } catch {
    // Not an escape sequence, just a `%` in a name.
  }
  const normalized = posix.normalize(text).replace(/^(\.\/|\/)+/, "");
  return normalized === "." ? "" : normalized;
}
