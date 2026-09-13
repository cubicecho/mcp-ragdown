import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Config } from "./config.ts";
import type { Ragdown } from "./engine.ts";
import { errorMessage } from "./errors.ts";
import { createMcpServer, SERVER_NAME, VERSION } from "./server.ts";

/** A prompt is a few kilobytes; anything near this is not a hook or an MCP message. */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * The HTTP face of the server, for running it in a container:
 *
 * - `GET /api/status` — unauthenticated liveness, with the index size once the model is loaded.
 * - `/mcp` — Streamable HTTP MCP, stateless: a fresh `McpServer` per request, since every piece of
 *   state lives in the shared `Ragdown`.
 * - `POST /api/context` — what the hook asks the unix socket for, for a hook on another machine
 *   or outside the container (`RAGDOWN_URL`).
 *
 * `/mcp` and `/api/context` need `Authorization: Bearer $RAGDOWN_TOKEN` unless
 * `SECURE_LOCAL_NET=true`. Plain `node:http` rather than Express: three routes do not need a
 * framework.
 */
export function createHttpServer(ready: Promise<Ragdown>, config: Config): Server {
  return createServer((req, res) => {
    handle(ready, config, req, res).catch((error: unknown) => {
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
      ...(rag ? await rag.stats(false) : {}),
    });
    return;
  }

  if (path !== "/mcp" && path !== "/api/context") {
    json(res, 404, { error: "Not found" });
    return;
  }
  if (!authorized(config, req.headers.authorization)) {
    json(res, 401, { error: "Unauthorized" });
    return;
  }

  if (path === "/api/context") {
    if (req.method !== "POST") {
      json(res, 405, { error: "Method not allowed" });
      return;
    }
    const body = (await readJson(req)) as { prompt?: unknown; session_id?: unknown };
    const rag = await ready;
    const context = await rag.context(
      typeof body.prompt === "string" ? body.prompt : "",
      typeof body.session_id === "string" && body.session_id ? body.session_id : undefined,
    );
    json(res, 200, { context: context ?? null });
    return;
  }

  // Every method, not only POST: clients open a GET for the SSE stream and send DELETE to end a
  // session, and a 404 for those looks like a broken server.
  const server = createMcpServer(ready, config.readOnly);
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
