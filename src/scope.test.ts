import { mkdir, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Ragdown } from "./engine.ts";
import { openScope, Scope } from "./scope.ts";
import { tempSetup } from "./testing.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
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
    if (!beta) throw new Error("no scope");
    expect(beta.dir).toBe("projects/beta");

    expect((await beta.readDoc("backups.md")).path).toBe("backups.md");
    await expect(beta.readDoc("../alpha/backups.md")).rejects.toThrow(/outside/);

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
    if (!alpha) throw new Error("no scope");
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

  it("opens only folders the indexer would walk", async () => {
    const t = await setup();
    await mkdir(join(t.docsDir, ".hidden"));
    await symlink(join(t.docsDir, "projects/alpha"), join(t.docsDir, "linked"));
    expect((await openScope(t.rag, ""))?.dir).toBe("");
    for (const dir of ["missing", "backups.md", ".hidden", "linked", "projects/..", "../docs"]) {
      expect(await openScope(t.rag, dir), dir).toBeUndefined();
    }
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
    expect((await root.readDoc("notes/embedder.md")).text).toContain("bge-small");
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
});
