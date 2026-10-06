import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { handleDocuments } from "./api-documents.ts";
import { handleFolders } from "./api-folders.ts";
import { handleSettings, publicSettings } from "./api-settings.ts";
import type { Config } from "./config.ts";
import type { Ragdown } from "./engine.ts";
import { errorMessage } from "./errors.ts";
import { getFolder } from "./folders.ts";
import { type ApiRequest, json, readJson } from "./http-io.ts";
import { Refusal } from "./refusal.ts";
import { openScope } from "./scope.ts";
import { createMcpServer, SERVER_NAME, VERSION } from "./server.ts";
import { serveWeb, WEB_DIR } from "./web-ui.ts";

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
 *   `/api/folders/<name>` — change a folder's settings or rename it (`PATCH { title?, mcp?, hook?,
 *   name? }`) and delete it with everything in it (`DELETE ?confirm=<name>`).
 * - `PATCH /api/settings` — save server-wide settings (`{ embedder?, watch?, text_limit?, hook? }`,
 *   a `null` giving a value back to its variable) to `.ragdown-server.json` in the docs dir and
 *   apply them at once. A new embedder rebuilds the index. `GET /api/status` shows the result.
 * - `DELETE /api/loose?name=` — remove one Markdown file directly in the docs dir, outside every
 *   folder. Only a name `GET /api/folders` lists as loose; nothing is indexed there, so no sync.
 * - `GET /api/docs[?folder=]` and `GET /api/doc?path=` — the indexed files and one file's text.
 * - `POST /api/doc` with `{ path, text, overwrite?, base_hash? }` and `DELETE /api/doc?path=` —
 *   upload, edit and remove a Markdown file inside a folder. Paths are held to what the indexer
 *   would index (`Scope.writeDocument`); an existing file is a 409 unless `overwrite` or
 *   `base_hash`, a missing one a 404. `base_hash` is the `hash` `GET /api/doc` gave: the editor's
 *   save, a 409 with `code: "changed"` when the file has changed or gone since. Each answers once
 *   the index has synced, so the next `/api/docs` already reflects it.
 * - `POST /api/move` with `{ from, to }` — rename or move a document, or a subfolder, within its
 *   folder, rewriting the links that pointed at what moved (`Scope.move`).
 * - `GET /api/search?folder=&q=[&tag=&top_k=]` — hybrid search within one folder, human-only ones
 *   included: the UI is for people.
 * - `GET /api/resolve?from=&link=` — a wikilink in the document `from`, resolved within its folder.
 * - `GET /api/backlinks?path=` — the documents in the same folder that link to `path`.
 * - `GET /api/file?path=` — any file inside a folder, raw, for the UI's images and embeds.
 * - Anything else under `GET` — the web UI from `webDir`, when it has been built.
 *
 * Every `/api` path is relative to the docs root, folder first: `work/notes/a.md`. Writes to
 * the documents and folders are a 403 under `RAGDOWN_READ_ONLY`; a folder's settings are not
 * documents, so they can still be changed — otherwise a read-only server could never turn MCP on.
 *
 * Agents and hooks use `/mcp/<folder>` only; the `/api` routes exist for the UI and the health
 * check. Everything under `/api` but status, and `/mcp`, needs `Authorization: Bearer
 * $RAGDOWN_TOKEN` unless `SECURE_LOCAL_NET=true`. The UI's static files do not: they hold no
 * documents. Plain `node:http` rather than Express: a handful of routes do not need a framework.
 */
export function createHttpServer(
  ready: Promise<Ragdown>,
  config: Config,
  webDir: string = WEB_DIR,
): Server {
  return createServer({ keepAliveTimeout: config.http.keepAliveTimeoutMs }, (req, res) => {
    handle(ready, config, webDir, req, res).catch((error: unknown) => {
      const status = error instanceof Refusal ? error.status : 500;
      if (status >= 500) console.error(`[http] ${req.method} ${req.url}: ${errorMessage(error)}`);
      const body =
        error instanceof Refusal && error.code !== undefined
          ? { error: errorMessage(error), code: error.code }
          : { error: errorMessage(error) };
      if (!res.headersSent) json(res, status, body);
      else res.end();
    });
  });
}

/**
 * @throws when neither a token nor `SECURE_LOCAL_NET` is configured: an index of someone's
 *   documents must not be served to the network by accident.
 */
export function assertAuthConfigured(config: Config): void {
  if (!config.http.token && !config.http.secureLocalNet) {
    throw new Error(
      "set RAGDOWN_TOKEN (openssl rand -hex 32), or SECURE_LOCAL_NET=true on a trusted network",
    );
  }
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
  "/api/settings",
  "/api/folders",
  "/api/loose",
  "/api/docs",
  "/api/doc",
  "/api/search",
  "/api/resolve",
  "/api/backlinks",
  "/api/move",
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

/** An authorized `/api` request, handed to the resource its path names. */
async function handleApi(
  rag: Ragdown,
  config: Config,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const request: ApiRequest = {
    rag,
    config,
    path,
    method: req.method ?? "GET",
    params: new URL(req.url ?? "/", "http://localhost").searchParams,
    req,
    res,
  };
  if (path === "/api/folders" || path.startsWith("/api/folders/") || path === "/api/loose") {
    await handleFolders(request);
  } else if (path === "/api/settings") {
    await handleSettings(request);
  } else {
    await handleDocuments(request);
  }
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

function authorized(config: Config, header: string | undefined): boolean {
  if (config.http.secureLocalNet) return true;
  const provided = header?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!provided || !config.http.token) return false;
  // Compared as digests so neither the content nor the length leaks through timing.
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(provided), digest(config.http.token));
}
