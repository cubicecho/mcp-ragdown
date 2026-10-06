import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { type Config, loadConfig } from "../shared/config.ts";
import { createEmbedder, scoreScale } from "./embedder.ts";

const config = (embedder: string) => ({ embedder, modelsDir: "/tmp", threads: 1 }) as Config;

describe("the hook's minimum score", () => {
  const minScore = (env: Record<string, string>) =>
    loadConfig({ RAGDOWN_DOCS_DIR: tmpdir(), ...env }).hook.minScore;

  // Cosine is on each model's own scale: granite scores "tell me a joke" at 0.72 against notes
  // on city politics, which bge-small's 0.7 lets through and granite's own 0.8 does not.
  it("defaults to the embedder's own, and to the default model's for one nobody measured", () => {
    expect(minScore({})).toBe(0.8);
    expect(minScore({ RAGDOWN_EMBEDDER: "bge-small" })).toBe(0.7);
    expect(minScore({ RAGDOWN_EMBEDDER: "embeddinggemma" })).toBe(0.6);
    expect(minScore({ RAGDOWN_EMBEDDER: "openai:some-model" })).toBe(0.8);
    expect(minScore({ RAGDOWN_EMBEDDER: "bge-small", RAGDOWN_HOOK_MIN_SCORE: "0.65" })).toBe(0.65);
  });

  it("sits above what an unrelated prompt scores, for every measured model", () => {
    for (const name of ["granite-small", "bge-small", "embeddinggemma"]) {
      const scale = scoreScale(name);
      expect(scale?.minScore).toBeGreaterThan(scale?.unrelated ?? 1);
    }
    expect(scoreScale("hash")).toBeUndefined();
  });
});

describe("createEmbedder", () => {
  // The local models are not built here: downloading one would make the suite need a network.
  it("builds the hash embedder", async () => {
    const embedder = await createEmbedder(config("hash"));
    expect(embedder.name).toBe("hash-384");
  });

  /**
   * An endpoint that says nothing about how long it keeps a connection, as one behind a proxy
   * does, so the client's own idle timeout decides. `fetch` alone drops it after 4 s.
   */
  it("reuses its connection to an embedding endpoint after a pause", async () => {
    let connections = 0;
    const server = createServer({ keepAliveTimeout: 0 }, (req, res) => {
      req.resume();
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ index: 0, embedding: [3, 4] }] }));
    });
    server.on("connection", () => {
      connections += 1;
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    try {
      const embeddingUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
      const embedder = await createEmbedder({ ...config("openai:test"), embeddingUrl });
      expect(embedder.name).toBe("openai:test@2");
      await new Promise((done) => setTimeout(done, 4500));
      const [vector] = await embedder.embed(["restore"], "query");
      expect(Array.from(vector ?? [])).toEqual([0.6, 0.8].map(Math.fround));
      expect(connections).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
  }, 10_000);

  it("names the models it accepts when given one it does not have", async () => {
    await expect(createEmbedder(config("bge-large"))).rejects.toThrow(
      /granite-small, bge-small, embeddinggemma, hash or openai:<model>/,
    );
  });
});
