import { createHash, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { type Config, isInside } from "./config.ts";
import type { Ragdown } from "./engine.ts";
import { errorMessage } from "./errors.ts";
import { openScope, Scope } from "./scope.ts";
import { createMcpServer, SERVER_NAME, VERSION } from "./server.ts";

/** An MCP message is a few kilobytes; anything near this is not one. */
const MAX_BODY_BYTES = 1024 * 1024;

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

/**
 * The HTTP face of the server, for running it in a container:
 *
 * - `GET /api/status` — unauthenticated liveness, with the index size once the model is loaded.
 * - `/mcp` — Streamable HTTP MCP, stateless: a fresh `McpServer` per request, since every piece of
 *   state lives in the shared `Ragdown`. `/mcp/<folder>` is the same server scoped to one folder of
 *   the docs, which its tools treat as the root (`scope.ts`); a folder that is not one is a 404.
 * - `GET /api/docs` and `GET /api/doc?path=` — the indexed files and one file's text, for the web UI.
 * - Anything else under `GET` — the web UI from `webDir`, when it has been built.
 *
 * Agents and hooks use `/mcp` only; the `/api` routes exist for the UI and the health check.
 * Everything under `/api` but status, and `/mcp[/<folder>]`, needs `Authorization: Bearer $RAGDOWN_TOKEN`
 * unless `SECURE_LOCAL_NET=true`. The UI's static files do not: they hold no notes. Plain
 * `node:http` rather than Express: a handful of routes do not need a framework.
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
  if (!mcp && !API_ROUTES.has(path)) {
    json(res, 404, { error: "Not found" });
    return;
  }
  if (!authorized(config, req.headers.authorization)) {
    json(res, 401, { error: "Unauthorized" });
    return;
  }

  if (path === "/api/docs" || path === "/api/doc") {
    if (req.method !== "GET") {
      json(res, 405, { error: "Method not allowed" });
      return;
    }
    const rag = await ready;
    if (path === "/api/docs") {
      const docs = await rag.documents();
      json(res, 200, {
        docs: docs.map((doc) => ({
          path: doc.path,
          title: doc.title,
          mtime_ms: doc.mtimeMs,
          size: doc.size,
          chunks: doc.chunks,
        })),
      });
      return;
    }
    const docPath = new URL(req.url ?? "/", "http://localhost").searchParams.get("path");
    if (!docPath) {
      json(res, 400, { error: "path is required" });
      return;
    }
    json(res, 200, await new Scope(rag).readIndexedDoc(docPath));
    return;
  }

  // Every method, not only POST: clients open a GET for the SSE stream and send DELETE to end a
  // session, and a 404 for those looks like a broken server.
  const scope = await ready.then((rag) => openScope(rag, scopeDir(path)));
  if (!scope) {
    json(res, 404, { error: "Not found: no such folder in the docs" });
    return;
  }
  const server = createMcpServer(Promise.resolve(scope), config.readOnly);
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

const API_ROUTES = new Set(["/api/docs", "/api/doc"]);

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

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("Body too large"), { status: 413 });
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
