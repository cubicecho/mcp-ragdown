import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "./config.ts";
import type { Ragdown } from "./engine.ts";
import { Refusal } from "./refusal.ts";

/** An MCP message is a few kilobytes; anything near this is not one. */
export const MAX_BODY_BYTES = 1024 * 1024;
/**
 * An upload's JSON body. A hand-written document is kilobytes and a long one well under a megabyte;
 * JSON escaping can nearly double Markdown full of quotes and backslashes, and the request waits
 * while every chunk of the file is embedded, so a file much past this is not a document and would
 * hold the response for minutes on the CPU model.
 */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

/** One authorized `/api` request, as each resource's handler is given it. */
export interface ApiRequest {
  rag: Ragdown;
  config: Config;
  /** The URL's path, undecoded. */
  path: string;
  method: string;
  params: URLSearchParams;
  req: IncomingMessage;
  res: ServerResponse;
}

/**
 * A query parameter that must be there.
 *
 * @throws with `status: 400` when it is missing or empty.
 */
export function required({ params }: ApiRequest, name: string): string {
  const value = params.get(name);
  if (!value) throw new Refusal(400, `${name} is required`);
  return value;
}

/**
 * @throws with `status: 405` unless the request's method is one of `methods`.
 */
export function allow({ method }: ApiRequest, ...methods: string[]): void {
  if (!methods.includes(method)) {
    throw new Refusal(405, "Method not allowed");
  }
}

/**
 * @throws with `status: 403` under `RAGDOWN_READ_ONLY`.
 */
export function assertWritable(config: Config): void {
  if (config.readOnly) throw new Refusal(403, "The server is read-only (RAGDOWN_READ_ONLY)");
}

export async function readJson(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Refusal(413, "Body too large");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Refusal(400, "Body is not valid JSON");
  }
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}
