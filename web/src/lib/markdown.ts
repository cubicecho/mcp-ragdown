/**
 * The YAML frontmatter of a note, split from its body. Only the flat `key: value` lines ragdown
 * itself writes are read — a preview needs the title and tags, not a YAML parser.
 */
export function splitFrontmatter(source: string): { fields: [string, string][]; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
  if (!match) return { fields: [], body: source };
  const fields: [string, string][] = [];
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const field = /^([\w-]+):\s*(.*)$/.exec(line);
    if (field?.[1] && field[2]) fields.push([field[1], unquote(field[2])]);
  }
  return { fields, body: source.slice(match[0].length) };
}

/** `["a", "b"]` or `[a, b]` as a list, anything else as one value. */
export function listValue(value: string): string[] {
  const inner = /^\[(.*)\]$/.exec(value)?.[1];
  if (inner === undefined) return [value];
  return inner
    .split(",")
    .map((item) => unquote(item.trim()))
    .filter(Boolean);
}

function unquote(value: string): string {
  const quoted = /^"(.*)"$/.exec(value) ?? /^'(.*)'$/.exec(value);
  if (!quoted?.[1]) return value;
  try {
    return value.startsWith('"') ? (JSON.parse(value) as string) : quoted[1];
  } catch {
    return quoted[1];
  }
}

/**
 * Where a link in `from` points, as a root-relative path (`work/notes/a.md`), or undefined when it
 * leaves the docs directory, has a scheme, or is only an anchor.
 */
export function resolveDocLink(from: string, href: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#") || href.startsWith("//")) {
    return undefined;
  }
  const target = decodeSafe(href.split("#")[0]?.split("?")[0] ?? "");
  if (!target) return undefined;
  // A leading `/` is the note's own folder, the way a folder opened as its own notes app reads it.
  const parts = target.startsWith("/") ? from.split("/").slice(0, 1) : from.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}

/** The URL schemes the wikilink plugin marks its links and embeds with, for the renderer. */
export const WIKILINK = "wikilink:";
export const WIKIEMBED = "wikiembed:";

const MARKDOWN_FILE = /\.(md|markdown|mdx)$/i;
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i;

/** A path with no extension is a note, as it is in a wikilink. */
export const isMarkdownPath = (path: string) =>
  MARKDOWN_FILE.test(path) || !/\.[^/.]+$/.test(path.split("/").pop() ?? "");

export const isImagePath = (path: string) => IMAGE_FILE.test(path);

/** `Note#Heading|shown` → the target the server resolves, and the text to show. */
export function parseWikilink(inner: string): { target: string; shown: string } {
  const bar = inner.indexOf("|");
  const target = (bar === -1 ? inner : inner.slice(0, bar)).trim();
  const alias = bar === -1 ? "" : inner.slice(bar + 1).trim();
  // Shown without the `#^block` or `#Heading` part, the way Obsidian draws an unaliased link.
  const plain = target.replace(/#\^.*$/, "").replace(/#/, " › ");
  return { target, shown: alias || plain || target };
}

const WIKI = /(!?)\[\[([^[\]\n]+?)\]\]/g;

type MdNode = { type: string; value?: string; children?: MdNode[]; [key: string]: unknown };

/**
 * A remark plugin: `[[Note]]`, `[[Note|shown]]` and `[[Note#Heading]]` become links to
 * `wikilink:<target>`, and `![[image.png]]` an image of `wikiembed:<target>`. The renderer asks the
 * server where those go. Only text is rewritten, so a wikilink in code stays as written.
 */
export function remarkWikilinks() {
  const walk = (node: MdNode) => {
    if (!node.children || node.type === "link" || node.type === "linkReference") return;
    const next: MdNode[] = [];
    for (const child of node.children) {
      if (child.type !== "text" || !child.value?.includes("[[")) {
        walk(child);
        next.push(child);
        continue;
      }
      const text = child.value;
      let last = 0;
      for (const match of text.matchAll(WIKI)) {
        const index = match.index ?? 0;
        if (index > last) next.push({ type: "text", value: text.slice(last, index) });
        const { target, shown } = parseWikilink(match[2] ?? "");
        const url = `${match[1] ? WIKIEMBED : WIKILINK}${encodeURIComponent(target)}`;
        next.push(
          match[1]
            ? { type: "image", url, alt: shown }
            : { type: "link", url, children: [{ type: "text", value: shown }] },
        );
        last = index + match[0].length;
      }
      if (last < text.length) next.push({ type: "text", value: text.slice(last) });
    }
    node.children = next;
  };
  return (tree: MdNode) => walk(tree);
}

/** A heading's anchor: lowercase, words joined by `-`, which is what `[[Note#Heading]]` aims at. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");
}

function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
