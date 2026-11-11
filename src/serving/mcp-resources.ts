import { basename, posix } from "node:path";
import { type McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ErrorCode,
  McpError,
  type ReadResourceResult,
  type ResourceLink,
} from "@modelcontextprotocol/sdk/types.js";
import { Root } from "../documents/root.ts";
import type { Scope } from "../documents/scope.ts";
import { errorMessage } from "../shared/errors.ts";
import { docsPath } from "../usage/query-log.ts";

/**
 * A document's address, as a resource. The folder is in it even on a folder's own endpoint, so one
 * URI is one document whichever endpoint handed it out, and the path is the folder's, not the
 * endpoint's: a subfolder endpoint names a document as the folder's endpoint would.
 */
export const DOCUMENT_URI_TEMPLATE = "ragdown://{folder}/{+path}";

/**
 * The `_meta` key of a link's web address. The spec has no field for where a person views a
 * resource; `_meta` is its place for extensions, and the key is namespaced so other cubicecho
 * servers can use the same one.
 */
export const WEB_URL_META = "com.cubicecho/webUrl";

const MARKDOWN_TYPE = "text/markdown";

/** The folder a scope's documents are in, by name: the docs dir's own name in single mode. */
function folderName(scope: Scope): string {
  return scope.folder || basename(scope.config.docsDir);
}

/** A path relative to the scope, made relative to its folder. */
function inFolder(scope: Scope, path: string): string {
  const rootPath = docsPath(scope.dir, path);
  return scope.folder ? rootPath.slice(scope.folder.length + 1) : rootPath;
}

/** The URI of a document in a folder, each part encoded for it. */
export function documentUri(folder: string, path: string): string {
  return `ragdown://${encodeURIComponent(folder)}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * The `resource_link` a write tool appends to its text, for the document it just wrote. A host
 * collects these rather than parse the sentence before them, and can `resources/read` the URI.
 *
 * @param path - the document, relative to the scope, as the tool's result names it.
 * @param publicUrl - `RAGDOWN_PUBLIC_URL`; the web link is left out when it is not set.
 * @returns undefined for anything the index does not hold — a moved subfolder, say — since a link
 *   is to something `resources/read` can answer, and it answers only an indexed document.
 */
export async function documentLink(
  scope: Scope,
  path: string,
  publicUrl: string | null,
): Promise<ResourceLink | undefined> {
  const rootPath = docsPath(scope.dir, path);
  const doc = (await scope.rag.documents()).find((each) => each.path === rootPath);
  if (!doc) {
    return undefined;
  }
  const folder = folderName(scope);
  const folderPath = inFolder(scope, path);
  return {
    type: "resource_link",
    uri: documentUri(folder, folderPath),
    name: folderPath,
    title: doc.title,
    mimeType: MARKDOWN_TYPE,
    // The time of this write, which for a move is not the file's mtime: a rename keeps that.
    annotations: { audience: ["user", "assistant"], lastModified: new Date().toISOString() },
    ...(publicUrl
      ? {
          _meta: {
            [WEB_URL_META]: `${publicUrl}/f/${encodeURIComponent(folder)}?doc=${encodeURIComponent(folderPath)}`,
          },
        }
      : {}),
  };
}

/**
 * Serve the documents as resources, by `DOCUMENT_URI_TEMPLATE`. Nothing is listed: the spec lets
 * a tool's links stay out of `resources/list`, and a folder of documents is no list to hand a
 * client whole. A read answers what `/api/doc` would — an indexed document inside the folder — and
 * on a folder's endpoint only a document of that endpoint's own scope.
 *
 * @param target - the `Root`, or the scope the endpoint serves, as `createMcpServer` takes it.
 */
export function registerDocuments(server: McpServer, target: Promise<Scope> | Root): void {
  server.registerResource(
    "document",
    new ResourceTemplate(DOCUMENT_URI_TEMPLATE, { list: undefined }),
    {
      title: "Document",
      description: "A Markdown document, by its folder and its path inside that folder",
      mimeType: MARKDOWN_TYPE,
    },
    async (uri, variables): Promise<ReadResourceResult> => {
      try {
        const folder = decodeURIComponent(String(variables.folder));
        const path = posix.normalize(decodeURIComponent(String(variables.path)));
        if (path.startsWith("/") || path === ".." || path.startsWith("../")) {
          throw new Error(`path is outside the folder: ${path}`);
        }
        const { scope, scoped } = await scopeFor(target, folder, path);
        const doc = await scope.readIndexedDocument(scoped);
        return { contents: [{ uri: uri.href, mimeType: MARKDOWN_TYPE, text: doc.text }] };
      } catch (error) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `cannot read ${uri.href}: ${errorMessage(error)}`,
        );
      }
    },
  );
}

/**
 * The scope that answers a read of `path` in `folder`, and the path relative to it. At the root
 * that is the folder's own (refused for one without MCP, as every root tool refuses it); on a
 * folder's endpoint it is the endpoint's, which must hold the document.
 */
async function scopeFor(
  target: Promise<Scope> | Root,
  folder: string,
  path: string,
): Promise<{ scope: Scope; scoped: string }> {
  if (target instanceof Root) {
    return { scope: await target.scope(folder), scoped: path };
  }
  const scope = await target;
  const sub = scope.folder ? scope.dir.slice(scope.folder.length + 1) : "";
  if (folder !== folderName(scope) || (sub && !path.startsWith(`${sub}/`))) {
    throw new Error("not a document this endpoint serves");
  }
  return { scope, scoped: sub ? path.slice(sub.length + 1) : path };
}
