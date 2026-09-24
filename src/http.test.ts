import { mkdir, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { Ragdown } from "./engine.ts";
import { assertAuthConfigured, createHttpServer } from "./http.ts";
import { tempSetup } from "./testing.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

async function serve(env: Record<string, string>) {
  const t = await tempSetup(env);
  closers.push(t.cleanup);
  await t.write("ops/backups.md", "# Backups\n\n## Restore\n\nRun pg_restore twice on postgres.");
  const rag = await Ragdown.start(t.config);
  closers.push(() => rag.close());
  await rag.sync(false);
  const webDir = join(t.root, "web");
  await mkdir(join(webDir, "assets"), { recursive: true });
  await writeFile(join(webDir, "index.html"), "<!doctype html><title>ragdown</title>");
  await writeFile(join(webDir, "assets", "app-1.js"), "console.log(1)");
  const server = createHttpServer(Promise.resolve(rag), t.config, webDir);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  closers.push(() => new Promise((done) => server.close(() => done())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { ...t, rag, url };
}

describe("HTTP server", () => {
  it("refuses to start with no token and no SECURE_LOCAL_NET", async () => {
    const t = await tempSetup();
    closers.push(t.cleanup);
    expect(() => assertAuthConfigured(t.config)).toThrow(/RAGDOWN_TOKEN/);
  });

  it("serves status openly and guards /mcp with the token", async () => {
    const t = await serve({ RAGDOWN_TOKEN: "secret" });
    const status = (await (await fetch(`${t.url}/api/status`)).json()) as {
      auth_required: boolean;
    };
    expect(status).toMatchObject({ name: "ragdown", ready: true, files: 1, chunks: 1 });
    expect(status).toMatchObject({
      settings: {
        watch: false,
        text_limit: 2000,
        hook: { top_k: 4, min_score: 0.2, min_ratio: 0, max_chars: 6000 },
      },
    });
    // Open to anyone who can reach the port, so nothing secret may ride along.
    expect(JSON.stringify(status)).not.toContain("secret");

    const post = (path: string, token?: string) =>
      fetch(`${t.url}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: "{}",
      });
    expect((await post("/mcp")).status).toBe(401);
    expect((await post("/mcp", "wrong")).status).toBe(401);
    // The hook route is gone: hooks call ragdown_context over /mcp.
    expect((await post("/api/context", "secret")).status).toBe(404);
    expect((await fetch(`${t.url}/api/nope`)).status).toBe(404);
  });

  it("lists indexed docs and reads one, behind the token", async () => {
    const t = await serve({ RAGDOWN_TOKEN: "secret" });
    await t.write("stray.txt", "not markdown");
    const get = (path: string, token = "secret") =>
      fetch(`${t.url}${path}`, { headers: { authorization: `Bearer ${token}` } });

    expect((await get("/api/docs", "wrong")).status).toBe(401);
    expect(await (await get("/api/docs")).json()).toMatchObject({
      docs: [{ path: "ops/backups.md", title: "Backups", chunks: 1 }],
    });

    const doc = (await (await get("/api/doc?path=ops%2Fbackups.md")).json()) as { text: string };
    expect(doc).toMatchObject({ path: "ops/backups.md", total_lines: 5 });
    expect(doc.text).toContain("pg_restore");

    expect((await get("/api/doc?path=stray.txt")).status).toBe(404);
    expect((await get("/api/doc?path=..%2F..%2Fetc%2Fpasswd")).status).toBe(404);
    expect((await get("/api/doc")).status).toBe(400);
  });

  it("serves the web UI, falling back to index.html for app routes", async () => {
    const t = await serve({ SECURE_LOCAL_NET: "true" });
    const status = (await (await fetch(`${t.url}/api/status`)).json()) as {
      auth_required: boolean;
    };
    expect(status.auth_required).toBe(false);

    const asset = await fetch(`${t.url}/assets/app-1.js`);
    expect(asset.headers.get("content-type")).toContain("text/javascript");
    expect(asset.headers.get("cache-control")).toContain("immutable");

    for (const path of ["/", "/docs/somewhere", "/%E0", "/../../etc/passwd"]) {
      const page = await fetch(`${t.url}${path}`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("<title>ragdown</title>");
    }
    expect((await fetch(`${t.url}/api/nope`)).status).toBe(404);
  });

  it("answers MCP tool calls over Streamable HTTP", async () => {
    const t = await serve({ RAGDOWN_TOKEN: "secret" });
    const client = new Client({ name: "test", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${t.url}/mcp`), {
        requestInit: { headers: { authorization: "Bearer secret" } },
      }),
    );
    closers.push(() => client.close());
    const result = (await client.callTool({
      name: "ragdown_recall",
      arguments: { query: "pg_restore", format: "json" },
    })) as CallToolResult;
    const first = result.content[0];
    const hits = JSON.parse(first?.type === "text" ? first.text : "{}").hits;
    expect(hits[0]).toMatchObject({ path: "ops/backups.md", heading: "Backups › Restore" });
  });

  it("scopes /mcp/<folder> to that folder, and 404s a folder that is not one", async () => {
    const t = await serve({ SECURE_LOCAL_NET: "true" });
    await t.write("notes/kafka.md", "# Kafka\n\nRetention on postgres is seven days.");
    await t.rag.sync(false);
    const recall = async (path: string) => {
      const client = new Client({ name: "test", version: "0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${t.url}${path}`)));
      closers.push(() => client.close());
      const result = (await client.callTool({
        name: "ragdown_recall",
        arguments: { query: "postgres", format: "json" },
      })) as CallToolResult;
      const first = result.content[0];
      return JSON.parse(first?.type === "text" ? first.text : "{}").hits.map(
        (hit: { path: string }) => hit.path,
      );
    };
    expect((await recall("/mcp")).sort()).toEqual(["notes/kafka.md", "ops/backups.md"]);
    expect(await recall("/mcp/notes")).toEqual(["kafka.md"]);
    expect(await recall("/mcp/ops/")).toEqual(["backups.md"]);

    const post = (path: string) =>
      fetch(`${t.url}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
    for (const path of ["/mcp/nope", "/mcp/ops/backups.md", "/mcp/%2E%2E", "/mcp/%E0"]) {
      expect((await post(path)).status, path).toBe(404);
    }
  });

  it("keeps ragdown_context's per-session memory across stateless HTTP requests", async () => {
    const t = await serve({ SECURE_LOCAL_NET: "true" });
    const contextFor = async () => {
      // A fresh client per call, as a hook runner would reconnect; the server keeps no MCP session.
      const client = new Client({ name: "hook", version: "0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${t.url}/mcp`)));
      closers.push(() => client.close());
      const result = (await client.callTool({
        name: "ragdown_context",
        arguments: { prompt: "how do I restore postgres?", session_id: "min-agent:1" },
      })) as CallToolResult;
      const first = result.content[0];
      return first?.type === "text" ? first.text : "";
    };
    expect(await contextFor()).toContain("ops/backups.md");
    expect(await contextFor()).toBe("");
  });
});
