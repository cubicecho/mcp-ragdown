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
 * Where a link in `from` points, as a docs-relative path, or undefined when it leaves the folder,
 * is absolute, or is only an anchor.
 */
export function resolveDocLink(from: string, href: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#") || href.startsWith("//")) {
    return undefined;
  }
  const target = decodeSafe(href.split("#")[0]?.split("?")[0] ?? "");
  if (!target) return undefined;
  const parts = target.startsWith("/") ? [] : from.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}

function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
