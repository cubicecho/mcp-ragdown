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
