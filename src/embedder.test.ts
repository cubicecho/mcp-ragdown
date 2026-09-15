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

  it("names the models it accepts when given one it does not have", async () => {
    await expect(createEmbedder(config("bge-large"))).rejects.toThrow(
      /granite-small, bge-small, embeddinggemma, hash or openai:<model>/,
    );
  });
});
