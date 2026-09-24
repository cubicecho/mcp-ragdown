import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { type Config, isInside } from "./config.ts";
import type { Ragdown } from "./engine.ts";
import { errorMessage } from "./errors.ts";
import {
  createFolder,
  deleteFolder,
  type Folder,
  type FolderSettings,
  getFolder,
  listFolders,
  looseFiles,
  updateFolder,
} from "./folders.ts";
import { openScope, Scope } from "./scope.ts";
import { createMcpServer, SERVER_NAME, VERSION } from "./server.ts";
import type { FileState } from "./store.ts";

/** An MCP message is a few kilobytes; anything near this is not one. */
const MAX_BODY_BYTES = 1024 * 1024;
/**
 * An upload's JSON body. A hand-written note is kilobytes and a long one well under a megabyte;
 * JSON escaping can nearly double Markdown full of quotes and backslashes, and the request waits
 * while every chunk of the file is embedded, so a file much past this is not a note and would hold
 * the response for minutes on the CPU model.
 */
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

/** Where `npm run build` puts the web UI. Absent in a checkout that never built it. */
export const WEB_DIR = fileURLToPath(new URL("../web/dist", import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

/** What `/api/file` says a note's attachment is; anything else is a download. */
const FILE_TYPES: Record<string, string> = {
  ...CONTENT_TYPES,
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".mdx": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".html": "text/plain; charset=utf-8",
  ".js": "text/plain; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".pdf": "application/pdf",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
};

/**
 * The HTTP face of the server, for running it in a container. Every top-level directory of the docs
 * is a folder (`folders.ts`), and each folder with MCP turned on is its own MCP server:
 *
 * - `GET /api/status` — unauthenticated liveness, with the index size once the model is loaded.
 * - `/mcp/<folder>` — Streamable HTTP MCP for one folder, stateless: a fresh `McpServer` per
 *   request, since every piece of state lives in the shared `Ragdown`. `/mcp/<folder>/<sub...>` is
 *   the same server narrowed to a subfolder. Its tools treat the folder as the root (`scope.ts`). A
 *   folder that does not exist and one that is human-only (MCP off) are the same 404, and bare
 *   `/mcp` is a 404 that says to pick a folder: there is no endpoint over every folder.
 * - `/api/folders` — list (`GET`) and create (`POST { name, title?, mcp? }`) folders;
 *   `/api/folders/<name>` — change a folder's settings or rename it (`PATCH { title?, mcp?, name? }`)
 *   and delete it with everything in it (`DELETE ?confirm=<name>`).
 * - `GET /api/docs[?folder=]` and `GET /api/doc?path=` — the indexed files and one file's text.
 * - `POST /api/doc` with `{ path, text, overwrite? }` and `DELETE /api/doc?path=` — upload and
 *   remove a Markdown file inside a folder. Paths are held to what the indexer would index
 *   (`Scope.writeDoc`); an existing file is a 409 unless `overwrite`, a missing one a 404. Each
 *   answers once the index has synced, so the next `/api/docs` already reflects it.
 * - `GET /api/search?folder=&q=[&tag=&top_k=]` — hybrid search within one folder, human-only ones
 *   included: the UI is for people.
 * - `GET /api/resolve?from=&link=` — a wikilink in the note `from`, resolved within its folder.
 * - `GET /api/file?path=` — any file inside a folder, raw, for the UI's images and embeds.
 * - Anything else under `GET` — the web UI from `webDir`, when it has been built.
 *
 * Every `/api` path is relative to the docs root, folder first: `work/notes/a.md`. Writes to the
 * notes and folders are a 403 under `RAGDOWN_READ_ONLY`; a folder's settings are not notes, so
 * they can still be changed — otherwise a read-only server could never turn MCP on.
 *
 * Agents and hooks use `/mcp/<folder>` only; the `/api` routes exist for the UI and the health
 * check. Everything under `/api` but status, and `/mcp`, needs `Authorization: Bearer
 * $RAGDOWN_TOKEN` unless `SECURE_LOCAL_NET=true`. The UI's static files do not: they hold no notes.
 * Plain `node:http` rather than Express: a handful of routes do not need a framework.
 */
export function createHttpServer(
  ready: Promise<Ragdown>,
  config: Config,
  webDir: string = WEB_DIR,
): Server {
  return createServer((req, res) => {
    handle(ready, config, webDir, req, res).catch((error: unknown) => {
      const status = (error as { status?: number }).status ?? 500;
      if (status >= 500) console.error(`[http] ${req.method} ${req.url}: ${errorMessage(error)}`);
      if (!res.headersSent) json(res, status, { error: errorMessage(error) });
      else res.end();
    });
  });
}

/**
 * @throws when neither a token nor `SECURE_LOCAL_NET` is configured: an index of someone's notes
 *   must not be served to the network by accident.
 */
export function assertAuthConfigured(config: Config): void {
  if (!config.http.token && !config.http.secureLocalNet) {
    throw new Error(
      "set RAGDOWN_TOKEN (openssl rand -hex 32), or SECURE_LOCAL_NET=true on a trusted network",
    );
  }
}

/**
 * The settings the web UI shows, read from the environment at start. Served unauthenticated with
 * the status, so only tuning numbers belong here: never the token, a key, or an endpoint URL.
 */
function publicSettings(config: Config) {
  return {
    watch: config.watch,
    text_limit: config.textLimit,
    hook: {
      top_k: config.hook.topK,
      min_score: config.hook.minScore,
      min_ratio: config.hook.minRatio,
      max_chars: config.hook.maxChars,
    },
  };
}

async function handle(
  ready: Promise<Ragdown>,
  config: Config,
  webDir: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;

  if (path === "/api/status" && req.method === "GET") {
    // Answers before the model has loaded, so a slow first start is not reported as a dead one.
    const rag = await Promise.race([ready, Promise.resolve(undefined)]);
    json(res, 200, {
      name: SERVER_NAME,
      version: VERSION,
      ready: rag !== undefined,
      auth_required: !config.http.secureLocalNet,
      settings: publicSettings(config),
      ...(rag ? await rag.stats(false) : {}),
    });
    return;
  }

  const mcp = path === "/mcp" || path.startsWith("/mcp/");
  const api = mcp || path.startsWith("/api/");
  if (!api) {
    if (req.method === "GET" || req.method === "HEAD") await serveWeb(webDir, path, res);
    else json(res, 404, { error: "Not found" });
    return;
  }
  if (!mcp && !API_ROUTES.has(path) && !path.startsWith("/api/folders/")) {
    json(res, 404, { error: "Not found" });
    return;
  }
  if (!authorized(config, req.headers.authorization)) {
    json(res, 401, { error: "Unauthorized" });
    return;
  }
  if (mcp) {
    await handleMcp(await ready, config, path, req, res);
    return;
  }
  await handleApi(await ready, config, path, req, res);
}

const API_ROUTES = new Set([
  "/api/folders",
  "/api/docs",
  "/api/doc",
  "/api/search",
  "/api/resolve",
  "/api/file",
]);

/** The same answer for a missing folder and a human-only one, so neither gives the other away. */
const NO_MCP_FOLDER = "Not found: no folder with MCP turned on at this path";

async function handleMcp(
  rag: Ragdown,
  config: Config,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const dir = scopeDir(path);
  const name = dir.split("/").find(Boolean);
  if (!name) {
    json(res, 404, { error: "Pick a folder: /mcp/<folder>" });
    return;
  }
  // Every method, not only POST: clients open a GET for the SSE stream and send DELETE to end a
  // session, and a 404 for those looks like a broken server.
  const folder = await getFolder(config.docsDir, name);
  const scope = folder?.mcp ? await openScope(rag, dir) : undefined;
  if (!folder || !scope) {
    json(res, 404, { error: NO_MCP_FOLDER });
    return;
  }
  const server = createMcpServer(Promise.resolve(scope), config.readOnly, folder);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close().catch(() => undefined);
    void server.close().catch(() => undefined);
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.method === "POST" ? await readJson(req) : undefined);
}

async function handleApi(
  rag: Ragdown,
  config: Config,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const params = new URL(req.url ?? "/", "http://localhost").searchParams;
  const method = req.method ?? "GET";
  const readOnly = () => {
    throw Object.assign(new Error("The server is read-only (RAGDOWN_READ_ONLY)"), { status: 403 });
  };
  const required = (name: string) => {
    const value = params.get(name);
    if (!value) throw Object.assign(new Error(`${name} is required`), { status: 400 });
    return value;
  };
  const allow = (...methods: string[]) => {
    if (!methods.includes(method)) {
      throw Object.assign(new Error("Method not allowed"), { status: 405 });
    }
  };
  const root = new Scope(rag);

  if (path === "/api/folders") {
    allow("GET", "POST");
    if (method === "GET") {
      const [folders, loose] = await Promise.all([
        folderSummaries(rag, config),
        looseFiles(config.docsDir),
      ]);
      json(res, 200, { folders, loose_files: loose });
      return;
    }
    if (config.readOnly) readOnly();
    const body = (await readJson(req)) as Record<string, unknown>;
    if (typeof body?.name !== "string") {
      json(res, 400, { error: "name is required" });
      return;
    }
    const folder = await createFolder(config.docsDir, body.name, settingsFrom(body));
    json(res, 201, { folder: await folderSummary(rag, folder) });
    return;
  }

  if (path.startsWith("/api/folders/")) {
    allow("PATCH", "DELETE");
    let name: string;
    try {
      name = decodeURIComponent(path.slice("/api/folders/".length));
    } catch {
      name = "";
    }
    if (method === "DELETE") {
      if (config.readOnly) readOnly();
      if (params.get("confirm") !== name) {
        json(res, 400, {
          error: "confirm must repeat the folder's name: this deletes every file in it",
        });
        return;
      }
      await deleteFolder(config.docsDir, name);
      json(res, 200, { name, sync: await rag.sync(false) });
      return;
    }
    const body = (await readJson(req)) as Record<string, unknown>;
    if (body?.name !== undefined && typeof body.name !== "string") {
      json(res, 400, { error: "name must be a string" });
      return;
    }
    const rename = body?.name as string | undefined;
    if (rename !== undefined && rename !== name && config.readOnly) readOnly();
    const { folder, renamed } = await updateFolder(config.docsDir, name, {
      ...settingsFrom(body),
      ...(rename !== undefined ? { rename } : {}),
    });
    // Every path in the folder changed: the index answers for the new ones before this returns.
    if (renamed) await rag.sync(false);
    json(res, 200, { folder: await folderSummary(rag, folder) });
    return;
  }

  if (path === "/api/doc" && (method === "POST" || method === "DELETE")) {
    if (config.readOnly) readOnly();
    if (method === "POST") {
      const body = (await readJson(req, MAX_UPLOAD_BYTES)) as Record<string, unknown>;
      if (typeof body?.path !== "string" || typeof body.text !== "string") {
        json(res, 400, { error: "path and text are required strings" });
        return;
      }
      await assertInFolder(config, body.path);
      const written = await root.writeDoc(body.path, body.text, body.overwrite === true);
      json(res, written.created ? 201 : 200, written);
      return;
    }
    const docPath = required("path");
    await assertInFolder(config, docPath);
    json(res, 200, await root.deleteDoc(docPath));
    return;
  }

  allow("GET");

  if (path === "/api/docs") {
    const name = params.get("folder");
    if (name && !(await getFolder(config.docsDir, name))) {
      json(res, 404, { error: `no such folder: ${name}` });
      return;
    }
    const docs = (await rag.documents()).filter((doc) => !name || doc.path.startsWith(`${name}/`));
    json(res, 200, {
      docs: docs.map((doc) => ({
        path: doc.path,
        folder: doc.path.split("/")[0] ?? "",
        title: doc.title,
        mtime_ms: doc.mtimeMs,
        size: doc.size,
        chunks: doc.chunks,
        tags: doc.tags,
        aliases: doc.aliases,
      })),
    });
    return;
  }

  if (path === "/api/doc") {
    json(res, 200, await root.readIndexedDoc(required("path")));
    return;
  }

  if (path === "/api/search") {
    const name = required("folder");
    const query = required("q");
    const topK = Math.min(50, Math.max(1, Number.parseInt(params.get("top_k") ?? "", 10) || 10));
    if (!(await getFolder(config.docsDir, name))) {
      json(res, 404, { error: `no such folder: ${name}` });
      return;
    }
    const hits = await new Scope(rag, name).recall(
      query,
      topK,
      undefined,
      params.get("tag") || undefined,
    );
    json(res, 200, {
      hits: hits.map((hit) => ({
        path: `${name}/${hit.path}`,
        title: hit.title,
        heading: hit.heading,
        start_line: hit.lineStart,
        end_line: hit.lineEnd,
        similarity: Number(hit.similarity.toFixed(4)),
        text: hit.text,
        tags: hit.tags,
      })),
    });
    return;
  }

  if (path === "/api/resolve") {
    const from = required("from");
    const link = required("link");
    const name = await assertInFolder(config, from);
    const resolved = await new Scope(rag, name).resolveLink(
      link,
      from.slice(name.length + 1),
      true,
    );
    if (!resolved) {
      json(res, 404, { error: `no note or file matches ${JSON.stringify(link)}` });
      return;
    }
    json(res, 200, { ...resolved, path: `${name}/${resolved.path}` });
    return;
  }

  if (path === "/api/file") {
    const filePath = required("path");
    await assertInFolder(config, filePath);
    const full = await root.fileFor(filePath);
    const type = FILE_TYPES[extname(full).toLowerCase()] ?? "application/octet-stream";
    const info = await stat(full);
    res.writeHead(200, {
      "content-type": type,
      "content-length": info.size,
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
      // A note's SVG or HTML is someone's file, not this app: opened directly, it runs nothing.
      "content-security-policy": "sandbox",
    });
    await pipeline(createReadStream(full), res);
    return;
  }

  json(res, 404, { error: "Not found" });
}

/**
 * The folder a root-relative path is in, which must exist, and the path must be inside it: the
 * docs root itself holds no notes in folders mode.
 *
 * @throws with `status: 400` otherwise.
 */
async function assertInFolder(config: Config, path: string): Promise<string> {
  const segments = path.replaceAll("\\", "/").split("/").filter(Boolean);
  const name = segments[0] ?? "";
  if (segments.length < 2 || !(await getFolder(config.docsDir, name))) {
    throw Object.assign(new Error(`not inside a folder: ${path} (start it with a folder's name)`), {
      status: 400,
    });
  }
  return name;
}

function settingsFrom(body: Record<string, unknown> | undefined): Partial<FolderSettings> {
  const out: Partial<FolderSettings> = {};
  if (body?.title !== undefined) {
    if (typeof body.title !== "string") {
      throw Object.assign(new Error("title must be a string"), { status: 400 });
    }
    out.title = body.title;
  }
  if (body?.mcp !== undefined) {
    if (typeof body.mcp !== "boolean") {
      throw Object.assign(new Error("mcp must be true or false"), { status: 400 });
    }
    out.mcp = body.mcp;
  }
  return out;
}

async function folderSummaries(rag: Ragdown, config: Config) {
  const [folders, files] = await Promise.all([listFolders(config.docsDir), rag.files()]);
  return folders.map((folder) => summarize(folder, files));
}

async function folderSummary(rag: Ragdown, folder: Folder) {
  return summarize(folder, await rag.files());
}

function summarize(folder: Folder, files: Map<string, FileState>) {
  let count = 0;
  let chunks = 0;
  for (const [path, state] of files) {
    if (!path.startsWith(`${folder.name}/`)) continue;
    count++;
    chunks += state.chunks;
  }
  return {
    name: folder.name,
    title: folder.title,
    mcp: folder.mcp,
    mcp_path: `/mcp/${encodeURIComponent(folder.name)}`,
    files: count,
    chunks,
  };
}

/** The folder in `/mcp/<folder>`, decoded; empty for `/mcp`. A malformed escape names no folder. */
function scopeDir(path: string): string {
  const rest = path.slice("/mcp".length);
  try {
    return decodeURIComponent(rest);
  } catch {
    return "/.";
  }
}

/**
 * A file from the built UI, or its `index.html` for any path that is not one, so a reload on a
 * client-side route still lands in the app. Hashed assets are cached for good; the page never is.
 */
async function serveWeb(webDir: string, path: string, res: ServerResponse): Promise<void> {
  const root = resolve(webDir);
  let file = join(root, "index.html");
  try {
    file = resolve(root, `.${decodeURIComponent(path)}`);
  } catch {
    // A malformed escape is not a file; the app answers it.
  }
  if (!isInside(root, file) || !(await stat(file).catch(() => undefined))?.isFile()) {
    file = join(root, "index.html");
  }
  const body = await readFile(file).catch(() => undefined);
  if (!body) {
    json(res, 404, { error: "The web UI is not built: run npm run build" });
    return;
  }
  const immutable = isInside(join(root, "assets"), file);
  res
    .writeHead(200, {
      "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    })
    .end(body);
}

function authorized(config: Config, header: string | undefined): boolean {
  if (config.http.secureLocalNet) return true;
  const provided = header?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!provided || !config.http.token) return false;
  // Compared as digests so neither the content nor the length leaks through timing.
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(provided), digest(config.http.token));
}

async function readJson(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw Object.assign(new Error("Body too large"), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error("Body is not valid JSON"), { status: 400 });
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}
