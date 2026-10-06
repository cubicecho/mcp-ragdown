import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";
import { Ragdown } from "./engine.ts";
import { openScope, Scope } from "./scope.ts";
import { applySettings } from "./settings.ts";
import { tempSetup } from "./testing.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
});

async function setup() {
  const t = await tempSetup();
  closers.push(t.cleanup);
  const restore = "# Backups\n\n## Restore\n\nRun pg_restore twice on postgres.";
  await t.write("projects/alpha/backups.md", restore);
  await t.write("projects/alpha/ops/deploy.md", "# Deploy\n\nShip postgres migrations first.");
  await t.write("projects/alpha-old/backups.md", restore);
  await t.write("projects/beta/backups.md", restore);
  await t.write("backups.md", restore);
  const rag = await Ragdown.start(t.config);
  closers.push(() => rag.close());
  await rag.sync(false);
  return { ...t, rag };
}

describe("Scope", () => {
  it("searches only its folder, with paths relative to it", async () => {
    const { rag } = await setup();
    const alpha = await openScope(rag, "projects/alpha");
    const hits = (await alpha?.recall("restore postgres", 10)) ?? [];
    // Not projects/alpha-old: a scope is a folder, not a string prefix.
    expect(hits.map((hit) => hit.path).sort()).toEqual(["backups.md", "ops/deploy.md"]);
    expect((await alpha?.recall("postgres", 10, "./ops/"))?.map((hit) => hit.path)).toEqual([
      "ops/deploy.md",
    ]);
    await expect(alpha?.recall("postgres", 10, "../beta")).rejects.toThrow(/outside/);

    const root = new Scope(rag);
    expect((await root.recall("restore", 10, "projects/alpha")).map((h) => h.path).sort()).toEqual([
      "projects/alpha/backups.md",
      "projects/alpha/ops/deploy.md",
    ]);
  });

  it("reads, remembers and counts inside its folder only", async () => {
    const t = await setup();
    const beta = await openScope(t.rag, "projects/beta/");
    if (!beta) {
      throw new Error("no scope");
    }
    expect(beta.dir).toBe("projects/beta");

    expect((await beta.readDocument("backups.md")).path).toBe("backups.md");
    await expect(beta.readDocument("../alpha/backups.md")).rejects.toThrow(/outside/);

    const note = await beta.remember("Kafka", "Retention is seven days.", [], "kafka");
    expect(note.path).toBe("kafka.md");
    expect(await readFile(join(t.docsDir, "projects/beta/kafka.md"), "utf8")).toContain("seven");
    // At the root, notes still go under RAGDOWN_NOTES_DIR.
    expect((await new Scope(t.rag).remember("Root", "A root note.", [], "root")).path).toBe(
      "notes/root.md",
    );

    const stats = await beta.stats(true);
    expect(stats).toMatchObject({ scope: "projects/beta", files: 2, chunks: 2 });
    expect(stats.file_list?.map((file) => file.path)).toEqual(["backups.md", "kafka.md"]);
    expect(stats.docs_dir).toBe(join(t.docsDir, "projects/beta"));
  });

  it("writes and deletes docs inside its folder only", async () => {
    const t = await setup();
    const beta = await openScope(t.rag, "projects/beta");
    if (!beta) {
      throw new Error("no scope");
    }

    const written = await beta.writeDocument("./sub/kafka.md", "# Kafka\n\nSeven days.");
    expect(written).toMatchObject({ path: "sub/kafka.md", created: true, sync: { added: 1 } });
    expect(await t.rag.files()).toHaveProperty("size", 6);
    expect(await readFile(join(t.docsDir, "projects/beta/sub/kafka.md"), "utf8")).toContain(
      "Seven",
    );
    await expect(beta.writeDocument("sub/kafka.md", "# Other")).rejects.toMatchObject({
      status: 409,
    });
    await expect(beta.writeDocument("sub", "# Other", true)).rejects.toMatchObject({ status: 400 });
    await expect(beta.writeDocument("../alpha/x.md", "# x")).rejects.toMatchObject({ status: 400 });
    await expect(beta.writeDocument("backups.md/x.md", "# x")).rejects.toMatchObject({
      status: 400,
    });

    await symlink(join(t.docsDir, "projects/alpha"), join(t.docsDir, "projects/beta/link"));
    await expect(beta.writeDocument("link/x.md", "# x")).rejects.toMatchObject({ status: 400 });
    await expect(beta.deleteDocument("link/backups.md")).rejects.toMatchObject({ status: 400 });

    expect(await beta.deleteDocument("sub/kafka.md")).toMatchObject({ sync: { removed: 1 } });
    await expect(beta.deleteDocument("sub/kafka.md")).rejects.toMatchObject({ status: 404 });
  });

  it("saves an edit only over the version it was made to", async () => {
    const t = await setup();
    const beta = await openScope(t.rag, "projects/beta");
    if (!beta) {
      throw new Error("no scope");
    }
    const full = join(t.docsDir, "projects/beta/backups.md");
    await writeFile(full, "# Backups\r\n\r\nNightly.\r\n");
    await t.rag.sync(false);

    const opened = await beta.readIndexedDocument("backups.md");
    expect(opened.text).toBe("# Backups\n\nNightly.\n");
    const saved = await beta.writeDocument(
      "backups.md",
      "# Backups\n\nHourly.\n",
      false,
      opened.hash,
    );
    expect(saved).toMatchObject({ created: false, sync: { updated: 1 } });
    // Line endings follow the file, not the browser.
    expect(await readFile(full, "utf8")).toBe("# Backups\r\n\r\nHourly.\r\n");
    expect((await beta.readIndexedDocument("backups.md")).hash).toBe(saved.hash);

    await expect(beta.writeDocument("backups.md", "# x", false, opened.hash)).rejects.toMatchObject(
      {
        status: 409,
        code: "changed",
      },
    );
    await beta.deleteDocument("backups.md");
    await expect(beta.writeDocument("backups.md", "# x", false, saved.hash)).rejects.toMatchObject({
      status: 409,
      code: "changed",
    });
  });

  it("keeps hook context memory per scope", async () => {
    const { rag } = await setup();
    const prompt = "how do I restore postgres?";
    const alpha = await openScope(rag, "projects/alpha");
    const beta = await openScope(rag, "projects/beta");
    const first = await alpha?.context(prompt, "s1");
    expect(first).toContain(`source="${alpha?.root}"`);
    expect(first).toContain("backups.md:");
    expect(first?.split("\n").slice(1).join("\n")).not.toContain("projects/");
    expect(await beta?.context(prompt, "s1")).toContain("backups.md:");
  });

  it("gates hook context on each hit's share of the best similarity", async () => {
    const t = await setup();
    const alpha = await openScope(t.rag, "projects/alpha");
    if (!alpha) {
      throw new Error("no scope");
    }
    const prompt = "how do I restore postgres?";

    // The gate is a ratio, so the cut is derived from the similarities this embedder actually
    // gives rather than hard-coded: the second band's share of the best is the only interesting
    // point on the curve, and either side of it must fall on a different number of chunks.
    const ranked = (await alpha.recall(prompt, 8))
      .filter((hit) => hit.similarity >= t.config.hook.minScore)
      .sort((a, b) => b.similarity - a.similarity);
    const bands = [...new Set(ranked.map((hit) => hit.similarity))];
    expect(bands.length).toBeGreaterThan(1);
    const cut = (bands[1] as number) / (bands[0] as number);

    const count = (block: string | undefined) => block?.match(/\.md:/g)?.length ?? 0;
    expect(count(await alpha.context(prompt, undefined, { minRatio: 0 }))).toBe(ranked.length);
    expect(count(await alpha.context(prompt, undefined, { minRatio: cut }))).toBe(ranked.length);
    expect(count(await alpha.context(prompt, undefined, { minRatio: cut + 1e-6 }))).toBe(
      ranked.filter((hit) => hit.similarity === bands[0]).length,
    );
    // Even the strictest ratio keeps the best hit: the gate trims a result, it never empties one.
    expect(count(await alpha.context(prompt, undefined, { minRatio: 1 }))).toBeGreaterThan(0);
  });

  it("takes hook defaults from the folder's settings, under the call's own arguments", async () => {
    const t = await tempSetup({}, "folders");
    closers.push(t.cleanup);
    await t.write(
      "work/backups.md",
      "# Backups\n\n## Restore\n\nRun pg_restore twice on postgres.",
    );
    const rag = await Ragdown.start(t.config);
    closers.push(() => rag.close());
    await rag.sync(false);
    const work = new Scope(rag, "work");
    const prompt = "how do I restore postgres?";
    expect(await work.context(prompt)).toBeDefined();

    // No similarity reaches 2, so the folder's own floor silences the hook; read per call.
    await t.write("work/.ragdown.json", JSON.stringify({ hook: { min_score: 2 } }));
    expect(await work.context(prompt)).toBeUndefined();
    expect(await work.context(prompt, undefined, { minScore: 0 })).toBeDefined();

    // An invalid override is skipped, and the environment's default applies again.
    await t.write("work/.ragdown.json", JSON.stringify({ hook: { min_score: "high" } }));
    expect(await work.context(prompt)).toBeDefined();
  });

  it("puts a saved server setting over the environment's and under the folder's", async () => {
    const t = await tempSetup({}, "folders");
    closers.push(t.cleanup);
    await t.write(
      "work/backups.md",
      "# Backups\n\n## Restore\n\nRun pg_restore twice on postgres.",
    );
    const rag = await Ragdown.start(t.config);
    closers.push(() => rag.close());
    await rag.sync(false);
    const work = new Scope(rag, "work");
    const prompt = "how do I restore postgres?";
    expect(await work.context(prompt)).toBeDefined();

    // No similarity reaches 2: the saved floor wins over the environment's 0.2.
    applySettings(t.config, { hook: { min_score: 2 } });
    expect(await work.context(prompt)).toBeUndefined();

    await t.write("work/.ragdown.json", JSON.stringify({ hook: { min_score: 0 } }));
    expect(await work.context(prompt)).toBeDefined();
    await t.write("work/.ragdown.json", JSON.stringify({ hook: { min_score: 3 } }));
    expect(await work.context(prompt, undefined, { minScore: 0 })).toBeDefined();

    // Taken away again, the environment's applies.
    await t.write("work/.ragdown.json", "{}");
    applySettings(t.config, {});
    expect(await work.context(prompt)).toBeDefined();
  });

  it("opens only folders the indexer would walk", async () => {
    const t = await setup();
    await mkdir(join(t.docsDir, ".hidden"));
    await symlink(join(t.docsDir, "projects/alpha"), join(t.docsDir, "linked"));
    expect((await openScope(t.rag, ""))?.dir).toBe("");
    const refused = ["missing", "backups.md", ".hidden", "linked", "projects/..", "../docs"];
    // One rule for a name, wherever a path comes in: a backslash and a NUL are refused alike.
    for (const dir of [...refused, "projects\\alpha", "projects/al\0pha"]) {
      expect(await openScope(t.rag, dir), dir).toBeUndefined();
    }
    const env = { RAGDOWN_DOCS_DIR: t.docsDir };
    for (const notesDir of [".hidden", "a/node_modules", "no\0tes"]) {
      expect(() => loadConfig({ ...env, RAGDOWN_NOTES_DIR: notesDir }), notesDir).toThrow(/skips/);
    }
    expect(loadConfig({ ...env, RAGDOWN_NOTES_DIR: "." }).notesDir).toBe("");
  });
});

describe("superseding a note", () => {
  it("hides the replaced note from search, keeps it on disk, and records provenance", async () => {
    const t = await setup();
    const root = new Scope(t.rag);
    await t.write("notes/embedder.md", "# Embedder\n\nThe embedder is bge-small.");
    await t.rag.sync(false);
    expect((await root.recall("which embedder", 10)).map((h) => h.path)).toContain(
      "notes/embedder.md",
    );

    const note = await root.remember(
      "Embedder",
      "The embedder is granite-small.",
      [],
      "embedder-v2",
      { supersedes: ["notes/embedder.md"], sessionId: "session-1" },
    );
    expect(note.supersedes).toEqual(["notes/embedder.md"]);

    const written = await readFile(join(t.docsDir, "notes/embedder-v2.md"), "utf8");
    // A sibling, so the path is relative to the note's own folder.
    expect(written).toContain('supersedes: ["embedder.md"]');
    expect(written).toContain("created_by: ragdown_remember");
    expect(written).toContain('session: "session-1"');

    const paths = (await root.recall("which embedder", 10)).map((hit) => hit.path);
    expect(paths).toContain("notes/embedder-v2.md");
    expect(paths).not.toContain("notes/embedder.md");
    // Superseded is not deleted: the file is still there and still readable.
    expect((await root.readDocument("notes/embedder.md")).text).toContain("bge-small");
  });

  it("refuses a supersedes path that names no note in the folder", async () => {
    const t = await setup();
    const root = new Scope(t.rag);
    await expect(
      root.remember("X", "body", [], "x", { supersedes: ["notes/missing.md"] }),
    ).rejects.toThrow(/names no note/);
    await expect(
      root.remember("X", "body", [], "x", { supersedes: ["../outside.md"] }),
    ).rejects.toThrow(/outside/);
  });

  it("follows wikilinks and tags within the folder, and remembers into the folder's notes", async () => {
    const t = await tempSetup({}, "folders");
    closers.push(t.cleanup);
    await t.write(
      "work/ops/pg.md",
      "---\ntags: [infra/db]\naliases: [Elephant]\n---\n# Postgres\n\n## Vacuum\n\nNightly on postgres.\n\n## Restore\n\nTwice on postgres.",
    );
    await t.write("work/kafka.md", "# Kafka\n\nNot postgres, but kafka. #streams");
    await t.write("home/pg.md", "# Postgres at home");
    const rag = await Ragdown.start(t.config);
    closers.push(() => rag.close());
    await rag.sync(false);
    const work = (await openScope(rag, "work")) as Scope;

    expect(work.folder).toBe("work");
    const section = await work.readDocument("pg#Vacuum");
    expect(section).toMatchObject({ path: "ops/pg.md", resolved_from: "pg#Vacuum" });
    expect(section.text).toBe("## Vacuum\n\nNightly on postgres.\n");
    expect((await work.readDocument("Elephant")).path).toBe("ops/pg.md");
    await expect(work.readDocument("nothing")).rejects.toThrow(/no such note/);

    // A subfolder endpoint cannot follow a link above itself.
    const ops = (await openScope(rag, "work/ops")) as Scope;
    expect((await ops.readDocument("pg")).path).toBe("pg.md");
    await expect(ops.readDocument("kafka")).rejects.toThrow(/no such note/);

    const tagged = await work.recall("postgres", 10, undefined, "infra");
    expect(new Set(tagged.map((h) => h.path))).toEqual(new Set(["ops/pg.md"]));
    expect((await work.recall("postgres", 10, undefined, "streams")).map((h) => h.path)).toEqual([
      "kafka.md",
    ]);
    expect(await work.recall("postgres", 10, undefined, "infr")).toEqual([]);

    const note = await work.remember("Decision", "Use postgres.", [], "decision");
    expect(note.path).toBe("notes/decision.md");
    expect(await readFile(join(t.docsDir, "work/notes/decision.md"), "utf8")).toContain(
      "Use postgres.",
    );
    expect((await ops.remember("Ops", "In place.", [], "ops-note")).path).toBe("ops-note.md");
  });
});

describe("moving a note", () => {
  async function folder() {
    const t = await tempSetup({}, "folders");
    closers.push(t.cleanup);
    await t.write("work/ops/pg.md", "# Postgres\n\nSee [[kafka]] and [runbook](../run/book.md).");
    await t.write("work/kafka.md", "# Kafka");
    await t.write("work/run/book.md", "# Book");
    await t.write(
      "work/index.md",
      [
        "# Index",
        "",
        "[[ops/pg#Vacuum|vacuum]], [[pg]], ![[pg.md]] and [pg](ops/pg.md).",
        "`[[pg]]` stays, [[missing]] too.",
      ].join("\n"),
    );
    await t.write("work/other/pg.md", "# Another pg");
    await t.write("home/link.md", "[[pg]]");
    const rag = await Ragdown.start(t.config);
    closers.push(() => rag.close());
    await rag.sync(false);
    const read = (path: string) => readFile(join(t.docsDir, path), "utf8");
    return { ...t, rag, read, work: (await openScope(rag, "work")) as Scope };
  }

  it("rewrites the links to it, and its own links the move would break", async () => {
    const t = await folder();
    const moved = await t.work.move("ops/pg.md", "db/postgres.md");
    expect(moved).toMatchObject({ from: "ops/pg.md", to: "db/postgres.md", updated: ["index.md"] });
    expect(await t.read("work/index.md")).toBe(
      [
        "# Index",
        "",
        "[[postgres#Vacuum|vacuum]], [[postgres]], ![[postgres.md]] and [pg](db/postgres.md).",
        "`[[pg]]` stays, [[missing]] too.",
      ].join("\n"),
    );
    expect(await t.read("work/db/postgres.md")).toBe(
      "# Postgres\n\nSee [[kafka]] and [runbook](../run/book.md).",
    );
    // Another folder's links never resolved to it.
    expect(await t.read("home/link.md")).toBe("[[pg]]");
    expect((await t.work.readDocument("postgres")).path).toBe("db/postgres.md");
  });

  it("keeps as much of the path as the new name needs to stay unambiguous", async () => {
    const t = await folder();
    await t.work.move("ops/pg.md", "db/deep/book.md");
    expect(await t.read("work/index.md")).toContain(
      "[[deep/book#Vacuum|vacuum]], [[deep/book]], ![[deep/book.md]] and [pg](db/deep/book.md).",
    );
    // Its own relative link moved with it, so it is recomputed.
    expect(await t.read("work/db/deep/book.md")).toBe(
      "# Postgres\n\nSee [[kafka]] and [runbook](../../run/book.md).",
    );
  });

  it("moves a subfolder with its attachments, fixing links into, out of and inside it", async () => {
    const t = await folder();
    await t.write("work/ops/pg.png", "png");
    await t.write("work/ops/tuning.md", "# Tuning\n\n![[pg.png]], [pg](pg.md) and [[book]].");
    await t.write("work/gallery.md", "![chart](ops/pg.png)");
    await t.rag.sync(false);

    const moved = await t.work.move("ops", "db/main");
    expect(moved).toMatchObject({ from: "ops", to: "db/main" });
    expect(moved.updated.sort()).toEqual(["db/main/pg.md", "gallery.md", "index.md"]);
    expect(await t.read("work/index.md")).toContain(
      "[[main/pg#Vacuum|vacuum]], [[main/pg]], ![[main/pg.md]] and [pg](db/main/pg.md).",
    );
    expect(await t.read("work/gallery.md")).toBe("![chart](db/main/pg.png)");
    expect(await t.read("work/db/main/pg.md")).toBe(
      "# Postgres\n\nSee [[kafka]] and [runbook](../../run/book.md).",
    );
    // Links between two files that moved together still hold as written.
    expect(await t.read("work/db/main/tuning.md")).toBe(
      "# Tuning\n\n![[pg.png]], [pg](pg.md) and [[book]].",
    );
    expect((await t.work.listDocuments({ pathPrefix: "ops" })).total).toBe(0);
    expect((await t.work.listDocuments({ pathPrefix: "db/main" })).total).toBe(2);

    await expect(t.work.move("db", "db/main/db")).rejects.toMatchObject({ status: 400 });
    await expect(t.work.move("db", "run")).rejects.toMatchObject({ status: 409 });
  });

  it("refuses a taken path, a missing note and a move onto itself", async () => {
    const t = await folder();
    await expect(t.work.move("ops/pg.md", "kafka.md")).rejects.toMatchObject({ status: 409 });
    await expect(t.work.move("nope.md", "x.md")).rejects.toMatchObject({ status: 404 });
    await expect(t.work.move("ops/pg.md", "ops/pg.md")).rejects.toMatchObject({ status: 400 });
    await expect(t.work.move("ops/pg.md", "../home/pg.md")).rejects.toMatchObject({
      status: 400,
    });
    expect(await t.read("work/ops/pg.md")).toContain("# Postgres");
  });
});
