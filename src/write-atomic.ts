import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Write a file so that a reader sees the old contents or the new, never half of either: written
 * beside it and renamed over it. The temp file's dot name keeps the indexer and the watcher off it.
 *
 * @param mode - The permission bits of the new file; the process's default when left out.
 */
export async function writeAtomic(path: string, contents: string, mode?: number): Promise<void> {
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, contents, mode === undefined ? {} : { mode });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
