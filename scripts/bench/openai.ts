/**
 * The slice of an OpenAI-compatible `/chat/completions` response these scripts read. Every field is
 * optional: `timings` is llama.cpp's, and a server that does not send it still answers questions.
 */
export interface ChatResponse {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  timings?: { prompt_ms?: number; cache_n?: number };
}
