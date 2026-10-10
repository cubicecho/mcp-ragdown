import { createHash } from "node:crypto";
import { defaults } from "./defaults.ts";

/**
 * The hash of a document's contents: what the index compares to tell a changed file, what a read
 * returns as `hash`, and what a write checks a `baseHash` against.
 */
export function contentHash(contents: Buffer | string): string {
  return createHash("sha256").update(contents).digest("hex");
}

/** A hash as an agent is shown it: its first `defaults.shortHashChars` characters. */
export function shortHash(hash: string): string {
  return hash.slice(0, defaults.shortHashChars);
}

/**
 * Whether `baseHash` names the version of a document that `hash` is of. A `baseHash` is the whole
 * hash, as the web UI sends it, or the start of it that `shortHash` gave an agent.
 */
export function isVersion(hash: string, baseHash: string): boolean {
  return baseHash.length >= defaults.shortHashChars && hash.startsWith(baseHash);
}
