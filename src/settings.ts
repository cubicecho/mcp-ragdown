import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { errorMessage } from "./errors.ts";
import {
  embedderMinScore,
  type HookChanges,
  type HookOverrides,
  mergeHookChanges,
  parseHookChanges,
  resolveHook,
} from "./hook-settings.ts";
import { Refusal } from "./refusal.ts";
import { writeAtomic } from "./write-atomic.ts";

/**
 * The server-wide settings the web UI can change, kept beside the folders rather than with the
 * index: the index is disposable and these are not. A dot-file, so the indexer never reads it.
 */
export const SERVER_SETTINGS_FILE = ".ragdown-server.json";

/** What the file holds: only the values set in the UI. Each one wins over its variable. */
export interface ServerSettings {
  embedder?: string;
  watch?: boolean;
  text_limit?: number;
  hook?: HookOverrides;
}

/** A change to the saved settings: a `null` takes the value away, so the variable applies again. */
export interface SettingsChanges {
  embedder?: string | null;
  watch?: boolean | null;
  text_limit?: number | null;
  hook?: HookChanges;
}

const invalid = (message: string) => new Refusal(400, message);

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

/**
 * The saved settings that are valid. A missing file is no settings; a bad file or a bad value is
 * logged and skipped, so the variable applies rather than the server failing to start.
 */
export async function readServerSettings(docsDir: string): Promise<ServerSettings> {
  const path = join(docsDir, SERVER_SETTINGS_FILE);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return {};
  }
  try {
    const raw: unknown = JSON.parse(text);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("not a JSON object");
    }
    return applyChanges({}, parseChanges(raw as Record<string, unknown>));
  } catch (error) {
    console.error(`[ragdown] ignoring ${path}, using the environment: ${errorMessage(error)}`);
    return {};
  }
}

/** Write the saved settings, or remove the file when none is left. */
export async function writeServerSettings(
  docsDir: string,
  settings: ServerSettings,
): Promise<void> {
  const path = join(docsDir, SERVER_SETTINGS_FILE);
  if (Object.keys(settings).length === 0) {
    await rm(path, { force: true });
    return;
  }
  await writeAtomic(path, `${JSON.stringify(settings, null, 2)}\n`);
}

/**
 * Check a request body, or a settings file, value by value.
 *
 * @throws with `status: 400` naming the first value that cannot be what its key holds.
 */
export function parseChanges(body: Record<string, unknown> | undefined): SettingsChanges {
  const out: SettingsChanges = {};
  if (body?.embedder !== undefined && body.embedder !== null) {
    if (typeof body.embedder !== "string" || !body.embedder.trim()) {
      throw invalid("embedder must be the name of an embedder");
    }
    out.embedder = body.embedder.trim();
  } else if (body?.embedder === null) {
    out.embedder = null;
  }
  if (body?.watch !== undefined) {
    if (body.watch !== null && typeof body.watch !== "boolean") {
      throw invalid("watch must be true or false");
    }
    out.watch = body.watch;
  }
  if (body?.text_limit !== undefined) {
    if (body.text_limit !== null && !isCount(body.text_limit)) {
      throw invalid("text_limit must be a non-negative integer");
    }
    out.text_limit = body.text_limit;
  }
  if (body?.hook !== undefined) {
    out.hook = parseHookChanges(body.hook);
  }
  return out;
}

/** The saved settings after `changes`: a key the change does not name is kept, a `null` is dropped. */
export function applyChanges(saved: ServerSettings, changes: SettingsChanges): ServerSettings {
  const out: ServerSettings = { ...saved };
  if (changes.embedder === null) {
    delete out.embedder;
  } else if (changes.embedder !== undefined) {
    out.embedder = changes.embedder;
  }
  if (changes.watch === null) {
    delete out.watch;
  } else if (changes.watch !== undefined) {
    out.watch = changes.watch;
  }
  if (changes.text_limit === null) {
    delete out.text_limit;
  } else if (changes.text_limit !== undefined) {
    out.text_limit = changes.text_limit;
  }
  if (changes.hook) {
    const hook = mergeHookChanges(saved.hook ?? {}, changes.hook);
    if (Object.keys(hook).length > 0) {
      out.hook = hook;
    } else {
      delete out.hook;
    }
  }
  return out;
}

/**
 * Lay the saved settings over what the environment said, in place: the routes and tools read
 * `config` on each call, so a change is in effect as soon as this returns. The embedder and the
 * watcher also have state of their own, which the engine changes (`switchEmbedder`, `setWatch`).
 */
export function applySettings(config: Config, saved: ServerSettings): void {
  const env = config.env;
  config.saved = saved;
  config.embedder = saved.embedder ?? env.embedder;
  config.watch = saved.watch ?? env.watch;
  config.textLimit = saved.text_limit ?? env.textLimit;
  config.hook = resolveHook({}, saved.hook ?? {}, {
    ...env.hook,
    // Unset everywhere, the floor is the embedder's own, so it moves when the embedder does.
    minScore: env.hook.minScore ?? embedderMinScore(config.embedder),
  });
}
