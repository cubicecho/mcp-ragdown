import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { isSkippedEntry, MARKDOWN, toPosix } from "./document-paths.ts";

/**
 * Every file under `root` a wikilink may embed that is not a document: images, PDFs and the like,
 * by `/`-separated relative path. Skips what the indexer skips.
 */
export async function listAttachments(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch((): Dirent[] => []);
    for (const entry of entries) {
      if (isSkippedEntry(entry.name)) {
        continue;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && !MARKDOWN.test(entry.name)) {
        out.push(toPosix(relative(root, full)));
      }
    }
  };
  await walk(root);
  return out;
}
