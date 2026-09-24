import { getToken, requireAuth } from "@/lib/auth";

/** `GET /api/status`: open, and answering before the model has loaded. */
export interface Status {
  name: string;
  version: string;
  ready: boolean;
  auth_required: boolean;
  /** Read from the environment at start and never changed at runtime; nothing secret. */
  settings: {
    watch: boolean;
    text_limit: number;
    /** `ragdown_context`'s defaults, which a hook's own arguments override. */
    hook: { top_k: number; min_score: number; min_ratio: number; max_chars: number };
  };
  docs_dir?: string;
  role?: "primary" | "reader";
  embedder?: string;
  read_only?: boolean;
  files?: number;
  chunks?: number;
  syncing?: boolean | null;
  last_sync?: { at: string; added: number; updated: number; removed: number } | null;
}

/**
 * A top-level directory of the docs directory, from `GET /api/folders`. `name` is the directory
 * and the URL segment; `title` comes from its `.ragdown.json`, else the name.
 */
export interface Folder {
  name: string;
  title: string;
  /** Off, the folder is human-only: indexed and searchable here, but nothing of it reaches MCP. */
  mcp: boolean;
  /** `/mcp/<encoded name>`, the folder's MCP endpoint while `mcp` is on. */
  mcp_path: string;
  files: number;
  chunks: number;
}

export interface Folders {
  folders: Folder[];
  /** Markdown directly in the docs directory, outside every folder, which is not indexed. */
  loose_files: string[];
}

/** One indexed file, from `GET /api/docs`. `path` is root-relative: `work/notes/a.md`. */
export interface DocSummary {
  path: string;
  /** The folder the file is in, which is also the first segment of `path`. */
  folder: string;
  title: string;
  mtime_ms: number;
  size: number;
  chunks: number;
  /** Lowercase, without `#`: frontmatter tags and inline ones, nested ones as `a/b`. */
  tags: string[];
  aliases: string[];
}

/** One file's text, from `GET /api/doc?path=`. Read from disk, so current even mid-sync. */
export interface Doc {
  path: string;
  start_line: number;
  end_line: number;
  total_lines: number;
  text: string;
  tags?: string[];
  aliases?: string[];
}

/** One section `GET /api/search` found: hybrid recall within one folder. */
export interface SearchHit {
  path: string;
  title: string;
  heading: string;
  start_line: number;
  end_line: number;
  similarity: number;
  text: string;
  tags: string[];
}

/** Where a wikilink points, from `GET /api/resolve`: a root-relative path, maybe an attachment. */
export interface Resolved {
  path: string;
  anchor?: string;
}

/** A non-2xx answer, carrying the server's `{ error }` message. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** What `POST /api/doc` and `DELETE /api/doc` answer, once the index has caught up. */
export interface DocWrite {
  path: string;
  /** Upload only: false when an existing file was overwritten. */
  created?: boolean;
  sync: { added: number; updated: number; removed: number; unchanged: number; chunks: number };
}

/** A request with the token, and a JSON body when `body` is given. 401 asks for the token again. */
async function send(path: string, init: { method?: string; body?: unknown } = {}) {
  const token = getToken();
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(path, {
    method: init.method ?? "GET",
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  if (response.status === 401) requireAuth();
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: unknown };
    throw new ApiError(
      response.status,
      typeof body.error === "string" ? body.error : `${response.status} ${response.statusText}`,
    );
  }
  return response;
}

async function request<T>(path: string, init: { method?: string; body?: unknown } = {}) {
  return (await (await send(path, init)).json()) as T;
}

/** `?a=1&b=2`, from the entries that have a value. */
function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

export const getStatus = () => request<Status>("/api/status");

export const listFolders = () => request<Folders>("/api/folders");

/** Create a folder: the directory and its `.ragdown.json`. 409 if it exists, 400 for a bad name. */
export const createFolder = async (folder: { name: string; title?: string; mcp?: boolean }) =>
  (await request<{ folder: Folder }>("/api/folders", { method: "POST", body: folder })).folder;

/** Change a folder's settings. `patch.name` renames the directory, which re-indexes it. */
export const updateFolder = async ({
  name,
  patch,
}: {
  name: string;
  patch: { title?: string; mcp?: boolean; name?: string };
}) =>
  (
    await request<{ folder: Folder }>(`/api/folders/${encodeURIComponent(name)}`, {
      method: "PATCH",
      body: patch,
    })
  ).folder;

/** Delete a folder and everything in it. The server refuses unless `confirm` repeats the name. */
export const deleteFolder = (name: string) =>
  request<{ name: string; sync: DocWrite["sync"] }>(
    `/api/folders/${encodeURIComponent(name)}${query({ confirm: name })}`,
    { method: "DELETE" },
  );

/** Every indexed file in `folder`, or in every folder when it is left out. */
export const listDocs = async (folder?: string) =>
  (await request<{ docs: DocSummary[] }>(`/api/docs${query({ folder })}`)).docs;

export const getDoc = (path: string) => request<Doc>(`/api/doc${query({ path })}`);

/** Hybrid recall within one folder, human-only ones included. */
export const searchDocs = async (search: {
  folder: string;
  q: string;
  tag?: string | undefined;
  top_k?: number | undefined;
}) => (await request<{ hits: SearchHit[] }>(`/api/search${query(search)}`)).hits;

/**
 * Where `link` — the text inside `[[…]]` before any `|` — points from the note at `from`. A link
 * that resolves to nothing is an `ApiError` with status 404.
 */
export const resolveLink = (from: string, link: string) =>
  request<Resolved>(`/api/resolve${query({ from, link })}`);

/**
 * Any file inside a folder, as a blob. Fetched rather than linked because it needs the bearer
 * header, which an `<img src>` cannot send.
 */
export const getFile = async (path: string) => (await send(`/api/file${query({ path })}`)).blob();

/**
 * Write a Markdown file inside a folder. Without `overwrite`, an existing file is an `ApiError`
 * with status 409, so the caller can ask before replacing it.
 */
export const uploadDoc = (upload: { path: string; text: string; overwrite?: boolean }) =>
  request<DocWrite>("/api/doc", { method: "POST", body: upload });

export const deleteDoc = (path: string) =>
  request<DocWrite>(`/api/doc${query({ path })}`, { method: "DELETE" });
