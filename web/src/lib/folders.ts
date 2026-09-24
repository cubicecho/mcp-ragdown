import type { Folder } from "@/lib/api";

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
