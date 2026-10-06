import { sep } from "node:path";

/** The files the indexer reads; anything else in the folder is ignored. */
export const MARKDOWN = /\.(md|markdown|mdx)$/i;

/** True for a directory entry the indexer passes over: a dot-entry or `node_modules`. */
export function isSkippedEntry(name: string): boolean {
  return name.startsWith(".") || name === "node_modules";
}

/** True for a path segment the indexer walks into: not a skipped entry, and one segment only. */
export function isIndexedName(name: string): boolean {
  return !isSkippedEntry(name) && !/[/\\\0]/.test(name);
}

/** True when `child` is `parent` or somewhere below it; both must be absolute and resolved. */
export function isInside(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

/** A relative path with `/` separators, which is what frontmatter and the index both use. */
export function toPosix(path: string): string {
  return path.split(sep).join("/");
}
