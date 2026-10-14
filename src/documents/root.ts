import { createFolder, type Folder, getFolder, listFolders } from "../folders/folder-settings.ts";
import { hookContext } from "../hook/hook-context.ts";
import { type ContextOptions, resolveHook } from "../hook/hook-settings.ts";
import type { Hit, WrittenBy } from "../indexing/store.ts";
import type { Ragdown } from "../serving/engine.ts";
import { Refusal } from "../shared/refusal.ts";
import { normalizeFolder, openScope, type Scope, sessionKey } from "./scope.ts";

/** The directory the root's own session memory is kept under: no folder's. */
const EVERY_FOLDER = "";

/** What a folder made through the root records as its `created_by`. */
const CREATED_BY = "ragdown_create_folder";

/**
 * The documents as the root endpoint (`/mcp`) sees them: every folder with MCP on, and nothing of a
 * human-only one. A call that names a folder is answered by that folder's `Scope`, so links, moves,
 * hook settings and session memory stay each folder's own. A call that names none is answered here,
 * across the folders, and whatever comes back says which folder it is from.
 */
export class Root {
  readonly rag: Ragdown;

  constructor(rag: Ragdown) {
    this.rag = rag;
  }

  get config() {
    return this.rag.config;
  }

  /**
   * One folder, as its own endpoint would see it, with what it returns naming the folder.
   *
   * @throws with `status: 404` for a missing folder and a human-only one alike, so neither gives
   *   the other away.
   */
  async scope(name: string): Promise<Scope> {
    const folder = await getFolder(this.config.docsDir, name);
    const scope = folder?.mcp ? await openScope(this.rag, name, true) : undefined;
    if (!scope) {
      throw new Refusal(
        404,
        `no such folder: ${JSON.stringify(name)} (ragdown_folders lists the folders)`,
      );
    }
    return scope;
  }

  /**
   * Search every folder at once, as `Scope.recall` searches one.
   *
   * @param pathPrefix - limits the search to files under this subfolder of each folder.
   */
  async recall(
    query: string,
    topK: number,
    pathPrefix?: string,
    tag?: string,
    writtenBy?: WrittenBy,
  ): Promise<Hit[]> {
    const subfolder = normalizeFolder(pathPrefix);
    const prefixes = (await this.visible()).map(
      (folder) => `${[folder.name, subfolder].filter(Boolean).join("/")}/`,
    );
    const hits = await this.rag.recall(query, topK, prefixes, tag, writtenBy);
    return hits.map((hit) => ({ ...hit, ...inFolder(hit.path) }));
  }

  /**
   * The context block for a prompt, from every folder. No folder's own hook settings apply: the
   * call's arguments, then the server's.
   */
  async context(
    prompt: string,
    sessionId?: string,
    options: ContextOptions = {},
  ): Promise<string | undefined> {
    return hookContext({
      prompt,
      source: this.config.docsDir,
      settings: resolveHook(options, {}, this.config.hook),
      textLimit: this.config.textLimit,
      perDocument: this.config.maxPerDocument,
      seenBy: () =>
        sessionId ? this.rag.sessions.seen(sessionKey(EVERY_FOLDER, sessionId)) : new Set<string>(),
      recall: (query, topK) => this.recall(query, topK),
    });
  }

  /** Forget which chunks a session was given across the folders, as `Scope.forgetSession` does. */
  forgetSession(sessionId: string): void {
    this.rag.sessions.forget(sessionKey(EVERY_FOLDER, sessionId));
  }

  /**
   * The documents of every folder, folder by folder, or with `sort: "recent"` the most recently
   * changed first whichever folder they are in. `options` are `Scope.listDocuments`'s.
   */
  async listDocuments(options: Parameters<Scope["listDocuments"]>[0] = {}) {
    const { limit, ...filters } = options;
    const scopes = await Promise.all(
      (await this.visible()).map((folder) => openScope(this.rag, folder.name, true)),
    );
    const lists = await Promise.all(scopes.map((scope) => scope?.listDocuments(filters)));
    const documents = lists.flatMap((list) => list?.documents ?? []);
    if (options.sort === "recent") {
      // ISO timestamps, so the order of the strings is the order of the times.
      documents.sort((a, b) => b.modified.localeCompare(a.modified));
    }
    return { total: documents.length, documents: documents.slice(0, limit ?? documents.length) };
  }

  /** The whole index's status, with the counts narrowed to the folders the root sees. */
  async stats(includeFiles: boolean) {
    const { file_list: all = [], ...stats } = await this.rag.stats(true);
    const names = new Set((await this.visible()).map((folder) => folder.name));
    const files = all
      .map((file) => ({ ...inFolder(file.path), chunks: file.chunks }))
      .filter((file) => names.has(file.folder));
    return {
      ...stats,
      scope: null,
      folders: names.size,
      files: files.length,
      chunks: files.reduce((sum, file) => sum + file.chunks, 0),
      ...(includeFiles ? { file_list: files } : {}),
    };
  }

  /** Sync (or with `full`, rebuild) the whole index: there is one, shared by every folder. */
  sync(full: boolean) {
    return this.rag.sync(full);
  }

  /** The folders an agent may name, each with how much it holds. */
  async folders() {
    const [folders, files] = await Promise.all([this.visible(), this.rag.files()]);
    return folders.map((folder) => {
      const held = [...files].filter(([path]) => path.startsWith(`${folder.name}/`));
      return {
        name: folder.name,
        title: folder.title,
        created_by: folder.createdBy,
        files: held.length,
        chunks: held.reduce((sum, [, state]) => sum + state.chunks, 0),
      };
    });
  }

  /**
   * Make a folder for an agent. It starts with MCP on, or the agent that made it could not see
   * it, and records that an agent made it.
   *
   * @throws with `status: 400` for a bad name, `409` when something by that name exists.
   */
  async createFolder(name: string, title?: string): Promise<Folder> {
    return createFolder(this.config.docsDir, name, {
      mcp: true,
      createdBy: CREATED_BY,
      ...(title ? { title } : {}),
    });
  }

  /** The folders with MCP on: all the root shows of the docs dir. */
  private async visible(): Promise<Folder[]> {
    return (await listFolders(this.config.docsDir)).filter((folder) => folder.mcp);
  }
}

/** A path relative to the docs root, as its folder and the path inside that. */
function inFolder(rootPath: string): { folder: string; path: string } {
  const slash = rootPath.indexOf("/");
  return { folder: rootPath.slice(0, slash), path: rootPath.slice(slash + 1) };
}
