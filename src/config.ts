import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface Config {
  /** Absolute path of the Markdown folder; the files there are the source of truth. */
  docsDir: string;
  /** Where the LanceDB index and its meta file live. Derived data: deleting it only costs a rebuild. */
  dataDir: string;
  /** Model cache shared by every docs folder, so a second folder does not download the model again. */
  modelsDir: string;
  /** Unix socket the primary process listens on; see `primary.ts`. */
  socketPath: string;
  embedder: string;
  /** ONNX Runtime threads for the local model; 0 lets the embedder choose. */
  threads: number;
  embeddingUrl: string;
  embeddingApiKey: string | undefined;
  readOnly: boolean;
  watch: boolean;
  /** Where `ragdown_remember` writes; always inside `docsDir` so the note is indexed. */
  notesDir: string;
  textLimit: number;
  http: {
    port: number;
    /** Bearer token for `/mcp` and the web UI's `/api` routes; null when unset. */
    token: string | null;
    /** `SECURE_LOCAL_NET=true`: no auth at all, for a trusted network. */
    secureLocalNet: boolean;
  };
  /** Defaults for `ragdown_context`, which a hook calls before each turn. */
  hook: {
    topK: number;
    minScore: number;
    maxChars: number;
  };
}

type Env = Record<string, string | undefined>;

/**
 * Read and validate every `RAGDOWN_*` variable. The only place in the repo that reads `process.env`.
 *
 * @throws when `RAGDOWN_DOCS_DIR` is missing or not a directory, or a number is malformed.
 */
export function loadConfig(env: Env = process.env): Config {
  const rawDocs = env.RAGDOWN_DOCS_DIR;
  if (!rawDocs) {
    throw new Error(
      "RAGDOWN_DOCS_DIR is not set: point it (or --docs) at a folder of Markdown files",
    );
  }
  const docsDir = resolve(expandHome(rawDocs));
  if (!statSync(docsDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`RAGDOWN_DOCS_DIR is not a directory: ${docsDir}`);
  }

  const cacheRoot = join(env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "ragdown");
  // Keyed by the folder's path so pointing at a folder needs no other setting and never writes
  // into the folder itself, where the watcher would see its own index churn.
  const key = createHash("sha256").update(docsDir).digest("hex").slice(0, 16);
  const dataDir = resolve(expandHome(env.RAGDOWN_DATA_DIR ?? join(cacheRoot, key)));
  // Beside the index, so every server on the same folder finds the same socket from the docs path
  // alone, whatever else differs between their environments. A unix socket path is capped near 104 bytes,
  // though, so a long data dir moves it to the temp dir under a name derived from the data dir.
  let socketPath = join(dataDir, "primary.sock");
  if (Buffer.byteLength(socketPath) > 100) {
    const socketKey = createHash("sha256").update(dataDir).digest("hex").slice(0, 16);
    socketPath = join(tmpdir(), `ragdown-${socketKey}.sock`);
  }

  const notesDir = resolve(docsDir, env.RAGDOWN_NOTES_DIR ?? "notes");
  if (!isInside(docsDir, notesDir)) {
    throw new Error(`RAGDOWN_NOTES_DIR must be inside the docs dir (${docsDir}): ${notesDir}`);
  }

  return {
    docsDir,
    dataDir,
    modelsDir: resolve(expandHome(env.RAGDOWN_MODELS ?? join(cacheRoot, "models"))),
    socketPath,
    embedder: env.RAGDOWN_EMBEDDER ?? "granite-small",
    threads: int(env, "RAGDOWN_THREADS", 0),
    embeddingUrl: env.RAGDOWN_EMBEDDING_URL ?? "https://api.openai.com/v1",
    embeddingApiKey: env.RAGDOWN_EMBEDDING_API_KEY,
    readOnly: bool(env, "RAGDOWN_READ_ONLY", false),
    watch: bool(env, "RAGDOWN_WATCH", true),
    notesDir,
    textLimit: int(env, "RAGDOWN_TEXT_LIMIT", 2000),
    http: {
      port: int(env, "PORT", 3000),
      token: env.RAGDOWN_TOKEN || null,
      secureLocalNet: bool(env, "SECURE_LOCAL_NET", false),
    },
    hook: {
      topK: int(env, "RAGDOWN_HOOK_TOP_K", 4),
      // Calibrated for the default embedder; cosine is on each model's own scale, so a different
      // `RAGDOWN_EMBEDDER` needs a different number. The README's embedder table pairs them.
      minScore: num(env, "RAGDOWN_HOOK_MIN_SCORE", 0.8),
      maxChars: int(env, "RAGDOWN_HOOK_MAX_CHARS", 6000),
    },
  };
}

/** True when `child` is `parent` or somewhere below it; both must be absolute and resolved. */
export function isInside(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

function bool(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  throw new Error(`${name} must be true or false, got "${raw}"`);
}

function num(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number, got "${raw}"`);
  return value;
}

function int(env: Env, name: string, fallback: number): number {
  const value = num(env, name, fallback);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${value}"`);
  }
  return value;
}
