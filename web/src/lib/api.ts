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

async function get<T>(path: string): Promise<T> {
  const token = getToken();
  const response = await fetch(path, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
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

export const getStatus = () => get<Status>("/api/status");

export const listDocs = async () => (await get<{ docs: DocSummary[] }>("/api/docs")).docs;

export const getDoc = (path: string) => get<Doc>(`/api/doc?path=${encodeURIComponent(path)}`);
