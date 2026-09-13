#!/usr/bin/env node
import { parseArgs } from "node:util";
import { type Config, loadConfig, loadRemoteHookConfig } from "./config.ts";
import { errorMessage } from "./errors.ts";

/*
 * Every command logs to stderr only. For `stdio` stdout is the JSON-RPC channel, and for `hook` it
 * is what Claude Code adds to the prompt; a stray console.log corrupts either.
 *
 * Modules are imported per command, so `hook` loads neither LanceDB nor ONNX Runtime when a primary
 * is running to answer it: that is most of its latency, paid on every prompt.
 */

const USAGE = `ragdown <command> [--docs <folder>] [--data <dir>]

  stdio              MCP server over stdio (default)
  serve              MCP over Streamable HTTP at /mcp on $PORT (default 3000), for Docker
  index [--full]     sync the index with the folder and print what changed
  search <query>     search from the terminal [--top-k N] [--json]
  stats              index status [--files]
  hook               Claude Code UserPromptSubmit hook: event on stdin, context on stdout;
                     with RAGDOWN_URL set, asks that server instead of a local index

Environment: RAGDOWN_DOCS_DIR (required unless --docs), see README.md for the rest.`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      docs: { type: "string" },
      data: { type: "string" },
      full: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      files: { type: "boolean", default: false },
      "top-k": { type: "string", default: "8" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command = "stdio", ...rest] = positionals;
  if (values.help || command === "help") {
    console.error(USAGE);
    return;
  }

  const remote = command === "hook" ? loadRemoteHookConfig() : undefined;
  if (remote) {
    const { hookMain } = await import("./hook.ts");
    await hookMain(remote);
    return exit();
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
    case "hook": {
      const { hookMain } = await import("./hook.ts");
      await hookMain(config);
      return exit();
    }
    case "index": {
      const { Ragdown } = await import("./engine.ts");
      const rag = await Ragdown.start(config, { background: false });
      console.log(JSON.stringify(await rag.sync(values.full), null, 2));
      await rag.close();
      return exit();
    }
    case "search": {
      const query = rest.join(" ");
      if (!query) throw new Error("search needs a query");
      const [{ Ragdown }, { formatHits, hitJson }] = await Promise.all([
        import("./engine.ts"),
        import("./format.ts"),
      ]);
      const rag = await Ragdown.start(config, { readerOnly: true });
      const hits = await rag.recall(query, Number(values["top-k"]));
      console.log(
        values.json
          ? JSON.stringify(hits.map(hitJson), null, 2)
          : formatHits(hits, config.textLimit),
      );
      return exit();
    }
    case "stats": {
      const { Ragdown } = await import("./engine.ts");
      const rag = await Ragdown.start(config, { readerOnly: true });
      console.log(JSON.stringify(await rag.stats(values.files), null, 2));
      return exit();
    }
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

/**
 * ONNX Runtime and LanceDB keep native threads alive after their work is done, so a one-shot
 * command would otherwise sit there after printing its answer. Exit once stdout has flushed: on
 * macOS a pipe is asynchronous and an immediate exit truncates the hook's output.
 */
function exit(): void {
  process.stdout.write("", () => process.exit());
}

main().catch((error: unknown) => {
  console.error(`ragdown: ${errorMessage(error)}`);
  process.exit(1);
});
