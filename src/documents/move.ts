import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, posix, relative, resolve } from "node:path";
import { hasCode } from "../shared/errors.ts";
import { Refusal } from "../shared/refusal.ts";
import { writeAtomic } from "../shared/write-atomic.ts";
import { listAttachments } from "./attachments.ts";
import { isInside, MARKDOWN, toPosix } from "./document-paths.ts";
import { findLinks, type LinkDocument, type LinkRef, resolveLink, resolveRef } from "./links.ts";
import { resolvePath } from "./resolve-path.ts";

/** What `moveInFolder` needs of the scope a move was asked of. */
export interface MoveInput {
  docsDir: string;
  /** The folder the scope is in, relative to the docs root; empty when the docs dir is the folder. */
  folder: string;
  /** The scope's absolute directory: what `from` and `to` are relative to. */
  root: string;
  /** Every document in the folder, relative to it. */
  documents: LinkDocument[];
  from: string;
  to: string;
}

/**
 * Move a document or a subfolder on disk and rewrite the links in its folder that the move would
 * break. `Scope.move` says what is promised about the links.
 *
 * @returns where it was, where it is, and the other documents rewritten, each relative to the folder.
 */
export async function moveInFolder({
  docsDir,
  folder,
  root,
  documents,
  from,
  to,
}: MoveInput): Promise<{ from: string; to: string; updated: string[] }> {
  const anywhere = await resolvePath(root, from, { create: false, markdownOnly: false });
  const isFolder = (await lstat(anywhere.full).catch(() => undefined))?.isDirectory() === true;
  const source = isFolder
    ? anywhere
    : await resolvePath(root, from, { create: false, markdownOnly: true });
  const dest = await resolvePath(root, to, { create: false, markdownOnly: !isFolder });
  const info = await lstat(source.full).catch(() => undefined);
  if (!info || !(isFolder || info.isFile())) {
    throw new Refusal(404, `no such note or folder: ${from}`);
  }
  if (source.full === dest.full) {
    throw new Refusal(400, `${from} is already there`);
  }
  if (isFolder && isInside(source.full, dest.full)) {
    throw new Refusal(400, `cannot move ${from} into itself`);
  }
  // A case-only rename on a case-insensitive disk finds the source itself at `to`: that is fine.
  const occupied = await lstat(dest.full).catch(() => undefined);
  if (occupied && (occupied.ino !== info.ino || occupied.dev !== info.dev)) {
    throw new Refusal(409, `already exists: ${to}`);
  }

  const prefix = folder ? `${folder}/` : "";
  const inFolder = (full: string) => toPosix(relative(docsDir, full)).slice(prefix.length);
  const oldPath = inFolder(source.full);
  const newPath = inFolder(dest.full);
  /** Where a file in the folder is after the move: itself, unless it is what moves or under it. */
  const moved = (path: string) => {
    if (path === oldPath) {
      return newPath;
    }
    return isFolder && path.startsWith(`${oldPath}/`)
      ? `${newPath}${path.slice(oldPath.length)}`
      : path;
  };
  const before = [...documents];
  if (!isFolder && !before.some((document) => document.path === oldPath)) {
    before.push({ path: oldPath, aliases: [] });
  }
  const after = before.map((document) => ({ ...document, path: moved(document.path) }));
  const attachments = await listAttachments(resolve(docsDir, folder));
  const attachmentsAfter = attachments.map(moved);

  // Every document's new text, read and rewritten before anything is written.
  const rewrites = new Map<string, { original: string; text: string }>();
  for (const document of before) {
    const full = resolve(docsDir, `${prefix}${document.path}`);
    const original = await readFile(full, "utf8").catch(() => undefined);
    if (original === undefined) {
      continue;
    }
    const from = document.path;
    const at = moved(from);
    const edits: { start: number; end: number; text: string }[] = [];
    for (const ref of findLinks(original)) {
      const was = resolveRef(ref, from, before, attachments);
      if (!was) {
        continue;
      }
      const want = moved(was);
      if (resolveRef(ref, at, after, attachmentsAfter) === want) {
        continue;
      }
      edits.push({
        start: ref.targetStart,
        end: ref.targetEnd,
        text: linkTarget(ref, want, at, after, attachmentsAfter),
      });
    }
    let text = original;
    for (const edit of edits.reverse()) {
      text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
    }
    if (text !== original || from === oldPath) {
      rewrites.set(from, { original, text });
    }
  }

  await mkdir(dirname(dest.full), { recursive: true });
  if (isFolder) {
    // One rename carries the documents, the attachments and whatever else is in there.
    await rename(source.full, dest.full);
  } else {
    const document = rewrites.get(oldPath);
    if (!document) {
      throw new Refusal(404, `no such note: ${from}`);
    }
    if (occupied) {
      await rename(source.full, dest.full);
      if (document.text !== document.original) {
        await writeFile(dest.full, document.text);
      }
    } else {
      try {
        await writeFile(dest.full, document.text, { flag: "wx" });
      } catch (error) {
        if (!hasCode(error, "EEXIST")) {
          throw error;
        }
        throw new Refusal(409, `already exists: ${to}`);
      }
      await unlink(source.full);
    }
    rewrites.delete(oldPath);
  }

  const updated: string[] = [];
  for (const [path, { original, text }] of rewrites) {
    const full = resolve(docsDir, `${prefix}${moved(path)}`);
    // Changed since it was read, by an editor or an agent: theirs wins, and this link is not
    // fixed.
    if ((await readFile(full, "utf8").catch(() => undefined)) !== original) {
      continue;
    }
    await writeAtomic(full, text);
    updated.push(moved(path));
  }
  return { from: oldPath, to: newPath, updated };
}

/**
 * What to write in place of a link's target so it points at `want` from the document at `from`. A
 * Markdown link gets the relative path; a wikilink, the shortest trailing part of the path that
 * resolves there, keeping `.md` if the link had it.
 */
function linkTarget(
  ref: LinkRef,
  want: string,
  from: string,
  documents: LinkDocument[],
  attachments: string[],
): string {
  if (ref.kind === "markdown") {
    return encodeURI(posix.relative(posix.dirname(from), want))
      .replaceAll("(", "%28")
      .replaceAll(")", "%29");
  }
  const document = MARKDOWN.test(want);
  const keepExtension = document && MARKDOWN.test(ref.target);
  const bare = document && !keepExtension ? want.replace(MARKDOWN, "") : want;
  const segments = bare.split("/");
  for (let k = 1; k <= segments.length; k++) {
    const candidate = segments.slice(-k).join("/");
    if (resolveLink(candidate, from, documents, attachments)?.path === want) {
      return candidate;
    }
  }
  return bare;
}
