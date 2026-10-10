import type { Scope } from "../documents/scope.ts";
import { shortHash } from "../shared/content-hash.ts";

type Read = Awaited<ReturnType<Scope["readDocument"]>>;
type Written = Awaited<ReturnType<Scope["writeDocument"]>>;
type Edited = Awaited<ReturnType<Scope["edit"]>>;
type Remembered = Awaited<ReturnType<Scope["remember"]>>;
type Moved = Awaited<ReturnType<Scope["move"]>>;
type Listed = Awaited<ReturnType<Scope["listDocuments"]>>;

/**
 * What the document tools answer an agent with: text, since a model reads it and pays for every
 * character. A document's own text is never inside JSON, where each newline and quote would be
 * escaped and an agent would have to undo that to quote a passage back to `ragdown_edit`.
 *
 * A document read: one line saying where the text is from and the file's hash, then the text.
 */
export function formatDocument(doc: Read): string {
  const notes = [
    `hash ${shortHash(doc.hash)}`,
    ...(doc.resolved_from ? [`resolved from ${JSON.stringify(doc.resolved_from)}`] : []),
    ...(doc.superseded_by ? [`superseded by ${doc.superseded_by.join(", ")}`] : []),
  ];
  const header = `${doc.path}:${doc.start_line}-${doc.end_line} of ${doc.total_lines} (${notes.join(", ")})`;
  return `${header}\n${doc.text}`;
}

/** A whole-file write or an append, with the hash the next change is made against. */
export function formatWritten(written: Written): string {
  const did = written.created ? "created" : "wrote";
  return `${did} ${written.path} (hash ${shortHash(written.hash)})`;
}

/** An edit: how many passages were swapped, and the hash the next change is made against. */
export function formatEdited(edited: Edited): string {
  return `edited ${edited.path} (replaced ${edited.replaced}, hash ${shortHash(edited.hash)})`;
}

/** A new document, by the path it was given. */
export function formatRemembered(remembered: Remembered): string {
  const supersedes = remembered.supersedes
    ? ` (supersedes ${remembered.supersedes.join(", ")})`
    : "";
  return `saved ${remembered.path}${supersedes}`;
}

/** A move, and the documents whose links to what moved were rewritten. */
export function formatMoved(moved: Moved): string {
  const updated = moved.updated.length > 0 ? `; links updated in ${moved.updated.join(", ")}` : "";
  return `moved ${moved.from} to ${moved.to}${updated}`;
}

/** The documents of a listing, one to a line, under a line that counts them. */
export function formatList(listed: Listed): string {
  if (listed.total === 0) {
    return "No documents.";
  }
  const shown = listed.documents.length;
  const count = shown < listed.total ? `${shown} of ${listed.total}` : `${listed.total}`;
  return [`documents: ${count}`, ...listed.documents.map(formatListed)].join("\n");
}

function formatListed(doc: Listed["documents"][number]): string {
  const tags = doc.tags ? ` [${doc.tags.map((tag) => `#${tag}`).join(" ")}]` : "";
  const notes = [
    `changed ${doc.modified.slice(0, "2026-09-15".length)}`,
    ...(doc.created_by ? [`written by an agent with ${doc.created_by}`] : []),
    ...(doc.session ? [`session ${doc.session}`] : []),
    ...(doc.aliases ? [`aliases ${doc.aliases.join(", ")}`] : []),
    ...(doc.superseded_by ? [`superseded by ${doc.superseded_by.join(", ")}`] : []),
  ];
  const description = doc.description ? `: ${doc.description}` : "";
  return `${doc.path} — ${doc.title}${tags} (${notes.join(", ")})${description}`;
}
