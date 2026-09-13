import { createHash } from "node:crypto";
import { availableParallelism } from "node:os";
import type { Config } from "./config.ts";

export interface Embedder {
  /** Recorded in the index; a different name on the next start rebuilds it. */
  readonly name: string;
  readonly dim: number;
  /**
   * Unit-length vectors, one per text. `kind` matters to asymmetric models, which embed a short
   * question differently from the passage that answers it.
   */
  embed(texts: string[], kind: "query" | "document"): Promise<Float32Array[]>;
}

/**
 * Build the embedder named by `RAGDOWN_EMBEDDER`. Loading is eager: a missing model or an
 * unreachable endpoint fails here, at startup, rather than on the first search.
 */
export async function createEmbedder(config: Config): Promise<Embedder> {
  const spec = config.embedder;
  if (spec === "bge-small") return BgeEmbedder.load(config.modelsDir, config.threads);
  if (spec === "hash") return new HashEmbedder();
  if (spec.startsWith("openai:")) {
    return OpenAiEmbedder.probe(config.embeddingUrl, spec.slice(7), config.embeddingApiKey);
  }
  throw new Error(`RAGDOWN_EMBEDDER must be bge-small, hash or openai:<model>, got "${spec}"`);
}

/**
 * BAAI/bge-small-en-v1.5, int8-quantised, on ONNX Runtime via transformers.js.
 *
 * The forward pass is all of the cost and runs in ORT's native kernels (tokenizing is about 1 ms a
 * chunk), so a Rust port would call the same C++ and index no faster. What does help is below:
 * fewer threads than cores, and batches of similar length.
 */
class BgeEmbedder implements Embedder {
  readonly name = "bge-small-en-v1.5-q8";
  readonly dim = 384;
  /** bge's documented retrieval instruction; passages are embedded without it. */
  static readonly QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";
  static readonly BATCH = 16;

  private readonly extract: FeatureExtractor;

  private constructor(extract: FeatureExtractor) {
    this.extract = extract;
  }

  /** @param threads ORT intra-op threads; 0 picks half the logical cores. */
  static async load(modelsDir: string, threads: number): Promise<BgeEmbedder> {
    const { pipeline, env } = await import("@huggingface/transformers");
    env.cacheDir = modelsDir;
    const extract = await pipeline("feature-extraction", "Xenova/bge-small-en-v1.5", {
      dtype: "q8",
      session_options: {
        // Measured on an 8-thread i9-13900H: 4 threads embed faster than 8. Past the physical
        // performance cores, extra threads land on hyperthreads and efficiency cores and every
        // matmul waits for the slowest of them.
        intraOpNumThreads: threads || Math.max(1, Math.floor(availableParallelism() / 2)),
        interOpNumThreads: 1,
      },
    });
    return new BgeEmbedder(extract as unknown as FeatureExtractor);
  }

  async embed(texts: string[], kind: "query" | "document"): Promise<Float32Array[]> {
    const inputs = kind === "query" ? texts.map((t) => BgeEmbedder.QUERY_PREFIX + t) : texts;
    // A batch is padded to its longest member and attention grows with the square of length, so
    // one 400-token chunk in a batch of 40-token ones makes the whole batch cost 400 tokens each.
    // Batching in length order keeps the padding near zero.
    const lengths = inputs.map((text) => text.length);
    const order = lengths.map((_, i) => i).sort((a, b) => (lengths[a] ?? 0) - (lengths[b] ?? 0));
    const out = new Array<Float32Array>(inputs.length);
    for (let i = 0; i < order.length; i += BgeEmbedder.BATCH) {
      const indices = order.slice(i, i + BgeEmbedder.BATCH);
      const tensor = await this.extract(
        indices.map((index) => inputs[index] ?? ""),
        { pooling: "cls", normalize: true },
      );
      indices.forEach((index, row) => {
        out[index] = tensor.data.slice(row * this.dim, (row + 1) * this.dim);
      });
    }
    return out;
  }
}

// transformers.js's pipeline types are a union over every task; this is the one shape used here.
type FeatureExtractor = (
  texts: string[],
  options: { pooling: "cls"; normalize: boolean },
) => Promise<{ data: Float32Array }>;

/**
 * Any OpenAI-compatible `/embeddings` endpoint: OpenAI itself, Ollama, llama.cpp, vLLM, LM Studio.
 * The dimension is learned from one probe call rather than configured, so it cannot be wrong.
 */
class OpenAiEmbedder implements Embedder {
  readonly name: string;
  readonly dim: number;
  private readonly url: string;
  private readonly model: string;
  private readonly apiKey: string | undefined;

  private constructor(url: string, model: string, apiKey: string | undefined, dim: number) {
    this.url = url;
    this.model = model;
    this.apiKey = apiKey;
    this.dim = dim;
    this.name = `openai:${model}@${dim}`;
  }

  static async probe(url: string, model: string, apiKey?: string): Promise<OpenAiEmbedder> {
    const [vector] = await OpenAiEmbedder.request(url, model, apiKey, ["probe"]);
    if (!vector) throw new Error(`embedding endpoint ${url} returned no vector for the probe`);
    return new OpenAiEmbedder(url, model, apiKey, vector.length);
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += 64) {
      out.push(
        ...(await OpenAiEmbedder.request(
          this.url,
          this.model,
          this.apiKey,
          texts.slice(i, i + 64),
        )),
      );
    }
    return out;
  }

  private static async request(
    url: string,
    model: string,
    apiKey: string | undefined,
    input: string[],
  ): Promise<Float32Array[]> {
    const response = await fetch(`${url.replace(/\/+$/, "")}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ model, input }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      throw new Error(
        `embedding endpoint ${url} answered ${response.status}: ${await response.text()}`,
      );
    }
    const body = (await response.json()) as { data: { index: number; embedding: number[] }[] };
    return body.data
      .sort((a, b) => a.index - b.index)
      .map((item) => normalize(Float32Array.from(item.embedding)));
  }
}

/**
 * Feature hashing of lowercase word tokens. No model, no network, deterministic: for tests and for
 * trying the server out offline. Its "similarity" is word overlap, not meaning.
 */
export class HashEmbedder implements Embedder {
  readonly name = "hash-384";
  readonly dim = 384;

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => {
      const vector = new Float32Array(this.dim);
      for (const token of text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []) {
        const digest = createHash("sha1").update(token).digest();
        const bucket = digest.readUInt32LE(0) % this.dim;
        vector[bucket] = (vector[bucket] ?? 0) + ((digest[4] ?? 0) & 1 ? 1 : -1);
      }
      return normalize(vector);
    });
  }
}

function normalize(vector: Float32Array): Float32Array {
  let norm = 0;
  for (const v of vector) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < vector.length; i++) vector[i] = (vector[i] ?? 0) / norm;
  return vector;
}
