import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "../shared/config.ts";
import { defaults } from "../shared/defaults.ts";
import { isRecord } from "../shared/json.ts";
import { Refusal } from "../shared/refusal.ts";
import type { Ragdown } from "./engine.ts";

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
  if (!value) {
    throw new Refusal(400, `${name} is required`);
  }
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
 * For a write to the documents or the folders. A folder's settings are not documents and skip
 * this: otherwise a read-only server could never turn MCP on.
 *
 * @throws with `status: 403` under `RAGDOWN_READ_ONLY`.
 */
export function assertWritable(config: Config): void {
  if (config.readOnly) {
    throw new Refusal(403, "The server is read-only (RAGDOWN_READ_ONLY)");
  }
}

/**
 * A request's JSON body, whatever it holds; an empty body reads as `{}`.
 *
 * @throws with `status: 413` past `limit` bytes and `400` for a body that is not JSON.
 */
export async function readJson(
  req: IncomingMessage,
  limit = defaults.maxBodyBytes,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) {
      throw new Refusal(413, "Body too large");
    }
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Refusal(400, "Body is not valid JSON");
  }
}

/**
 * A request's JSON body where a route takes an object. Anything else — an array, a string, `null`
 * — reads as an object with no keys, so the route answers as it does for a missing field.
 */
export async function readJsonObject(
  req: IncomingMessage,
  limit: number = defaults.maxBodyBytes,
): Promise<Record<string, unknown>> {
  const body = await readJson(req, limit);
  return isRecord(body) ? body : {};
}

/** Answer with a JSON body. */
export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}
