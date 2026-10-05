import { cloneElement, type ReactElement, type ReactNode, useMemo } from "react";
import { File } from "@/components/app-icons";
import { Folder } from "@/components/ui/icons";
import { buildTree, type TreeEntry, type TreeNode } from "@/lib/file-tree";
import { cn, HOVER_REVEAL } from "@/lib/utils";

const ROW = "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5";

type Row<T extends TreeEntry> = { node: TreeNode<T>; depth: number };

function flatten<T extends TreeEntry>(nodes: TreeNode<T>[], depth = 0): Row<T>[] {
  return nodes.flatMap((node) => [{ node, depth }, ...flatten(node.children, depth + 1)]);
}

/**
 * A nested list of files and folders, as they sit on disk: folders first, each file a link.
 *
 * Copied from mcp-skills-manager's `FileTreeNode` (`app/src/components/domain/skill/editor/
 * files-panel.tsx`) until cubeui ships one (cubicecho/cubeui#226), so it is replaced, not grown.
 * The one change is that a file's row is the router's link rather than a button, because the
 * open note lives in the URL.
 */
export function FileTree<T extends TreeEntry>({
  label,
  entries,
  selected,
  link,
  badge,
  action,
  className,
}: {
  /** What the list is, for a screen reader: "Notes". */
  label: string;
  /** The files, and any folders worth listing; a file's missing parents are added. */
  entries: readonly T[];
  /** The open file's path. */
  selected?: string | undefined;
  /** The router's link to a file, as an element with no children; the row is drawn inside it. */
  link: (node: TreeNode<T>) => ReactElement;
  /** What a row is wearing, after its name. */
  badge?: ((node: TreeNode<T>) => ReactNode) | undefined;
  /** A row's buttons, shown on hover and focus. */
  action?: ((node: TreeNode<T>) => ReactNode) | undefined;
  className?: string | undefined;
}) {
  const rows = useMemo(() => flatten(buildTree(entries)), [entries]);
  return (
    <ul aria-label={label} className={cn("flex flex-col gap-0.5", className)}>
      {rows.map(({ node, depth }) => {
        const isDir = node.type === "dir";
        const isSelected = !isDir && selected === node.path;
        const Icon = isDir ? Folder : File;
        const indent = { paddingLeft: `${depth * 16 + 8}px` };
        const inner = (
          <>
            <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 truncate font-mono">{node.name}</span>
            {badge?.(node)}
          </>
        );
        const actions = action?.(node);
        return (
          <li
            key={node.path}
            className={cn(
              "group flex items-center gap-1 rounded-md text-sm",
              isSelected ? "bg-accent text-accent-foreground" : "hover:bg-muted/50",
            )}
          >
            {isDir ? (
              <span className={ROW} style={indent}>
                {inner}
              </span>
            ) : (
              cloneElement(
                link(node) as ReactElement<Record<string, unknown>>,
                {
                  className: cn(
                    ROW,
                    "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  ),
                  style: indent,
                  "aria-current": isSelected ? "page" : undefined,
                },
                inner,
              )
            )}
            {actions ? (
              <span
                className={cn(
                  "flex shrink-0 items-center gap-0.5 pr-1 focus-within:opacity-100",
                  HOVER_REVEAL,
                )}
              >
                {actions}
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
