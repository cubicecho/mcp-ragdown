import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import type { Config } from "./config.ts";
import { createEmbedder } from "./embedder.ts";

const config = (embedder: string) => ({ embedder, modelsDir: "/tmp", threads: 1 }) as Config;

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
