import { readFile, utimes } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { Ragdown } from "./engine.ts";
import { Scope } from "./scope.ts";
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

  const server = createMcpServer(Promise.resolve(new Scope(rag)), t.config.readOnly);
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
      "ragdown_backlinks",
      "ragdown_context",
      "ragdown_edit",
      "ragdown_list",
      "ragdown_read_doc",
      "ragdown_recall",
      "ragdown_reindex",
      "ragdown_remember",
      "ragdown_stats",
    ]);
    const readOnly = await connect({ RAGDOWN_READ_ONLY: "true" });
    expect((await readOnly.client.listTools()).tools.map((t) => t.name).sort()).toEqual([
      "ragdown_backlinks",
      "ragdown_context",
      "ragdown_list",
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
      /^---\ntitle: "Kafka retention"\ndate: \d{4}-\d{2}-\d{2}\ntags: \["ops"\]\ncreated_by: ragdown_remember\n---\nRetention is seven days.\n$/,
    );

    const hits = JSON.parse(
      (await t.call("ragdown_recall", { query: "kafka retention", format: "json" })).text,
    ).hits;
    expect(hits[0].path).toMatch(/^notes\/kafka/);

    const outside = await t.call("ragdown_remember", { ...args, name: "../../outside" });
    expect(outside.isError).toBe(true);
  });

  it("edits a note only over the version it read, and appends under a heading", async () => {
    const t = await connect();
    const read = async () =>
      JSON.parse((await t.call("ragdown_read_doc", { path: "ops/backups.md" })).text);
    const { hash } = await read();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    const blind = await t.call("ragdown_edit", { path: "ops/backups.md", text: "# Gone" });
    expect(blind).toMatchObject({ isError: true, text: expect.stringMatching(/base_hash/) });

    const appended = await t.call("ragdown_edit", {
      path: "ops/backups.md",
      text: "Check the checksum first.",
      append: true,
      heading: "Backups",
      base_hash: hash,
    });
    expect(appended.isError).toBe(false);
    // Nightly snapshots… is under Backups, and Restore is nested in it: the section ends at EOF.
    await t.call("ragdown_edit", {
      path: "ops/backups.md",
      text: "## Offsite\n\nS3, weekly.",
      append: true,
    });
    const after = await read();
    expect(after.text).toBe(
      "# Backups\n\nNightly snapshots.\n\n## Restore\n\nRun pg_restore twice.\n\nCheck the checksum first.\n\n## Offsite\n\nS3, weekly.\n",
    );

    const stale = await t.call("ragdown_edit", {
      path: "ops/backups.md",
      text: "# Backups",
      base_hash: hash,
    });
    expect(stale).toMatchObject({ isError: true, text: expect.stringMatching(/changed on disk/) });

    const replaced = await t.call("ragdown_edit", {
      path: "ops/backups.md",
      text: "# Backups\n\nNone.\n",
      base_hash: after.hash,
    });
    expect(JSON.parse(replaced.text)).toMatchObject({ path: "ops/backups.md", created: false });
    expect(await readFile(join(t.docsDir, "ops/backups.md"), "utf8")).toBe("# Backups\n\nNone.\n");

    const created = await t.call("ragdown_edit", { path: "ops/new.md", text: "# New\n" });
    expect(JSON.parse(created.text)).toMatchObject({ created: true });
    const noHeading = await t.call("ragdown_edit", {
      path: "ops/new.md",
      text: "x",
      append: true,
      heading: "Nope",
    });
    expect(noHeading).toMatchObject({ isError: true, text: expect.stringMatching(/no heading/) });
    const hidden = await t.call("ragdown_edit", { path: ".obsidian/x.md", text: "x" });
    expect(hidden.isError).toBe(true);
  });

  it("appends between sections, keeping the next heading", async () => {
    const t = await connect();
    await t.write("a.md", "# A\n\n## One\n\nfirst\n\n\n## Two\n\nsecond\n");
    await t.rag.sync(false);
    await t.call("ragdown_edit", { path: "a.md", text: "more", append: true, heading: "One" });
    expect(await readFile(join(t.docsDir, "a.md"), "utf8")).toBe(
      "# A\n\n## One\n\nfirst\n\nmore\n\n## Two\n\nsecond\n",
    );
  });

  it("lists notes by folder and tag, most recent first", async () => {
    const t = await connect();
    await t.write("notes/a.md", "---\ntitle: Alpha\ntags: [project/alpha]\n---\nA.");
    await t.write("notes/b.md", "# Beta\n\n#ops");
    await t.rag.sync(false);
    const list = async (args: Record<string, unknown>) =>
      JSON.parse((await t.call("ragdown_list", args)).text);

    expect((await list({})).notes.map((n: { path: string }) => n.path)).toEqual([
      "notes/a.md",
      "notes/b.md",
      "ops/backups.md",
    ]);
    const tagged = await list({ tag: "#project" });
    expect(tagged).toMatchObject({
      total: 1,
      notes: [{ path: "notes/a.md", title: "Alpha", tags: ["project/alpha"] }],
    });
    expect((await list({ path_prefix: "notes/", limit: 1 })).total).toBe(2);
    expect((await list({ path_prefix: "notes/", limit: 1 })).notes).toHaveLength(1);

    const past = new Date(Date.now() - 60_000);
    await utimes(join(t.docsDir, "notes/a.md"), past, past);
    await utimes(join(t.docsDir, "notes/b.md"), new Date(), new Date());
    await t.rag.sync(false);
    const recent = await list({ sort: "recent", path_prefix: "notes" });
    expect(recent.notes.map((n: { path: string }) => n.path)).toEqual(["notes/b.md", "notes/a.md"]);
  });

  it("lists the notes that link to a note, by wikilink, alias and relative link", async () => {
    const t = await connect();
    await t.write("ops/restore.md", "---\naliases: [DR]\n---\n# Restore\n");
    await t.write("a.md", "# A\n\nSee [[restore]].\n\nAnd [[DR|disaster recovery]].");
    await t.write("b.md", "# B\n\n[steps](ops/restore.md) but `[[restore]]` is code.");
    await t.write("c.md", "# C\n\nNothing.");
    await t.rag.sync(false);
    const found = JSON.parse((await t.call("ragdown_backlinks", { path: "ops/restore.md" })).text);
    expect(found).toEqual({
      path: "ops/restore.md",
      backlinks: [
        {
          path: "a.md",
          title: "A",
          lines: [
            { line: 3, text: "See [[restore]]." },
            { line: 5, text: "And [[DR|disaster recovery]]." },
          ],
        },
        {
          path: "b.md",
          title: "B",
          lines: [{ line: 3, text: "[steps](ops/restore.md) but `[[restore]]` is code." }],
        },
      ],
    });
    expect((await t.call("ragdown_backlinks", { path: "nope.md" })).isError).toBe(true);
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
