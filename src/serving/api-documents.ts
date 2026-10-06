import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname } from "node:path";
import { pipeline } from "node:stream/promises";
import { Scope } from "../documents/scope.ts";
import { getFolder } from "../folders/folder-settings.ts";
import { supersededBy } from "../indexing/store.ts";
import type { Config } from "../shared/config.ts";
import { defaults } from "../shared/defaults.ts";
import { hasCode } from "../shared/errors.ts";
import { Refusal } from "../shared/refusal.ts";
import {
  type ApiRequest,
  allow,
  assertWritable,
  json,
  readJsonObject,
  required,
} from "./http-io.ts";
import { CONTENT_TYPES } from "./web-ui.ts";

/** What `/api/file` says a document's attachment is; anything else is a download. */
const FILE_TYPES: Record<string, string> = {
  ...CONTENT_TYPES,
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".mdx": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".html": "text/plain; charset=utf-8",
  ".js": "text/plain; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".pdf": "application/pdf",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
};

/**
 * Every `/api` route that reads, writes, moves, searches or links the documents in a folder. A
 * path here is relative to the docs root, folder first: `work/notes/a.md`. A write answers once
 * the index has synced, so the next `/api/docs` already reflects it.
 */
export async function handleDocuments(request: ApiRequest): Promise<void> {
  const { rag, config, path, method, params, req, res } = request;
  const root = new Scope(rag);

  if (path === "/api/doc" && (method === "POST" || method === "DELETE")) {
    assertWritable(config);
    if (method === "POST") {
      const body = await readJsonObject(req, defaults.maxUploadBytes);
      if (typeof body.path !== "string" || typeof body.text !== "string") {
        json(res, 400, { error: "path and text are required strings" });
        return;
      }
      await assertInFolder(config, body.path);
      const written = await root.writeDocument(
        body.path,
        body.text,
        body.overwrite === true,
        typeof body.base_hash === "string" ? body.base_hash : undefined,
      );
      json(res, written.created ? 201 : 200, written);
      return;
    }
    const docPath = required(request, "path");
    await assertInFolder(config, docPath);
    json(res, 200, await root.deleteDocument(docPath));
    return;
  }

  if (path === "/api/move") {
    allow(request, "POST");
    assertWritable(config);
    const body = await readJsonObject(req, defaults.maxUploadBytes);
    if (typeof body.from !== "string" || typeof body.to !== "string") {
      json(res, 400, { error: "from and to are required strings" });
      return;
    }
    const name = await assertInFolder(config, body.from);
    if ((await assertInFolder(config, body.to)) !== name) {
      json(res, 400, { error: "a move stays within its folder: links do not cross folders" });
      return;
    }
    const moved = await new Scope(rag, name).move(
      body.from.slice(name.length + 1),
      body.to.slice(name.length + 1),
    );
    json(res, 200, {
      ...moved,
      from: `${name}/${moved.from}`,
      to: `${name}/${moved.to}`,
      updated: moved.updated.map((each) => `${name}/${each}`),
    });
    return;
  }

  allow(request, "GET");

  if (path === "/api/docs") {
    const name = params.get("folder");
    if (name && !(await getFolder(config.docsDir, name))) {
      json(res, 404, { error: `no such folder: ${name}` });
      return;
    }
    const all = await rag.documents();
    const replaced = supersededBy(all);
    const docs = all.filter((doc) => !name || doc.path.startsWith(`${name}/`));
    json(res, 200, {
      docs: docs.map((doc) => ({
        path: doc.path,
        folder: doc.path.split("/")[0] ?? "",
        title: doc.title,
        mtime_ms: doc.mtimeMs,
        size: doc.size,
        chunks: doc.chunks,
        tags: doc.tags,
        aliases: doc.aliases,
        superseded_by: replaced.get(doc.path) ?? [],
      })),
    });
    return;
  }

  if (path === "/api/doc") {
    json(res, 200, await root.readIndexedDocument(required(request, "path")));
    return;
  }

  if (path === "/api/search") {
    const name = required(request, "folder");
    const query = required(request, "q");
    const topK = Math.min(
      defaults.maxTopK,
      Math.max(1, Number.parseInt(params.get("top_k") ?? "", 10) || 10),
    );
    if (!(await getFolder(config.docsDir, name))) {
      json(res, 404, { error: `no such folder: ${name}` });
      return;
    }
    const hits = await new Scope(rag, name).recall(
      query,
      topK,
      undefined,
      params.get("tag") || undefined,
    );
    json(res, 200, {
      hits: hits.map((hit) => ({
        path: `${name}/${hit.path}`,
        title: hit.title,
        heading: hit.heading,
        start_line: hit.lineStart,
        end_line: hit.lineEnd,
        similarity: Number(hit.similarity.toFixed(4)),
        text: hit.text,
        tags: hit.tags,
      })),
    });
    return;
  }

  if (path === "/api/resolve") {
    const from = required(request, "from");
    const link = required(request, "link");
    const name = await assertInFolder(config, from);
    const resolved = await new Scope(rag, name).resolveLink(
      link,
      from.slice(name.length + 1),
      true,
    );
    if (!resolved) {
      json(res, 404, { error: `no document or file matches ${JSON.stringify(link)}` });
      return;
    }
    json(res, 200, { ...resolved, path: `${name}/${resolved.path}` });
    return;
  }

  if (path === "/api/backlinks") {
    const docPath = required(request, "path");
    const name = await assertInFolder(config, docPath);
    const found = await new Scope(rag, name).backlinks(docPath.slice(name.length + 1));
    json(res, 200, {
      path: docPath,
      backlinks: found.backlinks.map((link) => ({ ...link, path: `${name}/${link.path}` })),
    });
    return;
  }

  if (path === "/api/file") {
    const filePath = required(request, "path");
    await assertInFolder(config, filePath);
    const full = await root.fileFor(filePath);
    const type = FILE_TYPES[extname(full).toLowerCase()] ?? "application/octet-stream";
    const info = await stat(full);
    res.writeHead(200, {
      "content-type": type,
      "content-length": info.size,
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
      // A document's SVG or HTML is someone's file, not this app: opened directly, it runs nothing.
      "content-security-policy": "sandbox",
    });
    await pipeline(createReadStream(full), res).catch((error: unknown) => {
      // The client hung up, often right after the last byte and before `finish`: nothing to answer.
      if (!hasCode(error, "ERR_STREAM_PREMATURE_CLOSE")) {
        throw error;
      }
    });
    return;
  }

  json(res, 404, { error: "Not found" });
}

/**
 * The folder a root-relative path is in, which must exist, and the path must be inside it: the
 * docs root itself holds no documents in folders mode.
 *
 * @throws with `status: 400` otherwise.
 */
async function assertInFolder(config: Config, path: string): Promise<string> {
  const segments = path.replaceAll("\\", "/").split("/").filter(Boolean);
  const name = segments[0] ?? "";
  if (segments.length < 2 || !(await getFolder(config.docsDir, name))) {
    throw new Refusal(400, `not inside a folder: ${path} (start it with a folder's name)`);
  }
  return name;
}
