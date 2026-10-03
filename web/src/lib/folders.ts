import type { Folder, FolderPatch, HookOverrides } from "@/lib/api";

/**
 * Folders: the top-level directories of the docs directory. Every path the API speaks is
 * root-relative (`work/notes/a.md`); the URL holds the folder and a path relative to it
 * (`/f/work?doc=notes/a.md`), so a link reads the way the folder does on disk.
 */

/** `work` + `notes/a.md` → `work/notes/a.md`. */
export const inFolder = (folder: string, relative: string) => `${folder}/${relative}`;

/** The folder a root-relative path is in: its first segment. */
export const folderOf = (path: string) => path.split("/")[0] ?? "";

/** `work/notes/a.md` → `notes/a.md`. */
export const withinFolder = (path: string) => path.slice(path.indexOf("/") + 1);

/**
 * What the server accepts when creating or renaming: 1–64 of `[A-Za-z0-9 _.-]`, not starting with
 * `.` or `-`. Folders found on disk may have other names; those are only shown, never typed.
 */
export function folderNameError(name: string): string | undefined {
  if (!name) return "A folder needs a name.";
  if (name.length > 64) return "At most 64 characters.";
  if (/^[.-]/.test(name)) return "It cannot start with a dot or a dash.";
  if (!/^[A-Za-z0-9 _.-]+$/.test(name)) return "Letters, digits, spaces, _ . and - only.";
  if (name === "node_modules") return "That name is reserved.";
  return undefined;
}

export const HOOK_KEYS = ["top_k", "min_score", "min_ratio", "max_chars"] as const;

/** A folder's settings as its form holds them. An empty hook field is `null`: the server's default. */
export type FolderForm = { title: string; mcp: boolean } & {
  [K in keyof HookOverrides]-?: number | null;
};

export const folderForm = (folder: Folder): FolderForm => ({
  title: folder.title,
  mcp: folder.mcp,
  top_k: folder.hook.top_k ?? null,
  min_score: folder.hook.min_score ?? null,
  min_ratio: folder.hook.min_ratio ?? null,
  max_chars: folder.hook.max_chars ?? null,
});

/** What a save sends: only what differs. An empty title means the name, as an untitled folder shows. */
export function folderPatch(folder: Folder, values: FolderForm): FolderPatch {
  const title = values.title.trim();
  const hook: NonNullable<FolderPatch["hook"]> = {};
  for (const key of HOOK_KEYS) {
    if (values[key] !== (folder.hook[key] ?? null)) hook[key] = values[key];
  }
  return {
    ...((title || folder.name) !== folder.title ? { title } : {}),
    ...(values.mcp !== folder.mcp ? { mcp: values.mcp } : {}),
    ...(Object.keys(hook).length > 0 ? { hook } : {}),
  };
}

/** What the server accepts for a hook default, as it accepts the `RAGDOWN_HOOK_*` variables. */
export function hookValueError(key: keyof HookOverrides, value: number | null): string | undefined {
  if (value === null || key === "min_score") return undefined;
  if (key === "min_ratio") return value < 0 || value > 1 ? "Between 0 and 1." : undefined;
  return Number.isInteger(value) && value >= 0 ? undefined : "A whole number, 0 or more.";
}

/** True when there are folders and none of them has MCP on. */
export const mcpOffEverywhere = (folders: readonly Folder[] | undefined) =>
  Boolean(folders && folders.length > 0 && folders.every((folder) => !folder.mcp));

const LAST = "ragdown.folder";

/** The folder `/` opens: the one last looked at in this browser. */
export function getLastFolder(): string | null {
  try {
    return localStorage.getItem(LAST);
  } catch {
    return null;
  }
}

export function setLastFolder(name: string | null) {
  try {
    if (name === null) localStorage.removeItem(LAST);
    else localStorage.setItem(LAST, name);
  } catch {
    // Storage denied: `/` falls back to the first folder.
  }
}

/** The MCP server name an agent sees the folder under, which is also the server's own name. */
export const mcpServerName = (folder: Folder) => `ragdown-${folder.name}`;

/** Quoted for a POSIX shell when it has to be. */
function shellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** `claude mcp add` for the folder's endpoint, with the bearer header when there is one. */
export function mcpAddCommand(folder: Folder, origin: string, token: string | null): string {
  const words = [
    "claude mcp add --transport http",
    shellWord(mcpServerName(folder)),
    shellWord(`${origin}${folder.mcp_path}`),
  ];
  if (token) {
    const header = `Authorization: Bearer ${token}`;
    // Double quotes read the way the docs write it; a token with shell characters gets single ones.
    words.push(`--header ${/^[\w.~+/=-]+$/.test(token) ? `"${header}"` : shellWord(header)}`);
  }
  return words.join(" ");
}

/** The same endpoint as an `mcpServers` entry, for `.mcp.json` and the clients that read one. */
export function mcpJsonEntry(folder: Folder, origin: string, token: string | null): string {
  return JSON.stringify(
    {
      mcpServers: {
        [mcpServerName(folder)]: {
          type: "http",
          url: `${origin}${folder.mcp_path}`,
          ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
        },
      },
    },
    null,
    2,
  );
}
