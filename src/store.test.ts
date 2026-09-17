import type { Table } from "@lancedb/lancedb";
import { afterEach, describe, expect, it } from "vitest";
import { chunkMarkdown, embeddingText } from "./chunk.ts";
import { type Embedder, HashEmbedder } from "./embedder.ts";
import { Store } from "./store.ts";
import { tempSetup } from "./testing.ts";

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

    const markdown = "# Cache\n\nRedis eviction policy is allkeys-lru.";
    const chunks = chunkMarkdown(markdown, "cache.md");
    const vectors = await embedder.embed(chunks.map(embeddingText), "document");
    await store.apply(
      [{ path: "cache.md", hash: "h", mtimeMs: 0, size: 0, chunks, vectors, supersedes: [] }],
      [],
    );

    const query = "redis eviction policy";
    const [hit] = await store.search(query, 5);
    const [queryVector] = await embedder.embed([query], "query");
    // The dense side reads `_distance` instead of the stored vector, so the two must still agree.
    expect(hit?.similarity).toBeCloseTo(
      dot(queryVector as Float32Array, vectors[0] as Float32Array),
      5,
    );
    expect(hit?.sources).toContain("dense");
  });

  it("builds no vector index for a folder of notes", async () => {
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
