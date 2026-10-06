import { scoreScale } from "./embedder.ts";
import { isRecord } from "./json.ts";
import { Refusal } from "./refusal.ts";

/** The defaults `ragdown_context` runs with once every layer has had its say. */
export interface HookSettings {
  topK: number;
  minScore: number;
  /** Lowest share of the best hit's similarity a hit may have and still be injected; 0 disables. */
  minRatio: number;
  maxChars: number;
}

/** Per-call overrides of `context`'s defaults: the folder's own, else the server's. */
export type ContextOptions = Partial<HookSettings>;

/** The hook defaults as a settings file may set them, named as the tool's arguments are. */
export interface HookOverrides {
  top_k?: number;
  min_score?: number;
  min_ratio?: number;
  max_chars?: number;
}

/** A change to saved hook defaults: a `null` takes the value away, so the layer below applies. */
export type HookChanges = { [K in keyof HookOverrides]?: number | null };

/** Every key of `HookOverrides`, for the code that walks them. */
export const HOOK_KEYS = ["top_k", "min_score", "min_ratio", "max_chars"] as const;

/** The floor for an embedder nobody measured: the default model's, which is a guess. */
const UNMEASURED_MIN_SCORE = 0.8;

/**
 * The similarity floor that goes with an embedder when no setting names one. Cosine is on each
 * model's own scale, so this is the embedder's own measured floor where there is one.
 */
export function embedderMinScore(embedder: string): number {
  return scoreScale(embedder)?.minScore ?? UNMEASURED_MIN_SCORE;
}

/**
 * Why `value` cannot be the hook default `key`, held to what `RAGDOWN_HOOK_*` accepts.
 *
 * @returns The reason, or undefined when the value is fine.
 */
export function hookValueError(key: keyof HookOverrides, value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return `${key} must be a number`;
  if (key === "min_score") return undefined;
  if (key === "min_ratio") {
    return value < 0 || value > 1 ? `${key} must be between 0 and 1` : undefined;
  }
  return Number.isInteger(value) && value >= 0
    ? undefined
    : `${key} must be a non-negative integer`;
}

/** The overrides in a settings file that are valid; a bad one is skipped, so the default applies. */
export function readHookOverrides(raw: unknown): HookOverrides {
  const hook: HookOverrides = {};
  if (!isRecord(raw)) return hook;
  for (const key of HOOK_KEYS) {
    const value = raw[key];
    if (typeof value === "number" && !hookValueError(key, value)) hook[key] = value;
  }
  return hook;
}

/**
 * Check the `hook` of a request body, or of a settings file, value by value.
 *
 * @throws A `Refusal` (400) naming the first value that cannot be what its key holds.
 */
export function parseHookChanges(raw: unknown): HookChanges {
  if (!isRecord(raw)) throw new Refusal(400, "hook must be an object");
  const changes: HookChanges = {};
  for (const key of HOOK_KEYS) {
    const value = raw[key];
    if (value === undefined) continue;
    if (value !== null && typeof value !== "number")
      throw new Refusal(400, `${key} must be a number`);
    const error = value === null ? undefined : hookValueError(key, value);
    if (error) throw new Refusal(400, error);
    changes[key] = value;
  }
  return changes;
}

/**
 * The saved hook defaults after `changes`: a key the change does not name is kept, a `null` is
 * dropped. Keys of `saved` that are not hook defaults are kept as they are.
 */
export function mergeHookChanges(saved: HookOverrides, changes: HookChanges): HookOverrides {
  const merged: HookOverrides = { ...saved };
  for (const key of HOOK_KEYS) {
    const value = changes[key];
    if (value === null) delete merged[key];
    else if (value !== undefined) merged[key] = value;
  }
  return merged;
}

/**
 * The hook defaults for one layer laid over the next: each value is the first that is set, from
 * the call's own arguments, then `overrides` (a folder's, or the server's saved ones), then `base`.
 */
export function resolveHook(
  call: ContextOptions,
  overrides: HookOverrides,
  base: HookSettings,
): HookSettings {
  return {
    topK: call.topK ?? overrides.top_k ?? base.topK,
    minScore: call.minScore ?? overrides.min_score ?? base.minScore,
    minRatio: call.minRatio ?? overrides.min_ratio ?? base.minRatio,
    maxChars: call.maxChars ?? overrides.max_chars ?? base.maxChars,
  };
}
