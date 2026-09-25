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

/** A link found in a note's text by `findLinks`. */
export interface LinkRef {
  /** `wiki` for `[[…]]` and `![[…]]`, `markdown` for `[text](path)` to a relative path. */
  kind: "wiki" | "markdown";
  /** What goes to `resolveLink` (a wikilink's inside) or is a relative path (a Markdown link's). */
  raw: string;
  /** The target alone, before any `#heading` or `|shown`, as written, and where it sits in the text. */
  target: string;
  targetStart: number;
  targetEnd: number;
  /** 1-based. */
  line: number;
}

/**
 * Every wikilink, and every Markdown link to a relative path, in a note's text. Links in fenced code
 * or inline code are left out, as a renderer leaves them.
 */
export function findLinks(text: string): LinkRef[] {
  const out: LinkRef[] = [];
  let fence: string | null = null;
  let offset = 0;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const start = offset;
    offset += line.length + 1;
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch?.[1]) {
      const marker = fenceMatch[1];
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;
    // Inline code blanked out, keeping every offset.
    const masked = line.replace(/(`+)[^`]*?\1/g, (code) => " ".repeat(code.length));
    for (const match of masked.matchAll(/!?\[\[([^[\]\n]+?)\]\]/g)) {
      const inner = match[1] ?? "";
      const target = inner.split(/[|#]/)[0] ?? "";
      const at = start + (match.index ?? 0) + match[0].indexOf("[[") + 2;
      out.push({
        kind: "wiki",
        raw: inner,
        target,
        targetStart: at,
        targetEnd: at + target.length,
        line: i + 1,
      });
    }
    for (const match of masked.matchAll(/\[[^\]\n]*\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g)) {
      const url = match[1] ?? "";
      if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("#") || url.startsWith("/")) continue;
      const target = url.split("#")[0] ?? "";
      const at = start + (match.index ?? 0) + match[0].indexOf(url, match[0].indexOf("]("));
      out.push({
        kind: "markdown",
        raw: url,
        target,
        targetStart: at,
        targetEnd: at + target.length,
        line: i + 1,
      });
    }
  }
  return out;
}

/**
 * Where a link found by `findLinks` in the note `from` points, within one folder: a wikilink as
 * `resolveLink` does, a Markdown link only as a path relative to `from`.
 */
export function resolveRef(
  ref: LinkRef,
  from: string,
  notes: LinkNote[],
  attachments: string[] = [],
): string | undefined {
  if (ref.kind === "wiki") return resolveLink(ref.raw, from, notes, attachments)?.path;
  const path = normalize(posix.join(posix.dirname(from), normalize(ref.target)));
  if (!path || path.startsWith("../")) return undefined;
  return notes.some((note) => note.path === path) || attachments.includes(path) ? path : undefined;
}
