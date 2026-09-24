import type { Dirent } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "./errors.ts";
import { MARKDOWN } from "./indexer.ts";

/** A folder's settings file, at its root. A dot-file: Obsidian and the indexer both skip it. */
export const SETTINGS_FILE = ".ragdown.json";

/** What a folder's `.ragdown.json` says, with the defaults filled in. */
export interface FolderSettings {
  /** Shown in the UI and the MCP instructions; the directory name when unset. */
  title: string;
  /** Whether `/mcp/<folder>` serves it. Off until someone turns it on: a new folder is human-only. */
  mcp: boolean;
}

export interface Folder extends FolderSettings {
  /** The directory name, which is also the `/mcp/<name>` segment. */
  name: string;
}

/** Names the UI may create or rename to. Folders already on disk are discovered whatever their name. */
const CREATABLE = /^[A-Za-z0-9_][A-Za-z0-9 _.-]{0,63}$/;

/** Settings files already reported as invalid, keyed by path and contents, so each is logged once. */
const reported = new Set<string>();

/** True for a directory entry the indexer walks into: not a dot-entry and not `node_modules`. */
export function isIndexedName(name: string): boolean {
  return !name.startsWith(".") && name !== "node_modules" && !/[/\\\0]/.test(name);
}

/** @throws with `status: 400` unless `name` is one the UI may create a folder under. */
export function assertCreatableName(name: string): void {
  if (!CREATABLE.test(name) || name.trim() !== name || name === "node_modules") {
    throw Object.assign(
      new Error(
        `not a valid folder name: ${JSON.stringify(name)} (letters, digits, space, _ . -; up to 64; not starting with . or -)`,
      ),
      { status: 400 },
    );
  }
}

/**
 * The folder's settings. A missing file means the defaults; so does an invalid one, which is
 * logged once rather than failing every request that reads it.
 */
export async function readSettings(dir: string, name: string): Promise<FolderSettings> {
  const raw = await readRaw(dir);
  return {
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : name,
    mcp: raw.mcp === true,
  };
}

async function readRaw(dir: string): Promise<Record<string, unknown>> {
  const path = join(dir, SETTINGS_FILE);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    throw new Error("not a JSON object");
  } catch (error) {
    const key = `${path}\0${text}`;
    if (!reported.has(key)) {
      reported.add(key);
      console.error(`[ragdown] ignoring ${path}, using defaults: ${errorMessage(error)}`);
    }
    return {};
  }
}

/**
 * The folders of a docs dir: every top-level directory the indexer walks into, sorted by name.
 * Symlinks are not folders, as the indexer does not follow them.
 */
export async function listFolders(docsDir: string): Promise<Folder[]> {
  const entries = await readdir(docsDir, { withFileTypes: true }).catch(() => [] as Dirent[]);
  const folders = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && isIndexedName(entry.name))
      .map(async (entry) => ({
        name: entry.name,
        ...(await readSettings(join(docsDir, entry.name), entry.name)),
      })),
  );
  return folders.sort((a, b) => a.name.localeCompare(b.name));
}

/** One folder by name, or undefined when there is no such folder. */
export async function getFolder(docsDir: string, name: string): Promise<Folder | undefined> {
  if (!isIndexedName(name) || !name) return undefined;
  const dir = join(docsDir, name);
  if (!(await lstat(dir).catch(() => undefined))?.isDirectory()) return undefined;
  return { name, ...(await readSettings(dir, name)) };
}

/** Markdown directly in the docs dir, outside every folder: in folders mode, never indexed. */
export async function looseFiles(docsDir: string): Promise<string[]> {
  const entries = await readdir(docsDir, { withFileTypes: true }).catch(() => [] as Dirent[]);
  return entries
    .filter((entry) => entry.isFile() && isIndexedName(entry.name) && MARKDOWN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Make a folder and its settings file.
 *
 * @throws with `status: 400` for a bad name, `409` when something by that name exists.
 */
export async function createFolder(
  docsDir: string,
  name: string,
  settings: Partial<FolderSettings> = {},
): Promise<Folder> {
  assertCreatableName(name);
  const dir = join(docsDir, name);
  try {
    await mkdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw Object.assign(new Error(`already exists: ${name}`), { status: 409 });
  }
  // `mcp` written out even when off, so whoever opens the file sees the switch.
  await writeSettings(dir, {}, { mcp: false, ...settings });
  return { name, ...(await readSettings(dir, name)) };
}

/**
 * Change a folder's settings, keeping any keys in the file this version does not know, and with
 * `rename` move the directory.
 *
 * @throws with `status: 404` for no such folder, `400` for a bad new name, `409` when it is taken.
 */
export async function updateFolder(
  docsDir: string,
  name: string,
  changes: Partial<FolderSettings> & { rename?: string },
): Promise<{ folder: Folder; renamed: boolean }> {
  if (!(await getFolder(docsDir, name))) {
    throw Object.assign(new Error(`no such folder: ${name}`), { status: 404 });
  }
  let current = name;
  if (changes.rename !== undefined && changes.rename !== name) {
    assertCreatableName(changes.rename);
    const target = join(docsDir, changes.rename);
    // A case-only rename on a case-insensitive disk finds the folder itself there; that is fine.
    const existing = await lstat(target).catch(() => undefined);
    const same =
      existing &&
      (await realpath(target).catch(() => "")) ===
        (await realpath(join(docsDir, name)).catch(() => undefined));
    if (existing && !same) {
      throw Object.assign(new Error(`already exists: ${changes.rename}`), { status: 409 });
    }
    await rename(join(docsDir, name), target);
    current = changes.rename;
  }
  const dir = join(docsDir, current);
  const { rename: _rename, ...settings } = changes;
  if (Object.keys(settings).length > 0) await writeSettings(dir, await readRaw(dir), settings);
  return {
    folder: { name: current, ...(await readSettings(dir, current)) },
    renamed: current !== name,
  };
}

/**
 * Delete a folder and everything in it.
 *
 * @throws with `status: 404` for no such folder.
 */
export async function deleteFolder(docsDir: string, name: string): Promise<void> {
  if (!(await getFolder(docsDir, name))) {
    throw Object.assign(new Error(`no such folder: ${name}`), { status: 404 });
  }
  await rm(join(docsDir, name), { recursive: true });
}

async function writeSettings(
  dir: string,
  raw: Record<string, unknown>,
  changes: Partial<FolderSettings>,
): Promise<void> {
  const next = { ...raw };
  if (changes.title !== undefined) {
    if (changes.title.trim()) next.title = changes.title.trim();
    else delete next.title;
  }
  if (changes.mcp !== undefined) next.mcp = changes.mcp;
  await writeFile(join(dir, SETTINGS_FILE), `${JSON.stringify(next, null, 2)}\n`);
}
