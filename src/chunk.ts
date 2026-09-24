import { basename, extname, posix } from "node:path";

/**
 * Bumped whenever chunk boundaries or the embedded text change, so an existing index built by the
 * old rules is rebuilt instead of mixing two kinds of chunk.
 */
export const CHUNKER_VERSION = 2;

/**
 * 1500 characters is roughly 350–450 tokens of prose: inside the window of every embedder here —
 * 512 tokens for the smallest of them — with room for the heading line, and still one idea's worth
 * of text rather than a whole page.
 */
export const MAX_CHUNK_CHARS = 1500;

export interface Chunk {
  /** Position within the file, from 0. */
  index: number;
  /** The document title: frontmatter `title`, else the first H1, else the file name. */
  title: string;
  /** Heading breadcrumb, e.g. `Setup › Replication`; empty for text before the first heading. */
  heading: string;
  /** The chunk's own text, as written in the file. */
  text: string;
  /** 1-based, inclusive, counted in the original file (frontmatter included). */
  lineStart: number;
  lineEnd: number;
}

interface Section {
  heading: string;
  lines: string[];
  lineStart: number;
}

/**
 * Split a Markdown document into heading-scoped chunks.
 *
 * Every heading starts a section, and a section longer than `maxChars` is packed paragraph by
 * paragraph into several chunks. A heading with no text of its own produces nothing: its name
 * survives in the breadcrumb of the sections below it. A file with no text at all is one chunk. `#` lines inside fenced code are code.
 */
export function chunkMarkdown(
  source: string,
  relPath: string,
  maxChars = MAX_CHUNK_CHARS,
): Chunk[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const { title: frontTitle, bodyStart } = readFrontmatter(lines);

  const sections: Section[] = [];
  const stack: string[] = [];
  let current: Section = { heading: "", lines: [], lineStart: bodyStart + 1 };
  let fence: string | null = null;
  let firstH1: string | undefined;

  for (let i = bodyStart; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch?.[1]) {
      const marker = fenceMatch[1];
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
    }
    const headingMatch = fence === null ? /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (headingMatch?.[1] && headingMatch[2]) {
      sections.push(current);
      const level = headingMatch[1].length;
      const name = headingMatch[2];
      if (level === 1 && firstH1 === undefined) firstH1 = name;
      stack.length = level - 1;
      stack[level - 1] = name;
      current = { heading: stack.filter(Boolean).join(" › "), lines: [], lineStart: i + 2 };
      continue;
    }
    current.lines.push(line);
  }
  sections.push(current);

  const title = frontTitle ?? firstH1 ?? basename(relPath, extname(relPath));
  const chunks: Chunk[] = [];
  for (const section of sections) {
    for (const piece of splitSection(section, maxChars)) {
      chunks.push({ index: chunks.length, title, heading: section.heading, ...piece });
    }
  }
  if (chunks.length === 0) {
    // Headings only, or empty. Still one chunk: a file with no rows is unknown to the index, so
    // every sync would count it as new, and a stub of headings is still findable by its title.
    const body = lines.slice(bodyStart).join("\n").trim();
    chunks.push({
      index: 0,
      title,
      heading: "",
      text: body || title,
      lineStart: bodyStart + 1,
      lineEnd: Math.max(bodyStart + 1, lines.length),
    });
  }
  return chunks;
}

/**
 * The text given to the embedder: title and breadcrumb first, so a chunk that says "run it twice"
 * under `Backups › Restore` is found by a question about restoring backups.
 */
export function embeddingText(chunk: Pick<Chunk, "title" | "heading" | "text">): string {
  return `${breadcrumb(chunk.title, chunk.heading)}\n\n${chunk.text}`;
}

/**
 * Title and heading path as one line. The heading path usually starts with the document's H1, which
 * is also its title; that repeat is dropped.
 */
export function breadcrumb(title: string, heading: string): string {
  if (!heading || heading === title) return title;
  return heading.startsWith(`${title} › `) ? heading : `${title} › ${heading}`;
}

/**
 * The notes this one replaces, as paths relative to the docs root.
 *
 * A path in the frontmatter is relative to the note's own folder, the way a Markdown link is, so a
 * sibling note is just its file name. One that climbs out of the docs folder is dropped rather than
 * followed: the frontmatter is data from a file, not a path the server should trust.
 */
export function readSupersedes(source: string, relPath: string): string[] {
  const { supersedes } = readFrontmatter(source.replace(/\r\n?/g, "\n").split("\n"));
  const dir = posix.dirname(relPath.replaceAll("\\", "/"));
  const out: string[] = [];
  for (const entry of supersedes) {
    const relative = entry.replaceAll("\\", "/");
    // Checked before the join, which would otherwise turn `/etc/passwd` into `notes/etc/passwd`.
    if (posix.isAbsolute(relative)) continue;
    const path = posix.normalize(posix.join(dir === "." ? "" : dir, relative));
    if (path === ".." || path.startsWith("../")) continue;
    out.push(path);
  }
  return out;
}

/**
 * The document's tags and aliases, as Obsidian reads them: frontmatter `tags` (a list, or a string
 * of comma- or space-separated tags, `#` optional) plus inline `#tags` in the body outside code, and
 * frontmatter `aliases` (a list, or one alias as a string). Tags are lowercased without the `#`.
 *
 * Stored beside the chunks as metadata, never added to the embedded text: that was measured and
 * did not pay for its rebuild.
 */
export function readDocMeta(source: string): { tags: string[]; aliases: string[] } {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const { front, bodyStart } = readFrontmatter(lines);
  const tags = new Set<string>();
  const addTag = (raw: string) => {
    const tag = raw.trim().replace(/^#+/, "").replace(/\/+$/, "").toLowerCase();
    if (tag && /^[\p{L}\p{N}_\-/]+$/u.test(tag) && !/^[\p{N}/]+$/u.test(tag)) tags.add(tag);
  };
  for (const entry of readList(front, "tags", /[\s,]+/)) addTag(entry);

  let fence: string | null = null;
  for (let i = bodyStart; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch?.[1]) {
      const marker = fenceMatch[1];
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null || /^( {4}|\t)/.test(line)) continue;
    // Inline code spans are code too: `#include` is not a tag.
    const prose = line.replace(/(`+)[^`]*?\1/g, " ");
    for (const match of prose.matchAll(/(?:^|\s)#([\p{L}\p{N}_\-/]+)/gu)) addTag(match[1] ?? "");
  }

  const aliases = [...new Set(readList(front, "aliases").filter(Boolean))];
  return { tags: [...tags].sort(), aliases };
}

function readFrontmatter(lines: string[]): {
  title: string | undefined;
  supersedes: string[];
  front: string[];
  bodyStart: number;
} {
  if (lines[0]?.trim() !== "---") {
    return { title: undefined, supersedes: [], front: [], bodyStart: 0 };
  }
  const end = lines.findIndex((line, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(line));
  if (end === -1) return { title: undefined, supersedes: [], front: [], bodyStart: 0 };
  const front = lines.slice(1, end);
  let title: string | undefined;
  for (const line of front) {
    const titleMatch = /^title:\s*(.+?)\s*$/.exec(line);
    if (titleMatch?.[1]) title = unquote(titleMatch[1]);
  }
  return { title, supersedes: readList(front, "supersedes", /,/), front, bodyStart: end + 1 };
}

/**
 * A top-level frontmatter key as a list of strings: `key: [a, "b"]`, a block of `- a` lines, or a
 * scalar, which is one item unless `split` separates several.
 */
function readList(front: string[], key: string, split?: RegExp): string[] {
  const out: string[] = [];
  const pattern = new RegExp(`^${key}:\\s*(.*)$`);
  for (let i = 0; i < front.length; i++) {
    const match = pattern.exec(front[i] ?? "");
    if (!match) continue;
    const inline = (match[1] ?? "").trim();
    if (inline.startsWith("[")) {
      for (const item of inline.slice(1).replace(/]\s*$/, "").split(",")) {
        const value = unquote(item.trim());
        if (value) out.push(value);
      }
    } else if (inline) {
      const value = unquote(inline);
      out.push(
        ...(split
          ? value
              .split(split)
              .map((item) => unquote(item.trim()))
              .filter(Boolean)
          : [value]),
      );
    } else {
      // The block form: `- a` lines until something that is not a list item.
      for (let j = i + 1; j < front.length; j++) {
        const item = /^\s*-\s*(.+?)\s*$/.exec(front[j] ?? "");
        if (!item?.[1]) break;
        out.push(unquote(item[1]));
        i = j;
      }
    }
  }
  return out;
}

function unquote(value: string): string {
  return value.replace(/^(["'])(.*)\1$/, "$2");
}

type Piece = Pick<Chunk, "text" | "lineStart" | "lineEnd">;

function splitSection(section: Section, maxChars: number): Piece[] {
  // Paragraphs are runs of lines between blank lines, except that a fenced block is one paragraph
  // however many blank lines it holds: cutting a code sample in half ruins both halves.
  const paragraphs: Piece[] = [];
  let buffer: string[] = [];
  let bufferStart = 0;
  let fence: string | null = null;
  const flush = (endIndex: number) => {
    if (buffer.some((line) => line.trim() !== "")) {
      paragraphs.push({
        text: buffer.join("\n"),
        lineStart: section.lineStart + bufferStart,
        lineEnd: section.lineStart + endIndex - 1,
      });
    }
    buffer = [];
  };
  section.lines.forEach((line, i) => {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch?.[1]) {
      const marker = fenceMatch[1];
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
    }
    if (line.trim() === "" && fence === null) {
      flush(i);
      bufferStart = i + 1;
      return;
    }
    if (buffer.length === 0) bufferStart = i;
    buffer.push(line);
  });
  flush(section.lines.length);

  const pieces: Piece[] = [];
  let open: Piece | undefined;
  for (const paragraph of paragraphs.flatMap((p) => hardSplit(p, maxChars))) {
    if (open && open.text.length + 2 + paragraph.text.length <= maxChars) {
      open = {
        text: `${open.text}\n\n${paragraph.text}`,
        lineStart: open.lineStart,
        lineEnd: paragraph.lineEnd,
      };
    } else {
      if (open) pieces.push(open);
      open = paragraph;
    }
  }
  if (open) pieces.push(open);
  return pieces;
}

/** Cut a paragraph longer than `maxChars` at line boundaries, and a single huge line by length. */
function hardSplit(paragraph: Piece, maxChars: number): Piece[] {
  if (paragraph.text.length <= maxChars) return [paragraph];
  const out: Piece[] = [];
  let text = "";
  let start = paragraph.lineStart;
  paragraph.text.split("\n").forEach((line, offset) => {
    const lineNo = paragraph.lineStart + offset;
    if (text && text.length + 1 + line.length > maxChars) {
      out.push({ text, lineStart: start, lineEnd: lineNo - 1 });
      text = "";
    }
    if (!text) start = lineNo;
    for (let rest = line; ; ) {
      if (text.length + rest.length <= maxChars) {
        text = text ? `${text}\n${rest}` : rest;
        break;
      }
      const room = maxChars - text.length;
      out.push({ text: text + rest.slice(0, room), lineStart: start, lineEnd: lineNo });
      text = "";
      start = lineNo;
      rest = rest.slice(room);
    }
  });
  if (text) out.push({ text, lineStart: start, lineEnd: paragraph.lineEnd });
  return out;
}
