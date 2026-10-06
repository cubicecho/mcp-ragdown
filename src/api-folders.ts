import type { Config } from "./config.ts";
import type { Ragdown } from "./engine.ts";
import {
  createFolder,
  deleteFolder,
  deleteLooseFile,
  type Folder,
  type FolderChanges,
  listFolders,
  looseFiles,
  updateFolder,
} from "./folders.ts";
import { parseHookChanges } from "./hook-settings.ts";
import {
  type ApiRequest,
  allow,
  assertWritable,
  json,
  readJsonObject,
  required,
} from "./http-io.ts";
import { Refusal } from "./refusal.ts";
import type { FileState } from "./store.ts";

/** `/api/folders`, `/api/folders/<name>` and `/api/loose`: the folders and what sits beside them. */
export async function handleFolders(request: ApiRequest): Promise<void> {
  const { rag, config, path, method, params, req, res } = request;

  if (path === "/api/folders") {
    allow(request, "GET", "POST");
    if (method === "GET") {
      const [folders, loose] = await Promise.all([
        folderSummaries(rag, config),
        looseFiles(config.docsDir),
      ]);
      json(res, 200, { folders, loose_files: loose });
      return;
    }
    assertWritable(config);
    const body = await readJsonObject(req);
    if (typeof body.name !== "string") {
      json(res, 400, { error: "name is required" });
      return;
    }
    const folder = await createFolder(config.docsDir, body.name, settingsFrom(body));
    json(res, 201, { folder: await folderSummary(rag, folder) });
    return;
  }

  if (path.startsWith("/api/folders/")) {
    allow(request, "PATCH", "DELETE");
    let name: string;
    try {
      name = decodeURIComponent(path.slice("/api/folders/".length));
    } catch {
      name = "";
    }
    if (method === "DELETE") {
      assertWritable(config);
      if (params.get("confirm") !== name) {
        json(res, 400, {
          error: "confirm must repeat the folder's name: this deletes every file in it",
        });
        return;
      }
      await deleteFolder(config.docsDir, name);
      json(res, 200, { name, sync: await rag.sync(false) });
      return;
    }
    const body = await readJsonObject(req);
    const rename = body.name;
    if (rename !== undefined && typeof rename !== "string") {
      json(res, 400, { error: "name must be a string" });
      return;
    }
    if (rename !== undefined && rename !== name) {
      assertWritable(config);
    }
    const { folder, renamed } = await updateFolder(config.docsDir, name, {
      ...settingsFrom(body),
      ...(rename !== undefined ? { rename } : {}),
    });
    // Every path in the folder changed: the index answers for the new ones before this returns.
    if (renamed) {
      await rag.sync(false);
    }
    json(res, 200, { folder: await folderSummary(rag, folder) });
    return;
  }

  allow(request, "DELETE");
  assertWritable(config);
  const name = required(request, "name");
  await deleteLooseFile(config.docsDir, name);
  json(res, 200, { name });
}

function settingsFrom(body: Record<string, unknown> | undefined): FolderChanges {
  const out: FolderChanges = {};
  if (body?.title !== undefined) {
    if (typeof body.title !== "string") {
      throw new Refusal(400, "title must be a string");
    }
    out.title = body.title;
  }
  if (body?.mcp !== undefined) {
    if (typeof body.mcp !== "boolean") {
      throw new Refusal(400, "mcp must be true or false");
    }
    out.mcp = body.mcp;
  }
  if (body?.hook !== undefined) {
    out.hook = parseHookChanges(body.hook);
  }
  return out;
}

async function folderSummaries(rag: Ragdown, config: Config) {
  const [folders, files] = await Promise.all([listFolders(config.docsDir), rag.files()]);
  return folders.map((folder) => summarize(folder, files));
}

async function folderSummary(rag: Ragdown, folder: Folder) {
  return summarize(folder, await rag.files());
}

function summarize(folder: Folder, files: Map<string, FileState>) {
  let count = 0;
  let chunks = 0;
  for (const [path, state] of files) {
    if (!path.startsWith(`${folder.name}/`)) {
      continue;
    }
    count++;
    chunks += state.chunks;
  }
  return {
    name: folder.name,
    title: folder.title,
    mcp: folder.mcp,
    hook: folder.hook,
    mcp_path: `/mcp/${encodeURIComponent(folder.name)}`,
    files: count,
    chunks,
  };
}
