/**
 * Every number the server is tuned with, in one place, each with the reason it has the value it
 * has. Imports nothing, so any module can read it. The ones an environment variable or a saved
 * setting can change are only where that setting starts.
 */
export const defaults = Object.freeze({
  /**
   * 1500 characters is roughly 350–450 tokens of prose: inside the window of every embedder here —
   * 512 tokens for the smallest of them — with room for the heading line, and still one idea's
   * worth of text rather than a whole page.
   */
  maxChunkChars: 1500,

  /** An editor save is a burst of events (temp file, rename, chmod); one sync per burst. */
  watchDebounceMs: 750,
  /** Chunks per embed-and-write round: a crash loses at most this much, and progress is visible. */
  syncBatchChunks: 256,
  /** When the OS will not watch (inotify limits, network mounts), rescan on this interval. */
  pollFallbackMs: 60_000,

  /** How often a reader checks whether the primary has gone and it should take over. */
  takeoverIntervalMs: 30_000,
  /** A full rebuild of a large folder takes minutes; the timeout is for a primary that hangs. */
  syncRequestTimeoutMs: 30 * 60_000,

  /** Reciprocal-rank-fusion constant; 60 is the original RRF paper's and rarely worth tuning. */
  rrfK: 60,
  /**
   * Chunks below which no vector index is built. A folder of documents is nowhere near it, and
   * under it the flat scan wins anyway: measured at 10k chunks the index is twice as fast, at 1k
   * it is noise.
   */
  vectorIndexMinRows: 10_000,
  /** How long an old table version outlives a compaction, for a reader mid-query on it. */
  compactGraceMs: 60_000,

  /** Texts in one forward pass of a local model. */
  localEmbedBatch: 16,
  /**
   * How long an idle connection to the embedding endpoint is kept, where `fetch` keeps it 4 s. A
   * hook embeds one query a turn and turns are further apart than that, so each one opened a new
   * TLS connection first: about 340 ms against api.openai.com where a kept one took 85.
   */
  embedKeepAliveMs: 30_000,
  /** How long one request to the embedding endpoint may take. */
  embedRequestTimeoutMs: 60_000,

  /** An MCP message is a few kilobytes; anything near this is not one. */
  maxBodyBytes: 1024 * 1024,
  /**
   * An upload's JSON body. A hand-written document is kilobytes and a long one well under a
   * megabyte; JSON escaping can nearly double Markdown full of quotes and backslashes. The request
   * waits while every chunk is embedded, so a file much past this would hold it for minutes.
   */
  maxUploadBytes: 4 * 1024 * 1024,
  /** The most hits one search may ask for, over MCP or `/api/search`. */
  maxTopK: 50,

  /** Sessions whose returned chunks are remembered; past this the oldest is forgotten. */
  maxSessions: 200,
  /** A prompt shorter than this (a "yes", a "go on") has nothing to retrieve on. */
  minPromptChars: 12,

  /** `RAGDOWN_TEXT_LIMIT`. */
  textLimit: 2000,
  /** `RAGDOWN_HOOK_TOP_K`. */
  hookTopK: 4,
  /**
   * `RAGDOWN_HOOK_MIN_RATIO`. Measured on the benchmark corpus: 0.96 matched an ungated hook's
   * recall exactly while injecting a third fewer chunks, and 0.95 sits on the flat part of that
   * curve.
   */
  hookMinRatio: 0.95,
  /** `RAGDOWN_HOOK_MAX_CHARS`. */
  hookMaxChars: 6000,
  /** The floor for an embedder nobody measured: the default model's, which is a guess. */
  unmeasuredMinScore: 0.8,

  /** `PORT`. */
  port: 3000,
  /**
   * `HTTP_KEEP_ALIVE_TIMEOUT_MS`. Node's 5 s is shorter than the gap between two tool calls, and
   * shorter than the 60 s nginx and ALB hold their side, which is how a proxy reuses a connection
   * being closed.
   */
  httpKeepAliveTimeoutMs: 75_000,
});
