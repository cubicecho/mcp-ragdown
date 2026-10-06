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
 * The HTTP face of the server, for running it in a container: `/mcp/<folder>` for agents and
 * hooks, `/api` for the web UI and the health check, and the built UI for every other `GET`. The
 * README's "Commands and HTTP" lists every route and what it answers. Plain `node:http` rather than
 * Express: a handful of routes do not need a framework.
 */
export function createHttpServer(
  ready: Promise<Ragdown>,
  config: Config,
  webDir: string = WEB_DIR,
): Server {
  return createServer({ keepAliveTimeout: config.http.keepAliveTimeoutMs }, (req, res) => {
    handle(ready, config, webDir, req, res).catch((error: unknown) => {
      const status = error instanceof Refusal ? error.status : 500;
      if (status >= 500) {
        console.error(`[http] ${req.method} ${req.url}: ${errorMessage(error)}`);
      }
      const body =
        error instanceof Refusal && error.code !== undefined
          ? { error: errorMessage(error), code: error.code }
          : { error: errorMessage(error) };
      if (!res.headersSent) {
        json(res, status, body);
      } else {
        res.end();
      }
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
    // The UI's static files need no token: they hold no documents.
    if (req.method === "GET" || req.method === "HEAD") {
      await serveWeb(webDir, path, res);
    } else {
      json(res, 404, { error: "Not found" });
    }
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

/**
 * Streamable HTTP MCP for one folder, or a subfolder of one, whose tools treat it as the root.
 * Stateless: a fresh `McpServer` per request, since every piece of state lives in the shared
 * `Ragdown`. Bare `/mcp` is a 404 that says to pick a folder: no endpoint spans every folder.
 */
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
  if (config.http.secureLocalNet) {
    return true;
  }
  const provided = header?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!provided || !config.http.token) {
    return false;
  }
  // Compared as digests so neither the content nor the length leaks through timing.
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(provided), digest(config.http.token));
}
