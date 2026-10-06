import { readFile, stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isInside } from "../documents/document-paths.ts";
import { json } from "./http-io.ts";

/** Where `npm run build` puts the web UI. Absent in a checkout that never built it. */
export const WEB_DIR = fileURLToPath(new URL("../../web/dist", import.meta.url));

/** What the built UI's files are served as, and where `/api/file`'s own list starts. */
export const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

/**
 * A file from the built UI, or its `index.html` for any path that is not one, so a reload on a
 * client-side route still lands in the app. Hashed assets are cached for good; the page never is.
 */
export async function serveWeb(webDir: string, path: string, res: ServerResponse): Promise<void> {
  const root = resolve(webDir);
  let file = join(root, "index.html");
  try {
    file = resolve(root, `.${decodeURIComponent(path)}`);
  } catch {
    // A malformed escape is not a file; the app answers it.
  }
  if (!isInside(root, file) || !(await stat(file).catch(() => undefined))?.isFile()) {
    file = join(root, "index.html");
  }
  const body = await readFile(file).catch(() => undefined);
  if (!body) {
    json(res, 404, { error: "The web UI is not built: run npm run build" });
    return;
  }
  const immutable = isInside(join(root, "assets"), file);
  res
    .writeHead(200, {
      "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    })
    .end(body);
}
