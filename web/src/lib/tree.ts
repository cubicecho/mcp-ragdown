export interface TreeEntry {
  path: string;
  type: "file" | "dir";
}

/** One file or folder in a tree, with its children nested under it. */
export interface TreeNode<T extends TreeEntry = TreeEntry> {
  /** The last segment of the path: what the row is called. */
  name: string;
  /**
   * The path without empty segments: the `docs/` an object store lists for a folder is `docs`.
   * `entry.path` keeps the key as it was listed.
   */
  path: string;
  type: "file" | "dir";
  /** The entry the node was built from; absent on a parent folder the listing left out. */
  entry?: T;
  children: TreeNode<T>[];
}

/**
 * Nest a flat path list, adding any parent folder the list leaves out.
 *
 * A listing of files is what a server hands back — an object store has no folders at all, and a
 * directory walk that skips empty ones names a folder only through what is inside it — so a parent
 * is made from the path of its child rather than asked for. A leading, trailing or doubled `/`
 * names no folder, and an entry that is all slashes is left out.
 *
 * A file can share its path with a folder: an object store holds the key `notes` beside
 * `notes/a.md`. Both are kept, the folder first, so the file can still be opened and nothing under
 * the folder is lost. A file and a folder are told apart by `type`, not `path`.
 *
 * @param entries the files and folders, in any order.
 * @returns the root nodes, folders first and then by name at every level, the digits in a name
 * read as a number so `file2` comes before `file10`.
 */
export function buildTree<T extends TreeEntry>(entries: readonly T[]): TreeNode<T>[] {
  const roots: TreeNode<T>[] = [];
  // Keyed by type as well as path, because a file and a folder may share a path.
  const byKey = new Map<string, TreeNode<T>>();
  const ensure = (path: string, type: "file" | "dir", entry?: T): TreeNode<T> => {
    const key = `${type}:${path}`;
    const found = byKey.get(key);
    if (found) {
      // A folder made for a child that came first takes its own entry when it arrives.
      if (entry) {
        found.entry = entry;
      }
      return found;
    }
    const slash = path.lastIndexOf("/");
    const node: TreeNode<T> = { name: path.slice(slash + 1), path, type, children: [] };
    if (entry) {
      node.entry = entry;
    }
    byKey.set(key, node);
    if (slash === -1) {
      roots.push(node);
    } else {
      ensure(path.slice(0, slash), "dir").children.push(node);
    }
    return node;
  };
  for (const entry of entries) {
    const path = entry.path
      .split("/")
      .filter((segment) => segment !== "")
      .join("/");
    if (path !== "") {
      ensure(path, entry.type, entry);
    }
  }
  const sort = (nodes: TreeNode<T>[]): void => {
    nodes.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === "dir" ? -1 : 1;
      }
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });
    for (const node of nodes) {
      sort(node.children);
    }
  };
  sort(roots);
  return roots;
}

/**
 * The folder a path sits in.
 *
 * @param path a file's or folder's `/` path.
 * @returns the parent folder's path, and `""` for the top level.
 */
export function parentPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/**
 * Whether moving `from` into the folder `into` is a move at all: not a folder onto itself or into
 * something under it, and not into the folder it is already in. A file shares no path with what
 * is under a folder, so the file `logs` may go into the folder `logs`, beside it (see `buildTree`).
 *
 * @param from the path being moved.
 * @param into the folder it would land in, `""` for the top level.
 * @param type whether `from` is a file or a folder. Left out, it is read as a folder, the stricter
 * of the two.
 * @returns `false` for a move that would change nothing or cannot be made.
 */
export function isValidMove(from: string, into: string, type: "file" | "dir" = "dir"): boolean {
  if (type === "dir" && (into === from || into.startsWith(`${from}/`))) {
    return false;
  }
  return parentPath(from) !== into;
}
