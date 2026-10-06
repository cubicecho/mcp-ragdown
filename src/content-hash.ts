import { createHash } from "node:crypto";

/**
 * The hash of a document's contents: what the index compares to tell a changed file, what a read
 * returns as `hash`, and what a write checks a `baseHash` against.
 */
export function contentHash(contents: Buffer | string): string {
  return createHash("sha256").update(contents).digest("hex");
}
