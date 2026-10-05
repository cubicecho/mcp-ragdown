/*
 * Copied from mcp-skills-manager (`app/src/components/domain/skill/editor/file-tree.ts`), made
 * generic over the entry as cubicecho/cubeui#226 proposes. It moves to cubeui with `FileTree`.
 */

/** One file or folder in a flat listing, addressed by its `/` path. */
export interface TreeEntry {
  path: string;
  type: "file" | "dir";
}

/** One file or folder in a tree, with its children nested under it. */
export interface TreeNode<T extends TreeEntry = TreeEntry> {
  name: string;
  path: string;
  type: "file" | "dir";
  /** The entry the node was built from; absent on a parent folder the listing left out. */
  entry?: T;
  children: TreeNode<T>[];
}

/**
 * Build a nested tree from a flat entry list, synthesizing any missing parent folders.
 * @param entries the files and folders, in any order.
 * @returns the root nodes, folders first and then by name at every level.
 */
export function buildTree<T extends TreeEntry>(entries: readonly T[]): TreeNode<T>[] {
  const roots: TreeNode<T>[] = [];
  const byPath = new Map<string, TreeNode<T>>();
  const ensure = (path: string, type: "file" | "dir", entry?: T): TreeNode<T> => {
    const found = byPath.get(path);
    if (found) {
      // A folder synthesized for a child that came first takes its own entry when it arrives.
      if (entry) found.entry = entry;
      return found;
    }
    const slash = path.lastIndexOf("/");
    const node: TreeNode<T> = { name: path.slice(slash + 1), path, type, children: [] };
    if (entry) node.entry = entry;
    byPath.set(path, node);
    if (slash === -1) roots.push(node);
    else ensure(path.slice(0, slash), "dir").children.push(node);
    return node;
  };
  for (const entry of entries) ensure(entry.path, entry.type, entry);
  const sort = (nodes: TreeNode<T>[]): void => {
    nodes.sort((a, b) =>
      a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name),
    );
    for (const node of nodes) sort(node.children);
  };
  sort(roots);
  return roots;
}
