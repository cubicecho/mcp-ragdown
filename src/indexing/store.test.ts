import type { Table } from "@lancedb/lancedb";
import { afterEach, describe, expect, it } from "vitest";
import { chunkMarkdown, embeddingText } from "../documents/chunk.ts";
import { tempSetup } from "../shared/testing.ts";
import { type Embedder, HashEmbedder } from "./embedder.ts";
import { callsByAlias, Store } from "./store.ts";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

const dot = (a: Float32Array, b: Float32Array) => a.reduce((sum, x, i) => sum + x * (b[i] ?? 0), 0);

describe("Store", () => {
  it("reports the cosine of the query and the chunk as the similarity", async () => {
    const t = await tempSetup();
    cleanup = t.cleanup;
    const embedder: Embedder = new HashEmbedder();
    const store = await Store.open(t.config.dataDir, embedder, true);

    const markdown = [
      "# Cache",
      "",
      "Redis eviction policy is allkeys-lru.",
      "",
      "## Failover",
      "",
      "Sentinel promotes the replica after 30 seconds.",
      "",
      "## Backups",
      "",
      "A nightly dump lands in the archive bucket.",
    ].join("\n");
    const chunks = chunkMarkdown(markdown, "cache.md");
    const vectors = await embedder.embed(chunks.map(embeddingText), "document");
    await store.apply(
      [{ path: "cache.md", hash: "h", mtimeMs: 0, size: 0, chunks, vectors, supersedes: [] }],
      [],
    );

    const query = "redis eviction policy";
    const hits = await store.search(query, 5);
    const [queryVector] = await embedder.embed([query], "query");
    expect(hits.length).toBeGreaterThan(1);
    // The dense side reads `_distance` rather than the stored vector and the lexical side the vector
    // itself, so the two must agree no matter which one reached a chunk first.
    for (const hit of hits) {
      const i = chunks.findIndex((chunk) => chunk.heading === hit.heading);
      expect(hit.similarity).toBeCloseTo(
        dot(queryVector as Float32Array, vectors[i] as Float32Array),
        5,
      );
    }
    expect(hits.some((hit) => hit.sources.includes("dense"))).toBe(true);
    expect(hits.some((hit) => hit.sources.includes("lexical"))).toBe(true);
  });

  it("ranks the chunk that holds a name first when the query names it", async () => {
    const t = await tempSetup();
    cleanup = t.cleanup;
    const embedder: Embedder = new HashEmbedder();
    const store = await Store.open(t.config.dataDir, embedder, true);
    const markdown = [
      "# Scheduler",
      "",
      "## Batching",
      "",
      "The scheduler batches jobs; batch size and timeouts are tuned per environment.",
      "",
      "## Limits",
      "",
      "Set sched_max_batch to 500 in staging.",
      "",
      "## Timeouts",
      "",
      "Jobs in a batch time out after the scheduler's batch timeout.",
    ].join("\n");
    const chunks = chunkMarkdown(markdown, "scheduler.md");
    const vectors = await embedder.embed(chunks.map(embeddingText), "document");
    await store.apply(
      [{ path: "scheduler.md", hash: "h", mtimeMs: 0, size: 0, chunks, vectors, supersedes: [] }],
      [],
    );

    const hits = await store.search("what is `sched_max_batch` in the scheduler batch?", 5);
    expect(hits[0]?.text).toContain("sched_max_batch");
    // Fused by score, not rank: 0–1, where reciprocal rank never reaches 1/60.
    expect(hits[0]?.score).toBeGreaterThan(0.5);
    expect(hits[0]?.score).toBeLessThanOrEqual(1);
  });

  it("lifts the sections of a document the query calls by an alias", async () => {
    const t = await tempSetup();
    cleanup = t.cleanup;
    const embedder: Embedder = new HashEmbedder();
    const store = await Store.open(t.config.dataDir, embedder, true);
    const update = async (path: string, title: string, aliases: string[], deploys: string) => {
      const markdown = `# ${title}\n\nA batch job runner.\n\n## Deploys\n\n${deploys}`;
      const chunks = chunkMarkdown(markdown, path);
      const vectors = await embedder.embed(chunks.map(embeddingText), "document");
      return { path, hash: path, mtimeMs: 0, size: 0, chunks, vectors, supersedes: [], aliases };
    };
    await store.apply(
      [
        await update(
          "osprey.md",
          "Osprey",
          [],
          "Production deploys: who approves production deploys.",
        ),
        await update("kestrel.md", "Kestrel", ["Vandor"], "The on-call lead approves deploys."),
      ],
      [],
    );

    const hits = await store.search("who approves production deploys of vandor?", 5);
    // Osprey's section matches the words better; the alias is what puts Kestrel's first.
    const deploys = hits.filter((hit) => hit.heading.endsWith("Deploys"));
    expect(deploys.map((hit) => hit.path)).toEqual(["kestrel.md", "osprey.md"]);
    expect(deploys[0]?.aliases).toEqual(["Vandor"]);
    // Inside a longer word, it is not the alias.
    expect(callsByAlias("who approves vandorx deploys?", ["Vandor"])).toBe(false);
  });

  it("caps the sections of one document, refilling from the next-best", async () => {
    const t = await tempSetup();
    cleanup = t.cleanup;
    const embedder: Embedder = new HashEmbedder();
    const store = await Store.open(t.config.dataDir, embedder, true);
    const sections = ["Primary", "Replica", "Failover", "Backups"]
      .map((name) => `## ${name}\n\nPostgres replication lag on the ${name.toLowerCase()}.`)
      .join("\n\n");
    const update = async (path: string, markdown: string) => {
      const chunks = chunkMarkdown(markdown, path);
      const vectors = await embedder.embed(chunks.map(embeddingText), "document");
      return { path, hash: path, mtimeMs: 0, size: 0, chunks, vectors, supersedes: [] };
    };
    await store.apply(
      [
        await update("long.md", `# Database\n\n${sections}`),
        await update("short.md", "# Alerts\n\nPage on postgres lag."),
      ],
      [],
    );

    const query = "postgres replication lag";
    const paths = async (perDocument?: number) =>
      (await store.search(query, 3, undefined, undefined, undefined, { perDocument })).map(
        (hit) => hit.path,
      );
    expect(await paths()).toEqual(["long.md", "long.md", "long.md"]);
    expect(await paths(2)).toEqual(["long.md", "long.md", "short.md"]);
    // Too few documents to fill the result: the capped sections come back after the rest.
    expect(
      (await store.search(query, 6, undefined, undefined, undefined, { perDocument: 1 })).map(
        (hit) => hit.path,
      ),
    ).toEqual(["long.md", "short.md", "long.md", "long.md", "long.md"]);
  });

  describe("following links", () => {
    const setup = async (
      documents: Record<string, string>,
      tags: Record<string, string[]> = {},
    ) => {
      const t = await tempSetup();
      cleanup = t.cleanup;
      const embedder: Embedder = new HashEmbedder();
      const store = await Store.open(t.config.dataDir, embedder, true);
      const updates = await Promise.all(
        Object.entries(documents).map(async ([path, markdown]) => {
          const chunks = chunkMarkdown(markdown, path);
          const vectors = await embedder.embed(chunks.map(embeddingText), "document");
          const tagged = tags[path] ?? [];
          return {
            path,
            hash: path,
            mtimeMs: 0,
            size: 0,
            chunks,
            vectors,
            supersedes: [],
            tags: tagged,
          };
        }),
      );
      await store.apply(updates, []);
      return { store, embedder };
    };
    const incident = [
      "# Gateway outage",
      "",
      "The gateway outage on Friday was recovered with [[Restore procedure]].",
      "",
      "## Timeline",
      "",
      "Gateway outage paged at noon, gateway outage resolved by one.",
    ].join("\n");
    const procedure = [
      "# Restore procedure",
      "",
      "## Steps",
      "",
      "Run the snapshot restore, then replay the journal.",
      "",
      "## Notes",
      "",
      "Ask the database team before replaying.",
      "",
      "## History",
      "",
      "Written after the 2023 migration.",
    ].join("\n");
    const query = "how was the gateway outage on friday recovered";

    it("places the closest sections of a linked document right after the hit that links it", async () => {
      const { store, embedder } = await setup({
        "incident.md": incident,
        "Restore procedure.md": procedure,
      });

      const plain = await store.search(query, 3);
      expect(plain[0]?.heading).toBe("Gateway outage");
      expect(plain.map((hit) => hit.sources)).not.toContainEqual(expect.arrayContaining(["link"]));

      const hits = await store.search(query, 4, undefined, undefined, undefined, {
        followLinks: 1,
      });
      expect(hits[0]?.heading).toBe("Gateway outage");
      const linked = hits.slice(1, 3);
      expect(linked.map((hit) => hit.path)).toEqual([
        "Restore procedure.md",
        "Restore procedure.md",
      ]);
      expect(linked.every((hit) => hit.sources.includes("link"))).toBe(true);
      // Its own cosine, not the hit's that brought it in, since the hook gates on it.
      const [vector] = await embedder.embed([query], "query");
      const [chunkVector] = await embedder.embed(
        [`Restore procedure › ${linked[0]?.heading.split(" › ").pop()}\n\n${linked[0]?.text}`],
        "document",
      );
      expect(linked[0]?.similarity).toBeLessThan(hits[0]?.similarity ?? 0);
      expect(linked[0]?.similarity).toBeCloseTo(
        dot(vector as Float32Array, chunkVector as Float32Array),
        1,
      );
      expect(linked[0]?.score).toBe(hits[0]?.score);
    });

    it("follows only the links in the hit's own section", async () => {
      const { store } = await setup({
        "incident.md": incident
          .replace(" with [[Restore procedure]]", "")
          .concat("\n\n## See also\n\n[[Restore procedure]]"),
        "Restore procedure.md": procedure,
      });
      const hits = await store.search(query, 3, undefined, undefined, undefined, {
        followLinks: 1,
      });
      expect(hits.some((hit) => hit.sources.includes("link"))).toBe(false);
    });

    it("brings in nothing the search's filters leave out", async () => {
      const { store } = await setup(
        { "incident.md": incident, "Restore procedure.md": procedure },
        { "incident.md": ["ops"] },
      );
      const hits = await store.search(query, 4, undefined, "ops", undefined, { followLinks: 1 });
      expect(hits.map((hit) => hit.path)).not.toContain("Restore procedure.md");
    });

    it("resolves links within the hit's folder when paths start with one", async () => {
      const { store } = await setup({
        "work/incident.md": incident,
        "home/Restore procedure.md": procedure,
      });
      const linkedPaths = async (folders: boolean) =>
        (await store.search(query, 4, undefined, undefined, undefined, { followLinks: 1, folders }))
          .filter((hit) => hit.sources.includes("link"))
          .map((hit) => hit.path);
      // One index of the whole docs dir: the name matches wherever the document is.
      expect(await linkedPaths(false)).toContain("home/Restore procedure.md");
      // Each folder a vault of its own: `home` is out of `work`'s reach.
      expect(await linkedPaths(true)).toEqual([]);
    });
  });

  it("builds no vector index for a folder of documents", async () => {
    const t = await tempSetup();
    cleanup = t.cleanup;
    const embedder: Embedder = new HashEmbedder();
    const store = await Store.open(t.config.dataDir, embedder, true);
    const chunks = chunkMarkdown("# Alpha\n\nPostgres replication lag.", "a.md");
    const vectors = await embedder.embed(chunks.map(embeddingText), "document");
    await store.apply(
      [{ path: "a.md", hash: "h", mtimeMs: 0, size: 0, chunks, vectors, supersedes: [] }],
      [],
    );
    await store.compact();

    // biome-ignore lint: the table is private, and what it was indexed with is the point
    const table = (store as any).table as Table;
    const indices = await table.listIndices();
    expect(indices.flatMap((index) => index.columns)).toEqual(["search_text"]);
    expect(await store.search("postgres replication", 3)).toHaveLength(1);
  });
});
