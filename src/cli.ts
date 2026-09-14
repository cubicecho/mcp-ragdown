#!/usr/bin/env node
import { parseArgs } from "node:util";
import { type Config, loadConfig } from "./config.ts";
import { errorMessage } from "./errors.ts";

/*
 * Both commands log to stderr only: for `stdio` stdout is the JSON-RPC channel, and a stray
 * console.log corrupts it. Everything else — searching, indexing, hook context — is an MCP tool.
 */

const USAGE = `ragdown <command> [--docs <folder>] [--data <dir>]

  stdio              MCP server over stdio (default)
  serve              MCP over Streamable HTTP at /mcp on $PORT (default 3000), plus the web UI

Environment: RAGDOWN_DOCS_DIR (required unless --docs), see README.md for the rest.`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      docs: { type: "string" },
      data: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command = "stdio"] = positionals;
  if (values.help || command === "help") {
    console.error(USAGE);
    return;
  }

  const config = loadConfig({
    ...process.env,
    ...(values.docs ? { RAGDOWN_DOCS_DIR: values.docs } : {}),
    ...(values.data ? { RAGDOWN_DATA_DIR: values.data } : {}),
  });

  switch (command) {
    case "stdio":
      return stdio(config);
    case "serve":
      return serve(config);
    default:
      throw new Error(`unknown command "${command}"\n\n${USAGE}`);
  }
}

async function stdio(config: Config): Promise<void> {
  const [{ StdioServerTransport }, { Ragdown }, { createMcpServer }] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/stdio.js"),
    import("./engine.ts"),
    import("./server.ts"),
  ]);
  const ready = Ragdown.start(config);
  // Logged here; each tool call awaits the same promise and reports the failure as its result.
  ready.catch((error: unknown) =>
    console.error(`[ragdown] startup failed: ${errorMessage(error)}`),
  );
  const server = createMcpServer(ready, config.readOnly);
  await server.connect(new StdioServerTransport());
  console.error(`[ragdown] stdio ready (docs: ${config.docsDir})`);

  const shutdown = async () => {
    // Release the socket so another window can become primary without waiting for takeover.
    await (await ready.catch(() => undefined))?.close();
    process.exit(0);
  };
  process.stdin.on("close", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

async function serve(config: Config): Promise<void> {
  const [{ Ragdown }, { assertAuthConfigured, createHttpServer }] = await Promise.all([
    import("./engine.ts"),
    import("./http.ts"),
  ]);
  assertAuthConfigured(config);
  const ready = Ragdown.start(config);
  ready.catch((error: unknown) => {
    console.error(`[ragdown] startup failed: ${errorMessage(error)}`);
    process.exit(1);
  });
  const server = createHttpServer(ready, config);
  // Listening before the model loads: /api/status answers `ready: false` rather than refusing.
  await new Promise<void>((done) => server.listen(config.http.port, done));
  console.error(
    `[ragdown] http on :${config.http.port}/mcp (docs: ${config.docsDir}, auth: ${config.http.secureLocalNet ? "off" : "bearer"})`,
  );

  const shutdown = async () => {
    server.close();
    await (await ready.catch(() => undefined))?.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

main().catch((error: unknown) => {
  console.error(`ragdown: ${errorMessage(error)}`);
  process.exit(1);
});
