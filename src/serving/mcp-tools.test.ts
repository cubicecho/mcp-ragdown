import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { Scope } from "../documents/scope.ts";
import { contentHash } from "../shared/content-hash.ts";
import { tempSetup } from "../shared/testing.ts";
import { Ragdown } from "./engine.ts";
import { createMcpServer } from "./mcp-tools.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
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

  const server = createMcpServer(Promise.resolve(new Scope(rag)), t.config);
  const client = new Client({ name: "test", version: "0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  closers.push(() => client.close());

  const call = async (name: string, args: Record<string, unknown>) => {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    const first = result.content[0];
    return { isError: result.isError === true, text: first?.type === "text" ? first.text : "" };
  };

  /** A document as `ragdown_read_doc` answers: its header line, the hash in that, and its text. */
  const read = async (path: string, range: Record<string, number> = {}) => {
    const { text } = await call("ragdown_read_doc", { path, ...range });
    const headerEnd = text.indexOf("\n");
    return {
      header: text.slice(0, headerEnd),
      hash: hashIn(text),
      text: text.slice(headerEnd + 1),
    };
  };
  /** A listing as `ragdown_list` answers: the line that counts it, then a line per document. */
  const list = async (args: Record<string, unknown> = {}) => {
    const [count = "", ...lines] = (await call("ragdown_list", args)).text.split("\n");
    return { count, lines, paths: lines.map((line) => line.split(" — ")[0]) };
  };
  return { ...t, rag, client, call, read, list };
}

/** The short hash a read or a write names in its result. */
function hashIn(result: string): string {
  return /hash ([0-9a-f]+)/.exec(result)?.[1] ?? "";
}

const today = new Date().toISOString().slice(0, 10);

describe("MCP server", () => {
  it("lists the write tools only when writable", async () => {
    const writable = await connect();
    expect((await writable.client.listTools()).tools.map((t) => t.name).sort()).toEqual([
      "ragdown_backlinks",
      "ragdown_context",
      "ragdown_delete",
      "ragdown_edit",
      "ragdown_list",
      "ragdown_move",
      "ragdown_read_doc",
      "ragdown_recall",
      "ragdown_reindex",
      "ragdown_remember",
      "ragdown_stats",
      "ragdown_write",
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

  it("leaves out the tools it is told to", async () => {
    const t = await connect({
      RAGDOWN_DISABLED_TOOLS: "ragdown_context, ragdown_stats,ragdown_reindex",
      RAGDOWN_READ_ONLY: "true",
    });
    expect((await t.client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      "ragdown_backlinks",
      "ragdown_list",
      "ragdown_read_doc",
      "ragdown_recall",
    ]);
  });

  it("recalls in text and json, clipping with a pointer to the rest", async () => {
    const t = await connect();
    const text = await t.call("ragdown_recall", {
      query: "pg_restore restore",
      top_k: 1,
      max_chars: 5,
    });
    expect(text.text).toMatch(
      new RegExp(
        `^\\[1\\] ops/backups\\.md:7-7 — Backups › Restore \\(similarity \\d\\.\\d\\d, changed ${today}\\)`,
      ),
    );
    expect(text.text).toContain(
      '[clipped: 5 of 21 characters — ragdown_read_doc {path: "ops/backups.md", start_line: 7, end_line: 7}]',
    );

    const json = JSON.parse(
      (await t.call("ragdown_recall", { query: "pg_restore", format: "json" })).text,
    );
    expect(json.hits[0]).toMatchObject({ path: "ops/backups.md", heading: "Backups › Restore" });
    expect(json.hits[0].modified.slice(0, 10)).toBe(today);
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

  it("wraps hook context as a Claude Code hook's additional context", async () => {
    const t = await connect();
    const args = { prompt: "how do I run pg_restore on backups?", format: "claude-code" };
    const block = (await t.call("ragdown_context", { ...args, format: "text" })).text;
    expect(JSON.parse((await t.call("ragdown_context", args)).text)).toEqual({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: block },
    });
    // Nothing to add is empty text in either format, which a hook treats as nothing.
    expect((await t.call("ragdown_context", { ...args, prompt: "ok" })).text).toBe("");
  });

  it("returns a section again once the session is reset", async () => {
    const t = await connect();
    const args = { prompt: "how do I run pg_restore on backups?", session_id: "claude:1" };
    const first = (await t.call("ragdown_context", args)).text;
    expect(first).toContain("ops/backups.md");
    expect((await t.call("ragdown_context", args)).text).toBe("");

    // What a hook sends after a compaction: nothing to search for, only the session to forget.
    expect(await t.call("ragdown_context", { ...args, prompt: "", reset: true })).toEqual({
      isError: false,
      text: "",
    });
    expect((await t.call("ragdown_context", args)).text).toBe(first);
    // Another session's memory is left alone, and a reset with a prompt answers it.
    await t.call("ragdown_context", { ...args, session_id: "claude:2" });
    await t.call("ragdown_context", { prompt: "", session_id: "claude:1", reset: true });
    expect((await t.call("ragdown_context", { ...args, session_id: "claude:2" })).text).toBe("");
    expect((await t.call("ragdown_context", { ...args, reset: true })).text).toBe(first);
  });

  it("reads files by line range and refuses paths outside the folder", async () => {
    const t = await connect();
    // The text is as it is in the file, under one line that says where it is from.
    const doc = await t.call("ragdown_read_doc", {
      path: "ops/backups.md",
      start_line: 5,
      end_line: 7,
    });
    expect(doc.text).toMatch(
      /^ops\/backups\.md:5-7 of 7 \(hash [0-9a-f]{12}\)\n## Restore\n\nRun pg_restore twice\.$/,
    );

    const outside = await t.call("ragdown_read_doc", { path: "../data/meta.json" });
    expect(outside).toMatchObject({
      isError: true,
      text: expect.stringMatching(/outside the docs folder/),
    });
    const missing = await t.call("ragdown_read_doc", { path: "nope.md" });
    expect(missing.isError).toBe(true);
  });

  it("remembers a document, never overwriting, and indexes it before returning", async () => {
    const t = await connect();
    const args = {
      title: "Kafka retention",
      content: "Retention is seven days.",
      tags: ["ops"],
      name: "kafka",
    };
    const first = await t.call("ragdown_remember", args);
    const second = await t.call("ragdown_remember", args);
    expect([first.text, second.text]).toEqual(["saved notes/kafka.md", "saved notes/kafka-2.md"]);

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

  it("writes a document only over the version it read, and appends under a heading", async () => {
    const t = await connect();
    const read = () => t.read("ops/backups.md");
    const { hash } = await read();
    expect(hash).toMatch(/^[0-9a-f]{12}$/);

    const blind = await t.call("ragdown_write", { path: "ops/backups.md", text: "# Gone" });
    expect(blind).toMatchObject({ isError: true, text: expect.stringMatching(/base_hash/) });

    const appended = await t.call("ragdown_write", {
      path: "ops/backups.md",
      text: "Check the checksum first.",
      append: true,
      heading: "Backups",
      base_hash: hash,
    });
    expect(appended.isError).toBe(false);
    // Nightly snapshots… is under Backups, and Restore is nested in it: the section ends at EOF.
    await t.call("ragdown_write", {
      path: "ops/backups.md",
      text: "## Offsite\n\nS3, weekly.",
      append: true,
    });
    const after = await read();
    expect(after.text).toBe(
      "# Backups\n\nNightly snapshots.\n\n## Restore\n\nRun pg_restore twice.\n\nCheck the checksum first.\n\n## Offsite\n\nS3, weekly.\n",
    );

    const stale = await t.call("ragdown_write", {
      path: "ops/backups.md",
      text: "# Backups",
      base_hash: hash,
    });
    expect(stale).toMatchObject({ isError: true, text: expect.stringMatching(/changed on disk/) });

    const replaced = await t.call("ragdown_write", {
      path: "ops/backups.md",
      text: "# Backups\n\nNone.\n",
      base_hash: after.hash,
    });
    expect(replaced.text).toMatch(/^wrote ops\/backups\.md \(hash [0-9a-f]{12}\)$/);
    expect(await readFile(join(t.docsDir, "ops/backups.md"), "utf8")).toBe("# Backups\n\nNone.\n");
    // The whole hash names the version too, and less than the short one names none.
    const tooShort = await t.call("ragdown_write", {
      path: "ops/backups.md",
      text: "# Backups\n\nSome.\n",
      base_hash: hashIn(replaced.text).slice(0, 6),
    });
    expect(tooShort.isError).toBe(true);
    const whole = await t.call("ragdown_write", {
      path: "ops/backups.md",
      text: "# Backups\n\nSome.\n",
      base_hash: contentHash("# Backups\n\nNone.\n"),
    });
    expect(whole.isError).toBe(false);

    const created = await t.call("ragdown_write", { path: "ops/new.md", text: "# New\n" });
    expect(created.text).toMatch(/^created ops\/new\.md \(hash [0-9a-f]{12}\)$/);
    const noHeading = await t.call("ragdown_write", {
      path: "ops/new.md",
      text: "x",
      append: true,
      heading: "Nope",
    });
    expect(noHeading).toMatchObject({ isError: true, text: expect.stringMatching(/no heading/) });
    const hidden = await t.call("ragdown_write", { path: ".obsidian/x.md", text: "x" });
    expect(hidden.isError).toBe(true);
  });

  it("records that ragdown_write created a document, and keeps that when it is replaced", async () => {
    const t = await connect();
    const onDisk = (path: string) => readFile(join(t.docsDir, path), "utf8");
    const write = async (args: Record<string, unknown>) => ({
      hash: hashIn((await t.call("ragdown_write", args)).text),
    });

    const plain = await write({ path: "new/plain.md", text: "# Plain\n\nText.", session_id: "s9" });
    expect(await onDisk("new/plain.md")).toBe(
      '---\ncreated_by: ragdown_write\nsession: "s9"\n---\n# Plain\n\nText.',
    );
    // The hash is of the file as written, so the next edit can be made against it.
    expect((await t.read("new/plain.md")).hash).toBe(plain.hash);

    await write({ path: "new/front.md", text: "---\ntitle: Front\n---\nText." });
    expect(await onDisk("new/front.md")).toBe(
      "---\ntitle: Front\ncreated_by: ragdown_write\n---\nText.",
    );
    await write({ path: "new/own.md", text: "---\ncreated_by: importer\n---\nText." });
    expect(await onDisk("new/own.md")).toBe("---\ncreated_by: importer\n---\nText.");

    // Replaced with text that has no frontmatter, it is still the agent's.
    await write({ path: "new/plain.md", text: "# Plain\n\nRewritten.", base_hash: plain.hash });
    expect(await onDisk("new/plain.md")).toBe(
      '---\ncreated_by: ragdown_write\nsession: "s9"\n---\n# Plain\n\nRewritten.',
    );
    // The user's own document stays the user's, replaced or appended to.
    const mine = await t.read("ops/backups.md");
    await write({ path: "ops/backups.md", text: "# Backups\n\nWeekly.", base_hash: mine.hash });
    await write({ path: "ops/backups.md", text: "And monthly.", append: true });
    expect(await onDisk("ops/backups.md")).not.toContain("created_by");

    expect((await t.list({ written_by: "agent" })).paths).toEqual([
      "new/front.md",
      "new/own.md",
      "new/plain.md",
    ]);
  });

  it("appends between sections, keeping the next heading", async () => {
    const t = await connect();
    await t.write("a.md", "# A\n\n## One\n\nfirst\n\n\n## Two\n\nsecond\n");
    await t.rag.sync(false);
    await t.call("ragdown_write", { path: "a.md", text: "more", append: true, heading: "One" });
    expect(await readFile(join(t.docsDir, "a.md"), "utf8")).toBe(
      "# A\n\n## One\n\nfirst\n\nmore\n\n## Two\n\nsecond\n",
    );
  });

  it("edits passages of a document, all of them or none", async () => {
    const t = await connect();
    const onDisk = () => readFile(join(t.docsDir, "ops/backups.md"), "utf8");
    const { hash } = await t.read("ops/backups.md");

    const replaced = await t.call("ragdown_edit", {
      path: "ops/backups.md",
      edits: [
        { old_text: "Nightly", new_text: "Hourly" },
        { old_text: "Run pg_restore twice.", new_text: "Run pg_restore once.\n\nThen vacuum." },
      ],
      base_hash: hash,
    });
    expect(replaced.text).toMatch(/^edited ops\/backups\.md \(replaced 2, hash [0-9a-f]{12}\)$/);
    // The hash is the one to make the next edit against, with no read in between.
    expect(hashIn(replaced.text)).toBe((await t.read("ops/backups.md")).hash);
    const after =
      "# Backups\n\nHourly snapshots.\n\n## Restore\n\nRun pg_restore once.\n\nThen vacuum.";
    expect(await onDisk()).toBe(after);
    // Indexed before returning, like every other write.
    const hits = JSON.parse(
      (await t.call("ragdown_recall", { query: "vacuum", format: "json" })).text,
    ).hits;
    expect(hits[0]).toMatchObject({ path: "ops/backups.md" });

    // The first edit applies and the second does not, so neither is written.
    const partial = await t.call("ragdown_edit", {
      path: "ops/backups.md",
      edits: [
        { old_text: "Hourly", new_text: "Daily" },
        { old_text: "Run pg_restore twice.", new_text: "x" },
      ],
    });
    expect(partial).toMatchObject({
      isError: true,
      text: expect.stringMatching(/^edit 2 of 2: old_text is not in the document/),
    });
    // A passage that is nearly there is answered with the one that is.
    const nearly = await t.call("ragdown_edit", {
      path: "ops/backups.md",
      edits: [{ old_text: "Hourly  snapshots.", new_text: "Daily snapshots." }],
    });
    expect(nearly).toMatchObject({
      isError: true,
      text: expect.stringMatching(
        /The nearest passage \(lines 3-3\) follows; .*:\nHourly snapshots\.$/s,
      ),
    });
    const stale = await t.call("ragdown_edit", {
      path: "ops/backups.md",
      edits: [{ old_text: "Hourly", new_text: "Daily" }],
      base_hash: hash,
    });
    expect(stale).toMatchObject({ isError: true, text: expect.stringMatching(/changed on disk/) });
    const missing = await t.call("ragdown_edit", {
      path: "ops/nope.md",
      edits: [{ old_text: "a", new_text: "b" }],
    });
    expect(missing).toMatchObject({
      isError: true,
      text: expect.stringMatching(/no such document/),
    });
    expect(await onDisk()).toBe(after);
  });

  it("edits a CRLF document, keeping its line endings", async () => {
    const t = await connect();
    await t.write("crlf.md", "# A\r\n\r\nfirst\r\nsecond\r\n");
    await t.call("ragdown_edit", {
      path: "crlf.md",
      edits: [{ old_text: "first\nsecond", new_text: "one\ntwo" }],
    });
    expect(await readFile(join(t.docsDir, "crlf.md"), "utf8")).toBe("# A\r\n\r\none\r\ntwo\r\n");
  });

  it("moves a document and a subfolder, keeping the links to them", async () => {
    const t = await connect();
    await t.write("index.md", "# Index\n\nSee [[backups#Restore]] and [backups](ops/backups.md).");
    await t.rag.sync(false);

    const renamed = await t.call("ragdown_move", {
      from: "ops/backups.md",
      to: "ops/snapshots.md",
    });
    expect(renamed.text).toBe(
      "moved ops/backups.md to ops/snapshots.md; links updated in index.md",
    );
    const folder = await t.call("ragdown_move", { from: "ops", to: "infra/db" });
    expect(folder.text).toBe("moved ops to infra/db; links updated in index.md");
    expect(await readFile(join(t.docsDir, "index.md"), "utf8")).toBe(
      "# Index\n\nSee [[snapshots#Restore]] and [backups](infra/db/snapshots.md).",
    );
    expect((await t.list()).paths).toEqual(["index.md", "infra/db/snapshots.md"]);

    const taken = await t.call("ragdown_move", { from: "index.md", to: "infra/db/snapshots.md" });
    expect(taken).toMatchObject({ isError: true, text: expect.stringMatching(/already exists/) });
    const outside = await t.call("ragdown_move", { from: "index.md", to: "../index.md" });
    expect(outside.isError).toBe(true);
  });

  it("deletes a document, and a subfolder that holds anything only when told to", async () => {
    const t = await connect();
    await t.write("ops/diagram.png", "png");
    await t.write("ops/old/pg.md", "# Postgres");
    await t.rag.sync(false);

    const { hash } = await t.read("ops/old/pg.md");
    const stale = await t.call("ragdown_delete", {
      path: "ops/old/pg.md",
      base_hash: "0".repeat(64),
    });
    expect(stale).toMatchObject({ isError: true, text: expect.stringMatching(/changed since/) });
    const folder = await t.call("ragdown_delete", { path: "ops/old", base_hash: hash });
    expect(folder).toMatchObject({ isError: true, text: expect.stringMatching(/subfolder/) });
    const doc = await t.call("ragdown_delete", { path: "ops/old/pg.md", base_hash: hash });
    expect(doc).toEqual({ isError: false, text: "deleted ops/old/pg.md" });
    const again = await t.call("ragdown_delete", { path: "ops/old/pg.md" });
    expect(again).toMatchObject({ isError: true, text: expect.stringMatching(/no such/) });
    expect((await t.call("ragdown_delete", { path: "ops/old" })).isError).toBe(false);

    const full = await t.call("ragdown_delete", { path: "ops" });
    expect(full).toMatchObject({ isError: true, text: expect.stringMatching(/recursive/) });
    expect(await readFile(join(t.docsDir, "ops/backups.md"), "utf8")).toContain("# Backups");
    const attachment = await t.call("ragdown_delete", { path: "ops/diagram.png" });
    expect(attachment.isError).toBe(true);

    const gone = await t.call("ragdown_delete", { path: "ops", recursive: true });
    expect(gone).toEqual({ isError: false, text: "deleted ops" });
    expect((await t.call("ragdown_list", {})).text).toBe("No documents.");
    expect((await t.call("ragdown_delete", { path: ".", recursive: true })).isError).toBe(true);
    expect((await t.call("ragdown_delete", { path: "..", recursive: true })).isError).toBe(true);
  });

  it("lists documents by folder and tag, most recent first", async () => {
    const t = await connect();
    await t.write("notes/a.md", "---\ntitle: Alpha\ntags: [project/alpha]\n---\nA.");
    await t.write("notes/b.md", "# Beta\n\n#ops");
    await t.rag.sync(false);

    expect(await t.list()).toMatchObject({
      count: "documents: 3",
      paths: ["notes/a.md", "notes/b.md", "ops/backups.md"],
    });
    expect((await t.call("ragdown_list", { tag: "#project" })).text).toBe(
      `documents: 1\nnotes/a.md — Alpha [#project/alpha] (changed ${today})`,
    );
    expect(await t.list({ path_prefix: "notes/", limit: 1 })).toMatchObject({
      count: "documents: 1 of 2",
      paths: ["notes/a.md"],
    });

    // The index keeps a file's mtime until its content changes, so b is changed, not only touched.
    await new Promise((done) => setTimeout(done, 20));
    await t.write("notes/b.md", "# Beta\n\n#ops, changed");
    await t.rag.sync(false);
    const recent = await t.list({ sort: "recent", path_prefix: "notes" });
    expect(recent.paths).toEqual(["notes/b.md", "notes/a.md"]);
  });

  it("tells an agent's documents from the user's, when searching and listing", async () => {
    const t = await connect();
    await t.call("ragdown_remember", {
      title: "Restore drill",
      content: "The pg_restore drill runs on Fridays.",
      name: "drill",
      session_id: "s1",
    });
    await t.call("ragdown_remember", {
      title: "Restore window",
      content: "pg_restore needs a one hour window.",
      name: "window",
    });
    const recall = async (args: Record<string, unknown>) =>
      JSON.parse(
        (await t.call("ragdown_recall", { query: "pg_restore", format: "json", ...args })).text,
      ).hits as { path: string; created_by?: string }[];
    // A hit is a section, so a document with two matching ones is there twice.
    const paths = async (args: Record<string, unknown>) =>
      [...new Set((await recall(args)).map((hit) => hit.path))].sort();

    expect(await paths({})).toEqual(["notes/drill.md", "notes/window.md", "ops/backups.md"]);
    expect(await paths({ written_by: "agent" })).toEqual(["notes/drill.md", "notes/window.md"]);
    expect(await paths({ written_by: "user" })).toEqual(["ops/backups.md"]);
    // A document with no created_by reads exactly as it did before there was one.
    const [mine] = await recall({ written_by: "user" });
    expect(mine).not.toHaveProperty("created_by");
    expect((await recall({ written_by: "agent" }))[0]?.created_by).toBe("ragdown_remember");

    const text = (await t.call("ragdown_recall", { query: "pg_restore drill Fridays", top_k: 1 }))
      .text;
    expect(text).toMatch(/notes\/drill\.md:.*, written by an agent with ragdown_remember\)/);
    expect(
      (await t.call("ragdown_recall", { query: "pg_restore", written_by: "user" })).text,
    ).not.toContain("written by");
    const context = await t.call("ragdown_context", {
      prompt: "when is the pg_restore drill run?",
    });
    expect(context.text).toContain("written by an agent with ragdown_remember");

    expect((await t.list({ written_by: "agent" })).paths).toEqual([
      "notes/drill.md",
      "notes/window.md",
    ]);
    expect((await t.list({ written_by: "user" })).lines).toEqual([
      `ops/backups.md — Backups (changed ${today})`,
    ]);
    expect((await t.list({ session_id: "s1" })).lines).toEqual([
      `notes/drill.md — Restore drill (changed ${today}, written by an agent with ragdown_remember, session s1)`,
    ]);
    expect((await t.call("ragdown_list", { session_id: "nobody" })).text).toBe("No documents.");
  });

  it("lists a document's description, which is not searched", async () => {
    const t = await connect();
    await t.write("ops/dr.md", "---\ndescription: Zebra crossing plan\n---\n# DR\n\nFail over.");
    await t.rag.sync(false);

    expect((await t.list({ path_prefix: "ops" })).lines).toEqual([
      `ops/backups.md — Backups (changed ${today})`,
      `ops/dr.md — DR (changed ${today}): Zebra crossing plan`,
    ]);
    // Frontmatter is metadata: it is neither embedded nor in the text the keyword search reads.
    const { hits } = JSON.parse(
      (await t.call("ragdown_recall", { query: "zebra crossing", format: "json" })).text,
    );
    expect(JSON.stringify(hits)).not.toContain("Zebra");
  });

  it("lists the documents that link to a document, by wikilink, alias and relative link", async () => {
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

  it("says which document replaces a superseded one, when reading and listing", async () => {
    const t = await connect();
    await t.write("ops/backups-v2.md", "---\nsupersedes: backups.md\n---\n# Backups v2\n");
    await t.rag.sync(false);
    const read = await t.read("ops/backups.md");
    expect(read.header).toMatch(
      /^ops\/backups\.md:1-7 of 7 \(hash \w+, superseded by ops\/backups-v2\.md\)$/,
    );
    expect((await t.read("ops/backups-v2.md")).header).not.toContain("superseded");
    expect((await t.list()).lines).toContain(
      `ops/backups.md — Backups (changed ${today}, superseded by ops/backups-v2.md)`,
    );
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
