import { getToken, requireAuth } from "@/lib/auth";

/** `GET /api/status`: open, and answering before the model has loaded. */
export interface Status {
  name: string;
  version: string;
  ready: boolean;
  auth_required: boolean;
  docs_dir?: string;
  role?: "primary" | "reader";
  embedder?: string;
  read_only?: boolean;
  files?: number;
  chunks?: number;
  syncing?: boolean | null;
  last_sync?: { at: string; added: number; updated: number; removed: number } | null;
}

/** One indexed file, from `GET /api/docs`. */
export interface DocSummary {
  path: string;
  title: string;
  mtime_ms: number;
  size: number;
  chunks: number;
}

/** One file's text, from `GET /api/doc?path=`. Read from disk, so current even mid-sync. */
export interface Doc {
  path: string;
  start_line: number;
  end_line: number;
  total_lines: number;
  text: string;
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
async function request<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
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
  return (await response.json()) as T;
}

export const getStatus = () => request<Status>("/api/status");

export const listDocs = async () => (await request<{ docs: DocSummary[] }>("/api/docs")).docs;

export const getDoc = (path: string) => request<Doc>(`/api/doc?path=${encodeURIComponent(path)}`);

/**
 * Write a Markdown file into the docs folder. Without `overwrite`, an existing file is an
 * `ApiError` with status 409, so the caller can ask before replacing it.
 */
export const uploadDoc = (upload: { path: string; text: string; overwrite?: boolean }) =>
  request<DocWrite>("/api/doc", { method: "POST", body: upload });

export const deleteDoc = (path: string) =>
  request<DocWrite>(`/api/doc?path=${encodeURIComponent(path)}`, { method: "DELETE" });
