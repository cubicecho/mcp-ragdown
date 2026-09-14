import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { Ragdown } from "./engine.ts";
import { createMcpServer } from "./server.ts";
import { tempSetup } from "./testing.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

async function connect(env: Record<string, string> = {}) {
  const t = await tempSetup(env);
  closers.push(t.cleanup);
  await t.write(
    "ops/backups.md",
    "# Backups\n\nNightly snapshots.\n\n## Restore\n\nRun pg_restore twice.",
  );
  const rag = await Ragdown.start(t.config);
  closers.push(() => rag.close());
  await rag.sync(false);

  const server = createMcpServer(Promise.resolve(rag), t.config.readOnly);
  const client = new Client({ name: "test", version: "0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  closers.push(() => client.close());

  const call = async (name: string, args: Record<string, unknown>) => {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    const first = result.content[0];
    return { isError: result.isError === true, text: first?.type === "text" ? first.text : "" };
  };
  return { ...t, rag, client, call };
}

describe("MCP server", () => {
  it("lists the write tools only when writable", async () => {
    const writable = await connect();
    expect((await writable.client.listTools()).tools.map((t) => t.name).sort()).toEqual([
      "ragdown_context",
      "ragdown_read_doc",
      "ragdown_recall",
      "ragdown_reindex",
      "ragdown_remember",
      "ragdown_stats",
    ]);
    const readOnly = await connect({ RAGDOWN_READ_ONLY: "true" });
    expect((await readOnly.client.listTools()).tools.map((t) => t.name).sort()).toEqual([
      "ragdown_context",
      "ragdown_read_doc",
      "ragdown_recall",
      "ragdown_stats",
    ]);
  });

  it("recalls in text and json, clipping with a pointer to the rest", async () => {
    const t = await connect();
    const text = await t.call("ragdown_recall", {
      query: "pg_restore restore",
      top_k: 1,
      max_chars: 5,
    });
    expect(text.text).toMatch(/^\[1\] ops\/backups\.md:7-7 — Backups › Restore \(similarity/);
    expect(text.text).toContain(
      '[clipped: 5 of 21 characters — ragdown_read_doc {path: "ops/backups.md", start_line: 7, end_line: 7}]',
    );

    const json = JSON.parse(
      (await t.call("ragdown_recall", { query: "pg_restore", format: "json" })).text,
    );
    expect(json.hits[0]).toMatchObject({ path: "ops/backups.md", heading: "Backups › Restore" });
  });

  it("returns hook context once per session, and empty text when there is none", async () => {
    const t = await connect();
    const args = { prompt: "how do I run pg_restore on backups?", session_id: "min-agent:1" };
    const first = await t.call("ragdown_context", args);
    expect(first.isError).toBe(false);
    expect(first.text).toMatch(/^<ragdown-context /);
    expect(first.text).toContain("ops/backups.md");
    expect(await t.call("ragdown_context", { ...args, top_k: 1 })).toMatchObject({
      isError: false,
      text: expect.not.stringContaining("Backups › Restore"),
    });
    expect((await t.call("ragdown_context", { prompt: "ok" })).text).toBe("");
  });

  it("reads files by line range and refuses paths outside the folder", async () => {
    const t = await connect();
    const doc = JSON.parse(
      (await t.call("ragdown_read_doc", { path: "ops/backups.md", start_line: 5, end_line: 7 }))
        .text,
    );
    expect(doc).toMatchObject({
      start_line: 5,
      end_line: 7,
      total_lines: 7,
      text: "## Restore\n\nRun pg_restore twice.",
    });

    const outside = await t.call("ragdown_read_doc", { path: "../data/meta.json" });
    expect(outside).toMatchObject({
      isError: true,
      text: expect.stringMatching(/outside the docs folder/),
    });
    const missing = await t.call("ragdown_read_doc", { path: "nope.md" });
    expect(missing.isError).toBe(true);
  });

  it("remembers a note, never overwriting, and indexes it before returning", async () => {
    const t = await connect();
    const args = {
      title: "Kafka retention",
      content: "Retention is seven days.",
      tags: ["ops"],
      name: "kafka",
    };
    const first = JSON.parse((await t.call("ragdown_remember", args)).text);
    const second = JSON.parse((await t.call("ragdown_remember", args)).text);
    expect([first.path, second.path]).toEqual(["notes/kafka.md", "notes/kafka-2.md"]);

    const written = await readFile(join(t.docsDir, "notes/kafka.md"), "utf8");
    expect(written).toMatch(
      /^---\ntitle: "Kafka retention"\ndate: \d{4}-\d{2}-\d{2}\ntags: \["ops"\]\n---\nRetention is seven days.\n$/,
    );

    const hits = JSON.parse(
      (await t.call("ragdown_recall", { query: "kafka retention", format: "json" })).text,
    ).hits;
    expect(hits[0].path).toMatch(/^notes\/kafka/);

    const outside = await t.call("ragdown_remember", { ...args, name: "../../outside" });
    expect(outside.isError).toBe(true);
  });

  it("reports stats", async () => {
    const t = await connect();
    const stats = JSON.parse((await t.call("ragdown_stats", { include_files: true })).text);
    expect(stats).toMatchObject({
      role: "primary",
      embedder: "hash-384",
      files: 1,
      chunks: 2,
      syncing: false,
    });
    expect(stats.file_list).toEqual([{ path: "ops/backups.md", chunks: 2 }]);
  });
});
