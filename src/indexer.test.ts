import { rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HashEmbedder } from "./embedder.ts";
import { Indexer } from "./indexer.ts";
import { Store } from "./store.ts";
import { eventually, tempSetup } from "./testing.ts";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function setup() {
  const t = await tempSetup();
  cleanup = t.cleanup;
  const embedder = new HashEmbedder();
  const store = await Store.open(t.config.dataDir, embedder, true);
  const indexer = new Indexer(t.docsDir, store, embedder);
  return { ...t, embedder, store, indexer };
}

describe("Indexer", () => {
  it("adds, updates and removes files incrementally", async () => {
    const t = await setup();
    await t.write("a.md", "# Alpha\n\nPostgres replication lag.");
    await t.write("sub/b.md", "# Beta\n\nRedis eviction policy.");
    await t.write(".git/c.md", "hidden");
    await t.write("node_modules/pkg/d.md", "vendored");

    expect(await t.indexer.sync()).toMatchObject({ added: 2, updated: 0, removed: 0, chunks: 2 });
    expect([...(await t.store.files()).keys()].sort()).toEqual(["a.md", "sub/b.md"]);

    expect(await t.indexer.sync()).toMatchObject({
      added: 0,
      updated: 0,
      removed: 0,
      unchanged: 2,
    });

    // A touched but unchanged file is read and hashed, not re-embedded.
    const later = new Date(Date.now() + 5000);
    await utimes(join(t.docsDir, "a.md"), later, later);
    expect(await t.indexer.sync()).toMatchObject({ updated: 0, unchanged: 2 });

    await t.write("a.md", "# Alpha\n\nPostgres replication lag.\n\n## More\n\nVacuum settings.");
    await rm(join(t.docsDir, "sub/b.md"));
    expect(await t.indexer.sync()).toMatchObject({ added: 0, updated: 1, removed: 1, chunks: 2 });
    expect(await t.store.count()).toBe(2);
  });

  it("finds chunks by keyword and by vector, and filters by path prefix", async () => {
    const t = await setup();
    await t.write("ops/db.md", "# Database\n\nPostgres replication lag is monitored.");
    await t.write("ops/cache.md", "# Cache\n\nRedis eviction policy is allkeys-lru.");
    await t.write("dev/style.md", "# Style\n\nUse double quotes. Postgres names are snake_case.");
    await t.indexer.sync();

    const hits = await t.store.search("redis eviction", 3);
    expect(hits[0]).toMatchObject({ path: "ops/cache.md", heading: "Cache", lineStart: 3 });
    expect(hits[0]?.sources).toEqual(["dense", "lexical"]);
    expect(hits[0]?.similarity).toBeGreaterThan(0.3);

    const scoped = await t.store.search("postgres", 5, "dev/");
    expect(scoped.map((h) => h.path)).toEqual(["dev/style.md"]);
    expect(await t.store.search("postgres", 5, "it's/")).toEqual([]);
  });

  it("shares one follow-up sync between callers that arrive mid-sync", async () => {
    const t = await setup();
    await t.write("a.md", "one");
    const first = t.indexer.sync();
    const second = t.indexer.sync();
    const third = t.indexer.sync();
    expect(second).toBe(third);
    expect((await first).added).toBe(1);
    expect((await second).unchanged).toBe(1);
  });

  it("picks up changes through the watcher", async () => {
    const t = await setup();
    await t.indexer.sync();
    t.indexer.watch();
    try {
      await t.write("new.md", "# New\n\nKubernetes ingress notes.");
      await eventually(async () => (await t.store.files()).has("new.md"));
    } finally {
      t.indexer.close();
    }
  });

  it("rebuilds the index when the embedder changes", async () => {
    const t = await setup();
    await t.write("a.md", "text");
    await t.indexer.sync();
    const other = {
      name: "other",
      dim: 8,
      embed: async (texts: string[]) => texts.map(() => new Float32Array(8)),
    };

    await expect(Store.open(t.config.dataDir, other, false)).rejects.toThrow(/needs a rebuild/);
    const reopened = await Store.open(t.config.dataDir, other, true);
    expect(reopened.rebuiltBecause).toMatch(/embedder changed from hash-384 to other/);
    expect(await reopened.count()).toBe(0);
  });
});
