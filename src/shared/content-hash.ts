import { createHash } from "node:crypto";
import { defaults } from "./defaults.ts";
import { Refusal } from "./refusal.ts";

/** The characters of a whole hash: a SHA-256 in hex. */
const HASH_CHARS = 64;

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

/**
 * Refuses a `baseHash` that could not be the hash of any version, saying what is wrong with it.
 * Without this such a value would only fail to match, and be reported as a document that changed.
 *
 * @throws with `status: 400` for a `baseHash` that is not hex, or is shorter than a short hash or
 *   longer than a whole one.
 */
export function checkBaseHash(baseHash: string): void {
  const shown = JSON.stringify(baseHash.slice(0, HASH_CHARS));
  const isHex = /^[0-9a-f]*$/.test(baseHash);
  const isTooShort = baseHash.length < defaults.shortHashChars;
  const isTooLong = baseHash.length > HASH_CHARS;
  if (isHex && !isTooShort && !isTooLong) {
    return;
  }
  let why = `it is ${baseHash.length} characters, and a whole hash is ${HASH_CHARS}`;
  if (!isHex) {
    why = "a hash has only the characters 0-9 and a-f";
  } else if (isTooShort) {
    why = `it is ${baseHash.length} characters, too few to name one version`;
  }
  throw new Refusal(
    400,
    `base_hash ${shown} is not a document's hash: ${why}, so nothing was changed. Pass the ${defaults.shortHashChars} characters after "hash" in the first line ragdown_read_doc returns, or in the result of the last write, exactly as they are`,
  );
}
