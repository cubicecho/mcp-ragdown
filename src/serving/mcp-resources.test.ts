import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult, ResourceLink } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { Root } from "../documents/root.ts";
import { openScope, Scope } from "../documents/scope.ts";
import { tempSetup } from "../shared/testing.ts";
import { Ragdown } from "./engine.ts";
import { createMcpServer } from "./mcp-tools.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
});

/**
 * A client on one endpoint over the folders `ops` (MCP on, with a `runbooks` subfolder) and
 * `private` (MCP off): the root, `ops` itself, or `ops/runbooks`.
 */
async function connect(
  endpoint: "root" | "ops" | "ops/runbooks",
  env: Record<string, string> = {},
) {
  const t = await tempSetup({ RAGDOWN_ROOT_MCP: "true", ...env }, "folders");
  closers.push(t.cleanup);
  await t.write("ops/.ragdown.json", JSON.stringify({ title: "Operations", mcp: true }));
  await t.write("ops/backups.md", "# Backups\n\nRun pg_restore twice.");
  await t.write("ops/runbooks/restore.md", "# Restore\n\nStop the app first.");
  await t.write("ops/stray.txt", "not a document");
  await t.write("private/diary.md", "# Diary\n\nNothing to see.");
  const rag = await Ragdown.start(t.config);
  closers.push(() => rag.close());
  await rag.sync(false);

  const target =
    endpoint === "root"
      ? new Root(rag)
      : Promise.resolve((await openScope(rag, endpoint)) as Scope);
  const server = createMcpServer(target, t.config, { name: "ops", title: "Operations" });
  const client = new Client({ name: "test", version: "0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  closers.push(() => client.close());

  /** A tool's whole answer: its text, and the link after it if there is one. */
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    const [first, ...rest] = result.content;
    expect(rest.length).toBeLessThanOrEqual(1);
    return {
      isError: result.isError === true,
      text: first?.type === "text" ? first.text : "",
      link: rest[0]?.type === "resource_link" ? (rest[0] as ResourceLink) : undefined,
    };
  };
  const read = async (uri: string) => {
    const [content] = (await client.readResource({ uri })).contents;
    return content && "text" in content ? content.text : undefined;
  };
  return { ...t, rag, client, call, read };
}

/** The hash a read names, for a write that replaces the document. */
async function hashOf(t: Awaited<ReturnType<typeof connect>>, args: Record<string, unknown>) {
  const { text } = await t.call("ragdown_read_doc", args);
  return /hash ([0-9a-f]+)/.exec(text)?.[1] ?? "";
}

/** Whether a link was made by a write between `before` and now. */
function writtenSince(link: ResourceLink | undefined, before: number): boolean {
  const at = Date.parse(link?.annotations?.lastModified ?? "");
  return at >= before && at <= Date.now();
}

describe("documents as resources", () => {
  it("offers the document template and lists nothing", async () => {
    const t = await connect("ops");
    expect(t.client.getServerCapabilities()?.resources).toBeDefined();
    const { resourceTemplates } = await t.client.listResourceTemplates();
    expect(resourceTemplates).toEqual([
      expect.objectContaining({
        uriTemplate: "ragdown://{folder}/{+path}",
        mimeType: "text/markdown",
      }),
    ]);
    expect((await t.client.listResources()).resources).toEqual([]);
  });

  it("links each write tool's document after its unchanged text", async () => {
    const t = await connect("ops");
    const before = Date.now();

    const created = await t.call("ragdown_write", { path: "notes/new.md", text: "# New\n\nHi." });
    expect(created.text).toMatch(/^created notes\/new\.md \(hash [0-9a-f]+\)$/);
    expect(created.link).toEqual({
      type: "resource_link",
      uri: "ragdown://ops/notes/new.md",
      name: "notes/new.md",
      title: "New",
      mimeType: "text/markdown",
      annotations: { audience: ["user", "assistant"], lastModified: expect.any(String) },
    });
    expect(writtenSince(created.link, before)).toBe(true);

    const remembered = await t.call("ragdown_remember", {
      title: "Weekly summary",
      content: "All quiet.",
      name: "weekly summary",
    });
    expect(remembered.text).toBe("saved notes/weekly summary.md");
    expect(remembered.link).toMatchObject({
      uri: "ragdown://ops/notes/weekly%20summary.md",
      name: "notes/weekly summary.md",
      title: "Weekly summary",
    });
    expect(writtenSince(remembered.link, before)).toBe(true);

    const edited = await t.call("ragdown_edit", {
      path: "backups.md",
      edits: [{ old_text: "twice", new_text: "once" }],
    });
    expect(edited.text).toMatch(/^edited backups\.md \(replaced 1, hash [0-9a-f]+\)$/);
    expect(edited.link).toMatchObject({ uri: "ragdown://ops/backups.md", title: "Backups" });
    expect(writtenSince(edited.link, before)).toBe(true);

    const appended = await t.call("ragdown_write", {
      path: "backups.md",
      text: "Check the logs.",
      append: true,
      base_hash: await hashOf(t, { path: "backups.md" }),
    });
    expect(appended.link?.uri).toBe("ragdown://ops/backups.md");

    const moved = await t.call("ragdown_move", { from: "backups.md", to: "db/backups.md" });
    expect(moved.text).toBe("moved backups.md to db/backups.md");
    expect(moved.link).toMatchObject({ uri: "ragdown://ops/db/backups.md", name: "db/backups.md" });
    expect(writtenSince(moved.link, before)).toBe(true);
  });

  it("links no document for a delete or a moved subfolder", async () => {
    const t = await connect("ops");
    const movedFolder = await t.call("ragdown_move", { from: "runbooks", to: "guides" });
    expect(movedFolder).toMatchObject({ isError: false, link: undefined });
    const deleted = await t.call("ragdown_delete", { path: "backups.md" });
    expect(deleted).toEqual({ isError: false, text: "deleted backups.md", link: undefined });
  });

  it("adds the web address only when RAGDOWN_PUBLIC_URL is set", async () => {
    const without = await connect("ops");
    const plain = await without.call("ragdown_write", { path: "a.md", text: "# A" });
    expect(plain.link).toBeDefined();
    expect(plain.link?._meta).toBeUndefined();

    const t = await connect("ops", { RAGDOWN_PUBLIC_URL: "http://ragdown.lan:8080/" });
    const linked = await t.call("ragdown_write", { path: "notes/a b.md", text: "# A" });
    expect(linked.link?._meta).toEqual({
      "com.cubicecho/webUrl": "http://ragdown.lan:8080/f/ops?doc=notes%2Fa%20b.md",
    });
  });

  it("reads a link's URI back as the document's markdown", async () => {
    const t = await connect("ops");
    const { link } = await t.call("ragdown_write", { path: "notes/x.md", text: "# X\n\nBody." });
    const result = await t.client.readResource({ uri: link?.uri ?? "" });
    expect(result.contents).toEqual([
      {
        uri: "ragdown://ops/notes/x.md",
        mimeType: "text/markdown",
        // As written, so with the created_by the write stamped on it.
        text: await readFile(join(t.docsDir, "ops/notes/x.md"), "utf8"),
      },
    ]);
    expect(result.contents[0]).toHaveProperty("text", expect.stringContaining("# X\n\nBody."));
  });

  it("names the folder and the folder's path on a subfolder's endpoint", async () => {
    const t = await connect("ops/runbooks");
    const { text, link } = await t.call("ragdown_write", { path: "drill.md", text: "# Drill" });
    expect(text).toMatch(/^created drill\.md /);
    expect(link).toMatchObject({
      uri: "ragdown://ops/runbooks/drill.md",
      name: "runbooks/drill.md",
    });
    expect(await t.read("ragdown://ops/runbooks/restore.md")).toBe(
      "# Restore\n\nStop the app first.",
    );
    // In the folder, but above this endpoint.
    await expect(t.read("ragdown://ops/backups.md")).rejects.toThrow(
      /not a document this endpoint/,
    );
  });

  it("links the folder an agent named at the root, and reads only folders with MCP on", async () => {
    const t = await connect("root");
    const { link } = await t.call("ragdown_write", { folder: "ops", path: "r.md", text: "# R" });
    expect(link?.uri).toBe("ragdown://ops/r.md");
    expect(await t.read("ragdown://ops/r.md")).toContain("# R");
    expect(await t.read("ragdown://ops/runbooks/restore.md")).toContain("Stop the app first.");
    const made = await t.call("ragdown_create_folder", { name: "research" });
    expect(made).toEqual({ isError: false, text: "created folder research", link: undefined });
    await expect(t.read("ragdown://private/diary.md")).rejects.toThrow(/no such folder/);
  });

  it("names the docs dir as the folder on stdio, where it is the one folder", async () => {
    const t = await tempSetup();
    closers.push(t.cleanup);
    const rag = await Ragdown.start(t.config);
    closers.push(() => rag.close());
    const server = createMcpServer(Promise.resolve(new Scope(rag)), t.config);
    const client = new Client({ name: "test", version: "0" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    closers.push(() => client.close());
    const result = (await client.callTool({
      name: "ragdown_write",
      arguments: { path: "a.md", text: "# A" },
    })) as CallToolResult;
    expect(result.content[1]).toMatchObject({ type: "resource_link", uri: "ragdown://docs/a.md" });
    const [content] = (await client.readResource({ uri: "ragdown://docs/a.md" })).contents;
    expect(content).toHaveProperty("text", expect.stringContaining("# A"));
  });

  it("refuses a read outside the folder, of another folder, or of a file the index does not hold", async () => {
    const folder = await connect("ops");
    for (const uri of [
      "ragdown://ops/..%2Fprivate%2Fdiary.md",
      "ragdown://ops/runbooks/..%2F..%2Fprivate/diary.md",
      "ragdown://ops/%2Fetc%2Fpasswd",
      "ragdown://private/diary.md",
      "ragdown://ops/stray.txt",
      "ragdown://ops/missing.md",
    ]) {
      await expect(folder.read(uri), uri).rejects.toThrow(/cannot read/);
    }
    const root = await connect("root");
    await expect(root.read("ragdown://ops/..%2Fprivate%2Fdiary.md")).rejects.toThrow(/outside/);
  });
});
