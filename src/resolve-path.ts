import { lstat, mkdir, realpath } from "node:fs/promises";
import { join, posix } from "node:path";
import { isIndexedName, isInside, MARKDOWN } from "./document-paths.ts";
import { Refusal } from "./refusal.ts";

/**
 * Resolve a path a client wants to write, delete or download, relative to `scopeRoot`. Refused with
 * a 400 unless the indexer would walk to it: no dot-segment or `node_modules`, inside the folder,
 * and no symlink or file on the way — the indexer does not follow symlinks, and a write through
 * one could land outside the docs. Resolved against the folder's real path, as `openScope` does.
 *
 * @param scopeRoot the scope's absolute directory.
 * @param create make the missing folders on the way.
 * @param markdownOnly also require a Markdown extension, as for anything that is written.
 */
export async function resolvePath(
  scopeRoot: string,
  path: string,
  { create, markdownOnly }: { create: boolean; markdownOnly: boolean },
) {
  const invalid = (why: string) => new Refusal(400, `${why}: ${path}`);
  const posixPath = path.replaceAll("\\", "/");
  if (!posixPath || posix.isAbsolute(posixPath) || /^[a-z]:/i.test(posixPath)) {
    throw invalid("path must be relative to the docs folder");
  }
  const segments = posix
    .normalize(posixPath)
    .split("/")
    .filter((segment) => segment && segment !== ".");
  if (segments.length === 0 || segments.includes("..")) {
    throw invalid("path is outside the docs folder");
  }
  if (segments.some((segment) => !isIndexedName(segment))) {
    throw invalid("path names a folder or file the index skips");
  }
  if (markdownOnly && !MARKDOWN.test(segments.at(-1) ?? "")) {
    throw invalid("only Markdown files (.md, .markdown, .mdx) can be written");
  }

  const root = await realpath(scopeRoot);
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    let info = await lstat(current).catch(() => undefined);
    if (!info && create) {
      await mkdir(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") {
          throw error;
        }
      });
      info = await lstat(current);
    }
    if (!info) {
      break;
    }
    if (!info.isDirectory()) {
      throw invalid("a folder on the path is a file or a symlink");
    }
  }
  const full = join(root, ...segments);
  if (!isInside(root, full)) {
    throw invalid("path is outside the docs folder");
  }
  return { full, relPath: segments.join("/") };
}
