export interface TreeEntry {
  path: string;
  type: "file" | "dir";
}

/** One file or folder in a tree, with its children nested under it. */
export interface TreeNode<T extends TreeEntry = TreeEntry> {
  /** The last segment of the path: what the row is called. */
  name: string;
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
 * is made from the path of its child rather than asked for.
 *
 * @param entries the files and folders, in any order.
 * @returns the root nodes, folders first and then by name at every level.
 */
export function buildTree<T extends TreeEntry>(entries: readonly T[]): TreeNode<T>[] {
  const roots: TreeNode<T>[] = [];
  const byPath = new Map<string, TreeNode<T>>();
  const ensure = (path: string, type: "file" | "dir", entry?: T): TreeNode<T> => {
    const found = byPath.get(path);
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
    byPath.set(path, node);
    if (slash === -1) {
      roots.push(node);
    } else {
      ensure(path.slice(0, slash), "dir").children.push(node);
    }
    return node;
  };
  for (const entry of entries) {
    ensure(entry.path, entry.type, entry);
  }
  const sort = (nodes: TreeNode<T>[]): void => {
    nodes.sort((a, b) =>
      a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name),
    );
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
 * Whether moving `from` into the folder `into` is a move at all: not onto itself, not a folder
 * into something under it, and not into the folder it is already in.
 *
 * @param from the path being moved.
 * @param into the folder it would land in, `""` for the top level.
 * @returns `false` for a move that would change nothing or cannot be made.
 */
export function isValidMove(from: string, into: string): boolean {
  if (into === from || into.startsWith(`${from}/`)) {
    return false;
  }
  return parentPath(from) !== into;
}
