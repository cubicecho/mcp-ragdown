import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { Ragdown } from "./engine.ts";
import { runRemoteHook } from "./hook.ts";
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
  const server = createHttpServer(Promise.resolve(rag), t.config);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  closers.push(() => new Promise((done) => server.close(() => done())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { ...t, url };
}

describe("HTTP server", () => {
  it("refuses to start with no token and no SECURE_LOCAL_NET", async () => {
    const t = await tempSetup();
    closers.push(t.cleanup);
    expect(() => assertAuthConfigured(t.config)).toThrow(/RAGDOWN_TOKEN/);
  });

  it("serves status openly and guards /mcp and /api/context with the token", async () => {
    const t = await serve({ RAGDOWN_TOKEN: "secret" });
    const status = await (await fetch(`${t.url}/api/status`)).json();
    expect(status).toMatchObject({ name: "ragdown", ready: true, files: 1, chunks: 1 });

    const post = (path: string, token?: string) =>
      fetch(`${t.url}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ prompt: "how do I restore postgres?", session_id: "s" }),
      });
    expect((await post("/api/context")).status).toBe(401);
    expect((await post("/api/context", "wrong")).status).toBe(401);
    expect((await post("/mcp", "wrong")).status).toBe(401);
    expect((await fetch(`${t.url}/nope`)).status).toBe(404);

    const answered = await post("/api/context", "secret");
    expect(((await answered.json()) as { context: string }).context).toContain("ops/backups.md");
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

  it("feeds a remote hook", async () => {
    const t = await serve({ SECURE_LOCAL_NET: "true" });
    const event = {
      hook_event_name: "UserPromptSubmit",
      session_id: "s",
      prompt: "how do I restore postgres?",
    };
    const output = await runRemoteHook(event, { url: t.url, token: null, timeoutMs: 5000 });
    expect(JSON.parse(output ?? "{}").hookSpecificOutput.additionalContext).toContain(
      "ops/backups.md",
    );
    // Same session: already injected, so nothing new.
    expect(
      await runRemoteHook(event, { url: t.url, token: null, timeoutMs: 5000 }),
    ).toBeUndefined();
  });
});
