import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };
import { loadConfig } from "./config.ts";
import { Ragdown } from "./engine.ts";
import { assertAuthConfigured, createHttpServer } from "./http.ts";
import { applySettings, readServerSettings, SERVER_SETTINGS_FILE } from "./settings.ts";
import { eventually, tempSetup } from "./testing.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

/** A server in folders mode over one folder, `ops`, with MCP on. */
async function serve(env: Record<string, string>) {
  const t = await tempSetup(env, "folders");
  closers.push(t.cleanup);
  await t.write("ops/backups.md", "# Backups\n\n## Restore\n\nRun pg_restore twice on postgres.");
  await t.write("ops/.ragdown.json", JSON.stringify({ title: "Operations", mcp: true }));
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

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe("HTTP server", () => {
  it("refuses to start with no token and no SECURE_LOCAL_NET", async () => {
    const t = await tempSetup();
    closers.push(t.cleanup);
    expect(() => assertAuthConfigured(t.config)).toThrow(/RAGDOWN_TOKEN/);
  });

  it("tells clients it keeps an idle connection for 75 s, or for as long as it is told to", async () => {
    const t = await serve({ SECURE_LOCAL_NET: "true" });
    expect((await fetch(`${t.url}/api/status`)).headers.get("keep-alive")).toBe("timeout=75");
    const longer = await serve({ SECURE_LOCAL_NET: "true", HTTP_KEEP_ALIVE_TIMEOUT_MS: "120000" });
    expect((await fetch(`${longer.url}/api/status`)).headers.get("keep-alive")).toBe("timeout=120");
  });

  it("serves status openly and guards /mcp with the token", async () => {
    const t = await serve({ RAGDOWN_TOKEN: "secret" });
    const status = (await (await fetch(`${t.url}/api/status`)).json()) as {
      auth_required: boolean;
    };
    expect(status).toMatchObject({ name: "ragdown", ready: true, files: 1, chunks: 1 });
    // The released version, not a constant left behind in the source.
    expect(status).toMatchObject({ version: pkg.version });
    expect(status).toMatchObject({
      settings: {
        watch: false,
        text_limit: 2000,
        // The hash embedder has no measured scale, so there is no unrelated score to warn against.
        hook: { top_k: 4, min_score: 0.2, min_ratio: 0, max_chars: 6000, unrelated_score: null },
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
    expect((await post("/mcp/ops")).status).toBe(401);
    expect((await post("/mcp/ops", "wrong")).status).toBe(401);
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
      docs: [{ path: "ops/backups.md", folder: "ops", title: "Backups", chunks: 1, tags: [] }],
    });

    const doc = (await (await get("/api/doc?path=ops%2Fbackups.md")).json()) as { text: string };
    expect(doc).toMatchObject({ path: "ops/backups.md", total_lines: 5 });
    expect(doc.text).toContain("pg_restore");

    expect((await get("/api/doc?path=stray.txt")).status).toBe(404);
    expect((await get("/api/doc?path=..%2F..%2Fetc%2Fpasswd")).status).toBe(404);
    expect((await get("/api/doc")).status).toBe(400);
  });

  it("uploads a Markdown file and indexes it before answering", async () => {
    const t = await serve({ RAGDOWN_TOKEN: "secret" });
    const auth = { authorization: "Bearer secret" };
    const upload = (body: unknown, token = "secret") =>
      fetch(`${t.url}/api/doc`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
    const docs = async () =>
      (
        (await (await fetch(`${t.url}/api/docs`, { headers: auth })).json()) as {
          docs: { path: string }[];
        }
      ).docs.map((doc) => doc.path);

    expect((await upload({ path: "ops/kafka.md", text: "# Kafka" }, "wrong")).status).toBe(401);

    const created = await upload({ path: "ops/deep/kafka.md", text: "# Kafka\n\nSeven days." });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      path: "ops/deep/kafka.md",
      created: true,
      sync: { added: 1 },
    });
    expect(await docs()).toContain("ops/deep/kafka.md");
    expect(await readFile(join(t.docsDir, "ops/deep/kafka.md"), "utf8")).toBe(
      "# Kafka\n\nSeven days.",
    );

    const conflict = await upload({ path: "ops/deep/kafka.md", text: "# Other" });
    expect(conflict.status).toBe(409);
    expect(await readFile(join(t.docsDir, "ops/deep/kafka.md"), "utf8")).toContain("Seven");

    const replaced = await upload({
      path: "ops/deep/kafka.md",
      text: "# Kafka\n\nTwo weeks.",
      overwrite: true,
    });
    expect(replaced.status).toBe(200);
    expect(await replaced.json()).toMatchObject({ created: false, sync: { updated: 1 } });
    const doc = await fetch(`${t.url}/api/doc?path=ops%2Fdeep%2Fkafka.md`, { headers: auth });
    const opened = (await doc.json()) as { text: string; hash: string };
    expect(opened.text).toContain("Two weeks");

    // An edit: saved against the hash it was opened at, refused once the file moves on.
    const edited = await upload({
      path: "ops/deep/kafka.md",
      text: "# Kafka\n\nThree weeks.",
      base_hash: opened.hash,
    });
    expect(edited.status).toBe(200);
    const saved = (await edited.json()) as { hash: string };
    expect(saved.hash).not.toBe(opened.hash);
    const stale = await upload({ path: "ops/deep/kafka.md", text: "# x", base_hash: opened.hash });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "changed" });
    expect(await readFile(join(t.docsDir, "ops/deep/kafka.md"), "utf8")).toContain("Three");

    // Outside every folder, absolute, somewhere the indexer skips, or not Markdown.
    await symlink(t.root, join(t.docsDir, "out"));
    await symlink(t.root, join(t.docsDir, "ops", "out"));
    for (const path of [
      "../escape.md",
      "ops/../../escape.md",
      "/etc/escape.md",
      "out/escape.md",
      "ops/out/escape.md",
      "ops/.hidden/x.md",
      "ops/node_modules/x.md",
      "ops/notes.txt",
      "ops/script.js",
      "loose.md",
      "nofolder/x.md",
      "",
    ]) {
      expect((await upload({ path, text: "# x" })).status, path).toBe(400);
    }
    expect((await upload({ path: "ops/x.md" })).status).toBe(400);
    expect(await readFile(join(t.root, "escape.md"), "utf8").catch(() => "none")).toBe("none");

    const put = await fetch(`${t.url}/api/doc`, { method: "PUT", headers: auth });
    expect(put.status).toBe(405);
  });

  it("deletes a Markdown file and drops it from the index", async () => {
    const t = await serve({ RAGDOWN_TOKEN: "secret" });
    const auth = { authorization: "Bearer secret" };
    const remove = (path: string, token = "secret") =>
      fetch(`${t.url}/api/doc?path=${encodeURIComponent(path)}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      });

    expect((await remove("ops/backups.md", "wrong")).status).toBe(401);
    const removed = await remove("ops/backups.md");
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ path: "ops/backups.md", sync: { removed: 1 } });
    expect(await (await fetch(`${t.url}/api/docs`, { headers: auth })).json()).toEqual({
      docs: [],
    });

    expect((await remove("ops/backups.md")).status).toBe(404);
    expect((await remove("../../etc/passwd.md")).status).toBe(400);
    await t.write("keep.txt", "not markdown");
    expect((await remove("keep.txt")).status).toBe(400);
    const noPath = await fetch(`${t.url}/api/doc`, { method: "DELETE", headers: auth });
    expect(noPath.status).toBe(400);
  });

  it("refuses uploads and deletes when read-only", async () => {
    const t = await serve({ SECURE_LOCAL_NET: "true", RAGDOWN_READ_ONLY: "true" });
    const upload = await fetch(`${t.url}/api/doc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "ops/x.md", text: "# x" }),
    });
    expect(upload.status).toBe(403);
    const create = await fetch(`${t.url}/api/folders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "new" }),
    });
    expect(create.status).toBe(403);
    // A folder's settings are not notes: a read-only server can still turn MCP on and off.
    const toggle = await fetch(`${t.url}/api/folders/ops`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mcp: false }),
    });
    expect(toggle.status).toBe(200);
    const rename = await fetch(`${t.url}/api/folders/ops`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "operations" }),
    });
    expect(rename.status).toBe(403);
    const remove = await fetch(`${t.url}/api/doc?path=ops%2Fbackups.md`, { method: "DELETE" });
    expect(remove.status).toBe(403);
    await t.write("loose.md", "# Loose");
    const removeLoose = await fetch(`${t.url}/api/loose?name=loose.md`, { method: "DELETE" });
    expect(removeLoose.status).toBe(403);
    const settings = await fetch(`${t.url}/api/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ watch: false }),
    });
    expect(settings.status).toBe(403);
    expect(await readFile(join(t.docsDir, "loose.md"), "utf8")).toBe("# Loose");
    expect(await readFile(join(t.docsDir, "ops/backups.md"), "utf8")).toContain("pg_restore");
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
      new StreamableHTTPClientTransport(new URL(`${t.url}/mcp/ops`), {
        requestInit: { headers: { authorization: "Bearer secret" } },
      }),
    );
    closers.push(() => client.close());
    // Named after its folder, so a client holding several can tell them apart.
    expect(client.getServerVersion()?.name).toBe("ragdown-ops");
    expect(client.getInstructions()).toContain('"Operations"');
    const result = (await client.callTool({
      name: "ragdown_recall",
      arguments: { query: "pg_restore", format: "json" },
    })) as CallToolResult;
    const first = result.content[0];
    const hits = JSON.parse(first?.type === "text" ? first.text : "{}").hits;
    expect(hits[0]).toMatchObject({ path: "backups.md", heading: "Backups › Restore" });
  });

  it("serves each MCP-enabled folder at /mcp/<folder>, and nothing of a human-only one", async () => {
    const t = await serve({ SECURE_LOCAL_NET: "true" });
    await t.write("ops/db/pg.md", "# Postgres\n\nVacuum postgres nightly.");
    // No settings file: a new folder is human-only.
    await t.write("private/kafka.md", "# Kafka\n\nRetention on postgres is seven days.");
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
      return JSON.parse(first?.type === "text" ? first.text : "{}")
        .hits.map((hit: { path: string }) => hit.path)
        .sort();
    };
    expect(await recall("/mcp/ops")).toEqual(["backups.md", "db/pg.md"]);
    expect(await recall("/mcp/ops/db/")).toEqual(["pg.md"]);

    const post = (path: string) =>
      fetch(`${t.url}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
    const bare = await post("/mcp");
    expect(bare.status).toBe(404);
    expect(await bare.json()).toEqual({ error: "Pick a folder: /mcp/<folder>" });
    // A human-only folder answers exactly as a missing one does.
    const hidden = await post("/mcp/private");
    const missing = await post("/mcp/nope");
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toEqual(await missing.json());
    for (const path of ["/mcp/private/", "/mcp/ops/backups.md", "/mcp/%2E%2E", "/mcp/%E0"]) {
      expect((await post(path)).status, path).toBe(404);
    }

    const toggle = await fetch(`${t.url}/api/folders/private`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mcp: true }),
    });
    expect(toggle.status).toBe(200);
    expect(await recall("/mcp/private")).toEqual(["kafka.md"]);
  });

  it("lists, creates, renames and deletes folders, and never indexes loose files", async () => {
    const t = await serve({ SECURE_LOCAL_NET: "true" });
    await t.write("loose.md", "# Loose\n\nAt the top, in no folder.");
    await t.write("human/one.md", "# One");
    await t.rag.sync(false);
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${t.url}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };

    expect((await call("GET", "/api/folders")).body).toEqual({
      folders: [
        {
          name: "human",
          title: "human",
          mcp: false,
          hook: {},
          mcp_path: "/mcp/human",
          files: 1,
          chunks: 1,
        },
        {
          name: "ops",
          title: "Operations",
          mcp: true,
          hook: {},
          mcp_path: "/mcp/ops",
          files: 1,
          chunks: 1,
        },
      ],
      loose_files: ["loose.md"],
    });
    const docs = (await call("GET", "/api/docs")).body.docs as { path: string }[];
    expect(docs.map((doc) => doc.path)).not.toContain("loose.md");
    const humanDocs = (await call("GET", "/api/docs?folder=human")).body.docs as { path: string }[];
    expect(humanDocs.map((doc) => doc.path)).toEqual(["human/one.md"]);
    expect((await call("GET", "/api/docs?folder=nope")).status).toBe(404);

    const created = await call("POST", "/api/folders", { name: "Work notes", title: "Work" });
    expect(created).toEqual({
      status: 201,
      body: {
        folder: {
          name: "Work notes",
          title: "Work",
          mcp: false,
          hook: {},
          mcp_path: "/mcp/Work%20notes",
          files: 0,
          chunks: 0,
        },
      },
    });
    expect(JSON.parse(await readFile(join(t.docsDir, "Work notes/.ragdown.json"), "utf8"))).toEqual(
      { title: "Work", mcp: false },
    );
    expect((await call("POST", "/api/folders", { name: "ops" })).status).toBe(409);
    for (const name of [".hidden", "-dash", "a/b", "..", "", "node_modules"]) {
      expect((await call("POST", "/api/folders", { name })).status, name).toBe(400);
    }

    // Unknown keys in the settings file survive an edit.
    await writeFile(
      join(t.docsDir, "human/.ragdown.json"),
      JSON.stringify({ mcp: false, extra: 1 }),
    );
    const renamed = await call("PATCH", "/api/folders/human", {
      name: "people",
      title: "People",
      mcp: true,
    });
    expect(renamed.body).toMatchObject({
      folder: { name: "people", title: "People", mcp: true, files: 1 },
    });
    expect(JSON.parse(await readFile(join(t.docsDir, "people/.ragdown.json"), "utf8"))).toEqual({
      mcp: true,
      extra: 1,
      title: "People",
    });
    expect((await call("PATCH", "/api/folders/people", { name: "ops" })).status).toBe(409);
    expect((await call("PATCH", "/api/folders/nope", { mcp: true })).status).toBe(404);
    expect((await call("PATCH", "/api/folders/people", { mcp: "yes" })).status).toBe(400);

    // A folder's own hook defaults: set, kept beside the rest, and taken away with null.
    const tuned = await call("PATCH", "/api/folders/people", {
      hook: { top_k: 6, min_score: 0.5 },
    });
    expect(tuned.body).toMatchObject({ folder: { hook: { top_k: 6, min_score: 0.5 } } });
    const cleared = await call("PATCH", "/api/folders/people", { hook: { top_k: null } });
    expect(cleared.body).toMatchObject({ folder: { hook: { min_score: 0.5 } } });
    expect(JSON.parse(await readFile(join(t.docsDir, "people/.ragdown.json"), "utf8"))).toEqual({
      mcp: true,
      extra: 1,
      title: "People",
      hook: { min_score: 0.5 },
    });
    await call("PATCH", "/api/folders/people", { hook: { min_score: null } });
    expect(
      JSON.parse(await readFile(join(t.docsDir, "people/.ragdown.json"), "utf8")),
    ).not.toHaveProperty("hook");
    for (const hook of [{ top_k: 1.5 }, { min_ratio: 2 }, { max_chars: "many" }, 4]) {
      expect((await call("PATCH", "/api/folders/people", { hook })).status).toBe(400);
    }

    expect((await call("DELETE", "/api/folders/people")).status).toBe(400);
    expect((await call("DELETE", "/api/folders/people?confirm=People")).status).toBe(400);
    const deleted = await call("DELETE", "/api/folders/people?confirm=people");
    expect(deleted).toMatchObject({ status: 200, body: { name: "people", sync: { removed: 1 } } });
    expect((await call("DELETE", "/api/folders/people?confirm=people")).status).toBe(404);
    const names = ((await call("GET", "/api/folders")).body.folders as { name: string }[]).map(
      (folder) => folder.name,
    );
    expect(names).toEqual(["ops", "Work notes"]);
  });

  it("saves server settings, applies them at once, and gives one back to its variable", async () => {
    const t = await serve({ RAGDOWN_TOKEN: "s3cret", RAGDOWN_WATCH: "true" });
    const file = join(t.docsDir, SERVER_SETTINGS_FILE);
    const patch = (body: unknown, token = "s3cret") =>
      fetch(`${t.url}/api/settings`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const settings = async () =>
      ((await (await fetch(`${t.url}/api/status`)).json()) as { settings: Record<string, unknown> })
        .settings;

    expect((await patch({ watch: false }, "wrong")).status).toBe(401);
    for (const bad of [
      { watch: "no" },
      { text_limit: -1 },
      { hook: { top_k: 1.5 } },
      { hook: { min_ratio: 2 } },
      { hook: [] },
      { embedder: "" },
    ]) {
      expect((await patch(bad)).status).toBe(400);
    }
    expect((await fetch(`${t.url}/api/settings`, { headers: auth("s3cret") })).status).toBe(405);
    await expect(readFile(file, "utf8")).rejects.toThrow();

    const saved = await patch({
      watch: false,
      text_limit: 500,
      hook: { top_k: 2, min_score: 0.5 },
    });
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as { settings: unknown }).settings).toMatchObject({
      watch: false,
      text_limit: 500,
      hook: { top_k: 2, min_score: 0.5, min_ratio: 0, max_chars: 6000 },
      saved: { watch: false, text_limit: 500, hook: { top_k: 2, min_score: 0.5 } },
      // What the variables said is still there to go back to.
      env: { watch: true, text_limit: 2000, hook: { top_k: 4, min_score: 0.2 } },
    });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      watch: false,
      text_limit: 500,
      hook: { top_k: 2, min_score: 0.5 },
    });
    // In effect without a restart: the running config is what the tools read.
    expect(t.config.hook.topK).toBe(2);
    expect(t.config.textLimit).toBe(500);

    // A later change keeps what it does not name, and a null gives the value back.
    await patch({ hook: { top_k: null, max_chars: 100 }, watch: null });
    expect(await settings()).toMatchObject({
      watch: true,
      hook: { top_k: 4, min_score: 0.5, max_chars: 100 },
      saved: { text_limit: 500, hook: { min_score: 0.5, max_chars: 100 } },
    });
    // A start reads the file back over the same environment.
    const restarted = loadConfig(
      { RAGDOWN_DOCS_DIR: t.docsDir, RAGDOWN_EMBEDDER: "hash", RAGDOWN_HOOK_MIN_SCORE: "0.2" },
      "folders",
    );
    applySettings(restarted, await readServerSettings(t.docsDir));
    expect(restarted).toMatchObject({ textLimit: 500, hook: { minScore: 0.5, maxChars: 100 } });

    // Nothing left to save: the file goes rather than staying behind as `{}`.
    await patch({ text_limit: null, hook: { min_score: null, max_chars: null } });
    await expect(readFile(file, "utf8")).rejects.toThrow();
    expect(await settings()).toMatchObject({ text_limit: 2000, saved: {} });
    // The settings file is not a note and not a loose file.
    const folders = (await (
      await fetch(`${t.url}/api/folders`, { headers: auth("s3cret") })
    ).json()) as { loose_files: string[] };
    expect(folders.loose_files).toEqual([]);
  });

  it("changes the embedder in place and rebuilds the index with it", async () => {
    // An embedding endpoint with vectors of its own size, so the old index cannot be reused.
    const endpoint = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const { input } = JSON.parse(body) as { input: string[] };
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            data: input.map((text, index) => ({
              index,
              embedding: [
                text.includes("pg_restore") || text.includes("restore") ? 1 : 0.2,
                0.5,
                1,
              ],
            })),
          }),
        );
      });
    });
    await new Promise<void>((done) => endpoint.listen(0, "127.0.0.1", done));
    closers.push(() => new Promise((done) => endpoint.close(() => done())));
    const embeddingUrl = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}/v1`;
    const t = await serve({ RAGDOWN_TOKEN: "s3cret", RAGDOWN_EMBEDDING_URL: embeddingUrl });
    const patch = (body: unknown) =>
      fetch(`${t.url}/api/settings`, {
        method: "PATCH",
        headers: { ...auth("s3cret"), "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const status = async () =>
      (await (await fetch(`${t.url}/api/status`)).json()) as {
        embedder: string;
        chunks: number;
        settings: { embedder: string; saved: unknown };
      };

    // A name nothing can load changes nothing, on disk or in the running server.
    const unknown = await patch({ embedder: "no-such-model" });
    expect(unknown.status).toBe(400);
    expect(await status()).toMatchObject({ embedder: "hash-384", settings: { saved: {} } });

    expect((await patch({ embedder: "openai:fake" })).status).toBe(200);
    expect(await status()).toMatchObject({
      embedder: "openai:fake@3",
      settings: { embedder: "openai:fake", saved: { embedder: "openai:fake" } },
    });
    // The rebuild runs behind the answer; the note is found again once it is done.
    await eventually(async () => (await status()).chunks === 1);
    const search = await fetch(`${t.url}/api/search?folder=ops&q=restore`, {
      headers: auth("s3cret"),
    });
    expect(JSON.stringify(await search.json())).toContain("ops/backups.md");

    // Back to what the environment says, with the index rebuilt once more.
    expect((await patch({ embedder: null })).status).toBe(200);
    expect(await status()).toMatchObject({ embedder: "hash-384", settings: { saved: {} } });
    await eventually(async () => (await status()).chunks === 1);
  });

  it("deletes a loose file, and nothing else, through /api/loose", async () => {
    const t = await serve({ RAGDOWN_TOKEN: "secret" });
    await t.write("loose.md", "# Loose\n\nAt the top, in no folder.");
    await t.write("keep.txt", "not markdown");
    const remove = (name: string, token = "secret") =>
      fetch(`${t.url}/api/loose?name=${encodeURIComponent(name)}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      });
    const loose = async () =>
      (
        (await (
          await fetch(`${t.url}/api/folders`, { headers: { authorization: "Bearer secret" } })
        ).json()) as { loose_files: string[] }
      ).loose_files;

    expect(await loose()).toEqual(["loose.md"]);
    expect((await remove("loose.md", "wrong")).status).toBe(401);
    // Only a name the listing gives: not a note in a folder, a folder, a path out or another file.
    for (const name of ["ops/backups.md", "ops", "../loose.md", "keep.txt", "missing.md"]) {
      expect((await remove(name)).status).toBe(404);
    }
    expect(
      (
        await fetch(`${t.url}/api/loose`, {
          method: "DELETE",
          headers: { authorization: "Bearer secret" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${t.url}/api/loose?name=loose.md`, {
          headers: { authorization: "Bearer secret" },
        })
      ).status,
    ).toBe(405);

    const removed = await remove("loose.md");
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ name: "loose.md" });
    expect(await loose()).toEqual([]);
    expect((await remove("loose.md")).status).toBe(404);
    expect(await readFile(join(t.docsDir, "ops/backups.md"), "utf8")).toContain("pg_restore");
    expect(await readFile(join(t.docsDir, "keep.txt"), "utf8")).toBe("not markdown");
  });

  it("searches a folder, resolves wikilinks and serves attachments", async () => {
    const t = await serve({ SECURE_LOCAL_NET: "true" });
    await t.write(
      "ops/db/pg.md",
      "---\ntags: [db, infra/postgres]\naliases: [Elephant]\n---\n# Postgres\n\nVacuum postgres nightly. See [[backups#Restore]] and ![[diagram.png]].",
    );
    await t.write("ops/img/diagram.png", "PNGDATA");
    await t.write("ops/.obsidian/app.json", "{}");
    await t.write("other/pg.md", "# Postgres elsewhere");
    await t.rag.sync(false);
    const get = async (path: string) => fetch(`${t.url}${path}`);

    const search = (await (await get("/api/search?folder=ops&q=postgres")).json()) as {
      hits: { path: string; tags: string[] }[];
    };
    expect(search.hits.map((hit) => hit.path).sort()).toEqual(["ops/backups.md", "ops/db/pg.md"]);
    const tagged = (await (await get("/api/search?folder=ops&q=postgres&tag=infra")).json()) as {
      hits: { path: string; tags: string[] }[];
    };
    expect(tagged.hits).toEqual([
      expect.objectContaining({ path: "ops/db/pg.md", tags: ["db", "infra/postgres"] }),
    ]);
    expect((await get("/api/search?folder=ops")).status).toBe(400);
    expect((await get("/api/search?folder=nope&q=x")).status).toBe(404);

    const resolve = (link: string) =>
      get(`/api/resolve?from=ops%2Fdb%2Fpg.md&link=${encodeURIComponent(link)}`);
    expect(await (await resolve("backups#Restore")).json()).toEqual({
      path: "ops/backups.md",
      anchor: "Restore",
    });
    expect(await (await resolve("diagram.png")).json()).toEqual({ path: "ops/img/diagram.png" });
    expect(await (await resolve("Elephant")).json()).toEqual({ path: "ops/db/pg.md" });
    // Within the folder only: other/pg.md is never a candidate.
    expect(await (await resolve("pg")).json()).toEqual({ path: "ops/db/pg.md" });
    expect((await resolve("nothing")).status).toBe(404);

    const backlinks = await (await get("/api/backlinks?path=ops%2Fbackups.md")).json();
    expect(backlinks).toEqual({
      path: "ops/backups.md",
      backlinks: [
        {
          path: "ops/db/pg.md",
          title: "Postgres",
          lines: [{ line: 7, text: expect.stringContaining("[[backups#Restore]]") }],
        },
      ],
    });
    expect((await get("/api/backlinks?path=ops%2Fnope.md")).status).toBe(404);

    const move = (body: unknown) =>
      fetch(`${t.url}/api/move`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await move({ from: "ops/backups.md", to: "other/backups.md" })).status).toBe(400);
    const moved = await move({ from: "ops/backups.md", to: "ops/runbooks/backups-v2.md" });
    expect(await moved.json()).toMatchObject({
      from: "ops/backups.md",
      to: "ops/runbooks/backups-v2.md",
      updated: ["ops/db/pg.md"],
    });
    expect(await readFile(join(t.docsDir, "ops/db/pg.md"), "utf8")).toContain(
      "See [[backups-v2#Restore]]",
    );
    expect((await get("/api/move")).status).toBe(405);

    const file = await get("/api/file?path=ops%2Fimg%2Fdiagram.png");
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/png");
    expect(file.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await file.text()).toBe("PNGDATA");
    await symlink(join(t.root, "web", "index.html"), join(t.docsDir, "ops", "link.png"));
    for (const path of [
      "ops/.obsidian/app.json",
      "ops/link.png",
      "../web/index.html",
      "ops/../../web/index.html",
      "ops/missing.png",
      "loose.md",
    ]) {
      expect(
        (await get(`/api/file?path=${encodeURIComponent(path)}`)).status,
        path,
      ).toBeGreaterThanOrEqual(400);
    }
  });

  it("keeps ragdown_context's per-session memory across stateless HTTP requests", async () => {
    const t = await serve({ SECURE_LOCAL_NET: "true" });
    const contextFor = async () => {
      // A fresh client per call, as a hook runner would reconnect; the server keeps no MCP session.
      const client = new Client({ name: "hook", version: "0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${t.url}/mcp/ops`)));
      closers.push(() => client.close());
      const result = (await client.callTool({
        name: "ragdown_context",
        arguments: { prompt: "how do I restore postgres?", session_id: "min-agent:1" },
      })) as CallToolResult;
      const first = result.content[0];
      return first?.type === "text" ? first.text : "";
    };
    expect(await contextFor()).toContain("backups.md");
    expect(await contextFor()).toBe("");
  });
});
