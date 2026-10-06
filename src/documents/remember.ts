import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { hasCode } from "../shared/errors.ts";
import { isInside, toPosix } from "./document-paths.ts";

/** What `writeRemembered` needs to write one new document. */
export interface RememberInput {
  /** The scope's absolute directory: what `supersedes` paths are relative to. */
  root: string;
  /** The absolute directory the document is written in. */
  notesDir: string;
  title: string;
  content: string;
  tags: string[];
  /** The file name without extension; defaults to the date and a slug of the title. */
  name: string | undefined;
  supersedes: string[];
  sessionId: string | undefined;
}

/**
 * Write a new document with its frontmatter, never over an existing file: a numeric suffix is added
 * to the name instead.
 *
 * @returns the absolute path written, and of each document it supersedes.
 */
export async function writeRemembered({
  root,
  notesDir,
  title,
  content,
  tags,
  name,
  supersedes,
  sessionId,
}: RememberInput): Promise<{ full: string; replaced: string[] }> {
  const date = new Date().toISOString().slice(0, 10);
  const base = name ?? `${date}-${slug(title)}`;

  // Checked before anything is written: a dangling `supersedes` would silently hide nothing, and
  // the agent that got the path wrong should hear about it rather than believe it replaced a
  // document.
  const replaced = await Promise.all(
    supersedes.map(async (path) => {
      const target = resolve(root, path);
      if (!isInside(root, target)) {
        throw new Error(`supersedes is outside the documents folder: ${path}`);
      }
      if (!(await stat(target).catch(() => undefined))?.isFile()) {
        throw new Error(`supersedes names no document in this folder: ${path}`);
      }
      return target;
    }),
  );

  let full = "";
  for (let n = 1; ; n++) {
    full = resolve(notesDir, `${base}${n === 1 ? "" : `-${n}`}.md`);
    if (!isInside(notesDir, full)) {
      throw new Error(`document name escapes the documents folder: ${base}`);
    }
    const front = [
      "---",
      `title: ${JSON.stringify(title)}`,
      `date: ${date}`,
      ...(tags.length > 0 ? [`tags: [${tags.map((t) => JSON.stringify(t)).join(", ")}]`] : []),
      // Relative to this document's own folder, which is how the indexer reads them back.
      ...(replaced.length > 0
        ? [
            `supersedes: [${replaced
              .map((target) => JSON.stringify(toPosix(relative(dirname(full), target))))
              .join(", ")}]`,
          ]
        : []),
      // Provenance: a document an agent wrote is not a document the user wrote, and whoever reads
      // it later — person or model — should be able to tell which one they are holding.
      "created_by: ragdown_remember",
      ...(sessionId ? [`session: ${JSON.stringify(sessionId)}`] : []),
      "---",
      "",
    ].join("\n");
    await mkdir(dirname(full), { recursive: true });
    try {
      await writeFile(full, `${front}${content.trimEnd()}\n`, { flag: "wx" });
      break;
    } catch (error) {
      if (!hasCode(error, "EEXIST")) {
        throw error;
      }
    }
  }
  return { full, replaced };
}

function slug(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "note"
  );
}
