import type { ReactElement, ReactNode } from "react";
import * as React from "react";
import { ChevronRight, File, Folder } from "@/components/ui/icons";
import { buildTree, isValidMove, type TreeEntry, type TreeNode } from "@/lib/tree";
import { cn, type SlotNode } from "@/lib/utils";

type FileTreeProps<T extends TreeEntry> = {
  /** What the list is, for a screen reader: "Files", "Notes". Read, not drawn. */
  label: string;
  /**
   * The files, and any folders worth listing, flat and in any order. A file's missing parents are
   * added and every level is sorted folders first, then by name — `buildTree` in `@/lib/tree`.
   */
  entries: readonly T[];
  /**
   * Files drawn above the tree, in the order given, never nested or sorted: a folder's README, a
   * skill's own Markdown. Each is called by its whole `path`, and reaches `linkSlot`, `meta` and
   * `actionSlot` as any other file does.
   */
  pinned?: readonly T[] | undefined;
  /** The open file's path. Its row is filled, and its link or button says it is the current one. */
  selected?: string | undefined;
  /**
   * The router's link to a file, as an element with no children — `<Link to="/notes/$" />` — which
   * the row is drawn inside. For an app that keeps the open file in the URL, so the row is a real
   * `<a href>` that a middle click opens. Given this, `onSelect` is not called.
   */
  linkSlot?: ((node: TreeNode<T>) => ReactElement) | undefined;
  /** A file's row was pressed. For an app that holds the open file in state; the row is a button. */
  onSelect?: ((path: string) => void) | undefined;
  /**
   * The small facts after a row's name: a size, a count, a badge. A string is drawn muted and extra
   * small; an element is placed as it is. Inside the pressed area. Called for folders too.
   */
  meta?: ((node: TreeNode<T>) => ReactNode) | undefined;
  /**
   * A row's far end, **outside** the pressed area: rename and delete buttons, or one `Menu`. Where
   * there is a pointer they are drawn on hover and on focus; on a touch screen, always.
   */
  actionSlot?: ((node: TreeNode<T>) => SlotNode) | undefined;
  /**
   * The paths of the open folders, when the caller holds them — to keep them across a reload, or
   * to open the way to a file. Leave it out and the tree holds its own.
   */
  open?: readonly string[] | undefined;
  /** Told the open folders on every toggle, controlled or not. */
  onOpenChange?: ((open: string[]) => void) | undefined;
  /** Which folders an uncontrolled tree starts with open: their paths, or every one. */
  defaultOpen?: readonly string[] | "all" | undefined;
  /**
   * A row was dropped on a folder. `from` is the dragged file's or folder's path; `into` is the
   * folder's path, and `""` for the top level. Given this, rows can be dragged: on the web, with a
   * pointer. The tree reorders nothing itself — move the file and hand back new `entries`. While a
   * returned promise is pending the row is drawn muted; a rejection is the caller's to report.
   */
  onMove?: ((from: string, into: string) => void | Promise<void>) | undefined;
  /** Whether this row may be dropped there. Asked while dragging; a refused folder is not tinted. */
  canMove?: ((node: TreeNode<T>, into: string) => boolean) | undefined;
  className?: string | undefined;
};

/** The pressed part of a row: the indent, the icon, the name and the meta. */
const ROW_CLASS = cn(
  "min-h-8 min-w-0 flex-1 flex-row items-center gap-2 rounded-md py-1.5 pr-2",
  "text-left focus-visible:outline-none",
);

/** How far one level sits inside the one above it: the chevron's own width. */
const INDENT = 16;
/** The gap between the tree's edge and its outermost rows. */
const EDGE = 8;

const NO_PATHS: ReadonlySet<string> = new Set();

/** How long a dragged row rests on a shut folder before it opens, so a drop can go deeper. */
const SPRING_OPEN_MS = 600;

/** The folder a drop would land in, and what is under it. */
const DROP_TARGET_CLASS = "rounded-md bg-active/10";

/** A string on its own is a crash on device, so a string `meta` gets a `Text` around it. */
function asText(node: ReactNode, className: string) {
  return typeof node === "string" || typeof node === "number" ? (
    <span className={cn("cube-rn-text", className)}>{node}</span>
  ) : (
    node
  );
}

function folderPaths<T extends TreeEntry>(nodes: readonly TreeNode<T>[]): string[] {
  return nodes.flatMap((node) =>
    node.type === "dir" ? [node.path, ...folderPaths(node.children)] : [],
  );
}

/**
 * A nested list of files and folders, as they sit on disk: folders first, each one a button that
 * folds what is under it, each file a link or a button. One source for both platforms.
 *
 * It is here because mcp-skills-manager drew a skill's files this way by hand — its own indent,
 * selected and hover colours, icon, monospace name and hover row actions on raw `<li>` and
 * `<button>` — and mcp-ragdown then copied it for its notes. Neither could fold a folder, because
 * that was not worth building for one app.
 *
 * What it settles, since the two copies disagreed or left it out:
 *
 * - **A folder folds.** Its row is one button with `aria-expanded` and a turning chevron, and what
 *   is under it is not mounted while it is shut. Every folder starts open, which is what both
 *   copies drew; `defaultOpen` starts it otherwise and `open`/`onOpenChange` hand it to the caller.
 * - **A file's row is a link or a button, never both.** `linkSlot` for an app whose open file is in
 *   the URL, `onSelect` for one that holds it in state. With neither, the row is only a row.
 * - **Row actions are siblings of the pressed part**, as `ListItem`'s are: a button in a button is
 *   invalid, and its click would also open the file. They are hidden until the row is hovered or
 *   holds focus only where there *is* a hover, so a touch screen is not left with buttons nobody
 *   can reach.
 * - **It is a list of lists, not a `role="tree"`.** Every row is reached with Tab and pressed with
 *   Enter or Space, which is what a list of links already does, and a tree role would promise
 *   arrow keys and typeahead on both platforms.
 * - **A row is dragged onto a folder, and the tree only says so.** With `onMove`, a row is picked
 *   up and the folder under the pointer — a file's row counts as the folder it is in, the tree's
 *   own blank space as the top level — is tinted and takes the drop. A drop on itself, into its own
 *   descendants or into the folder it is already in is refused before `canMove` is asked. Pinned
 *   rows stay put. HTML drag and drop has no touch or keyboard form, so this is the web half with
 *   a pointer, and the caller keeps a "Move to…" row action as the way in for everyone else.
 *
 * The nesting is `buildTree`'s, which ships beside it in `@/lib/tree` for a caller that wants the
 * nodes without the look. A view with no folders to nest under — "recently changed" — is not a
 * tree: draw that one as a list of `ListItem`s.
 */
export function FileTree<T extends TreeEntry>({
  label,
  entries,
  pinned,
  selected,
  linkSlot,
  onSelect,
  meta,
  actionSlot,
  open: openProp,
  onOpenChange,
  defaultOpen = "all",
  onMove,
  canMove,
  className,
}: FileTreeProps<T>) {
  const tree = React.useMemo(() => buildTree(entries), [entries]);
  const folders = React.useMemo(() => folderPaths(tree), [tree]);
  // What has been pressed, rather than what is open: a folder that arrives later still starts as
  // `defaultOpen` says, which a list of the open ones taken at mount would get wrong.
  const [toggled, setToggled] = React.useState(NO_PATHS);

  const isOpen = (path: string) =>
    openProp
      ? openProp.includes(path)
      : (defaultOpen === "all" || defaultOpen.includes(path)) !== toggled.has(path);

  const toggle = (path: string) => {
    const next = isOpen(path) === false;
    if (openProp === undefined) {
      setToggled((before) => {
        const after = new Set(before);
        if (!after.delete(path)) {
          after.add(path);
        }
        return after;
      });
    }
    onOpenChange?.(folders.filter((folder) => (folder === path ? next : isOpen(folder))));
  };

  const [dragged, setDragged] = React.useState<TreeNode<T> | null>(null);
  // The folder under the pointer while a row is dragged, `""` for the top level.
  const [over, setOver] = React.useState<string | null>(null);
  const [moving, setMoving] = React.useState(NO_PATHS);

  const droppable = (node: TreeNode<T>, into: string) =>
    isValidMove(node.path, into) &&
    moving.has(node.path) === false &&
    (canMove?.(node, into) ?? true);
  const dropInto = dragged && over !== null && droppable(dragged, over) ? over : null;

  const endDrag = () => {
    setDragged(null);
    setOver(null);
  };

  const move = (from: string, into: string) => {
    const done: unknown = onMove?.(from, into);
    if (done instanceof Promise === false) {
      return;
    }
    setMoving((before) => new Set(before).add(from));
    const settle = () =>
      setMoving((before) => {
        const after = new Set(before);
        after.delete(from);
        return after;
      });
    // Both arms: a failed move is the caller's to report, and must not leave the row muted.
    done.then(settle, settle);
  };

  const dragProps = (node: TreeNode<T>) => ({
    draggable: true,
    onDragStart: (event: React.DragEvent) => {
      // A link is dragged as its URL unless told otherwise; the path is what a drop here reads.
      event.dataTransfer.setData("text/plain", node.path);
      event.dataTransfer.effectAllowed = "move";
      setDragged(node);
    },
    onDragEnd: endDrag,
  });

  // On a folder's item and on the tree itself. The innermost one answers and stops the event, so a
  // folder that refuses the row does not hand it to the folder around it.
  const dropProps = (into: string) => ({
    onDragOver: (event: React.DragEvent) => {
      // Something dragged in from outside the tree is not this tree's to place.
      if (!dragged) {
        return;
      }
      event.stopPropagation();
      setOver(into);
      if (!droppable(dragged, into)) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    },
    onDrop: (event: React.DragEvent) => {
      if (!dragged) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      // Here as well as on `dragend`, which never arrives once the move has taken the row away.
      endDrag();
      if (droppable(dragged, into)) {
        move(dragged.path, into);
      }
    },
  });

  // Pinned rows are outside the tree's order: nothing lands on one, the top level included.
  const refuseDrop = {
    onDragOver: (event: React.DragEvent) => {
      if (!dragged) {
        return;
      }
      event.stopPropagation();
      setOver(null);
    },
  };

  const leaveTree = (event: React.DragEvent) => {
    const next = event.relatedTarget as Node | null;
    if (!event.currentTarget.contains(next)) {
      setOver(null);
    }
  };

  const canDrop = onMove !== undefined;

  const springOpen =
    dragged && over && over !== dragged.path && folders.includes(over) && isOpen(over) === false
      ? over
      : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `toggle` is this render's, taken when the row came to rest; the timer is dropped if anything it read changes
  React.useEffect(() => {
    if (springOpen === null) {
      return;
    }
    const timer = setTimeout(() => toggle(springOpen), SPRING_OPEN_MS);
    return () => clearTimeout(timer);
  }, [springOpen]);

  // A file has no chevron, so where the tree has folders it keeps the chevron's place and its icon
  // lines up with a folder's beside it.
  const hasFolders = folders.length > 0;

  const renderRow = (node: TreeNode<T>, depth: number, isFile: boolean, isPinned = false) => {
    const isSelected = isFile && selected === node.path;
    const ink = isSelected ? "text-active-foreground" : "text-foreground";
    const muted = isSelected ? "text-active-foreground" : "text-foreground/60";
    const indent = { paddingLeft: depth * INDENT + EDGE };
    const pressable = isFile === false || linkSlot !== undefined || onSelect !== undefined;
    const facts = meta?.(node);
    const actions = actionSlot?.(node);
    const drag = canDrop && isPinned === false ? dragProps(node) : {};

    const inside = (
      <>
        {isFile ? (
          <>
            {hasFolders ? <div className="cube-rn-view size-4 shrink-0" /> : null}
            <File aria-hidden className={cn("size-4 shrink-0", muted)} />
          </>
        ) : (
          <>
            <ChevronRight
              aria-hidden
              className={cn(
                "size-4 shrink-0",
                muted,
                "transition-transform",
                isOpen(node.path) && "rotate-90",
              )}
            />
            <Folder aria-hidden className={cn("size-4 shrink-0", muted)} />
          </>
        )}
        <span
          data-slot="file-tree-name"
          className={cn(
            "cube-rn-text",
            "min-w-0 shrink font-mono text-sm",
            // `truncate` is the ellipsis on the web; on device it is `numberOfLines`, which is
            // what `line-clamp-1` becomes and what `truncate` does not.
            "truncate",
            ink,
          )}
        >
          {node.name}
        </span>
        {facts ? (
          <div
            data-slot="file-tree-meta"
            className="cube-rn-view shrink-0 flex-row items-center gap-1"
          >
            {asText(facts, cn("text-xs tabular-nums", muted))}
          </div>
        ) : null}
      </>
    );

    let row: ReactElement;
    if (isFile === false) {
      const expanded = isOpen(node.path);
      row = (
        <button
          type="button"
          data-slot="file-tree-folder"
          aria-expanded={expanded}
          onClick={() => toggle(node.path)}
          className={cn("cube-rn-view cube-rn-pressable", ROW_CLASS)}
          style={indent}
          {...(drag as React.ComponentPropsWithoutRef<"button">)}
        >
          {inside}
        </button>
      );
    } else if (linkSlot) {
      row = fileLink(linkSlot(node), isSelected, indent, inside, drag);
    } else if (onSelect) {
      row = (
        <button
          type="button"
          data-slot="file-tree-file"
          aria-current={isSelected ? true : undefined}
          onClick={() => onSelect(node.path)}
          className={cn("cube-rn-view cube-rn-pressable", ROW_CLASS)}
          style={indent}
          {...(drag as React.ComponentPropsWithoutRef<"button">)}
        >
          {inside}
        </button>
      );
    } else {
      row = (
        <div
          data-slot="file-tree-file"
          className={cn("cube-rn-view", ROW_CLASS)}
          style={indent}
          {...(drag as React.ComponentPropsWithoutRef<"div">)}
        >
          {inside}
        </div>
      );
    }

    return (
      <div
        data-slot="file-tree-row"
        className={cn(
          "cube-rn-view",
          "min-w-0 flex-row items-center gap-1 rounded-md",
          "group",
          isSelected
            ? cn("bg-active", "has-[:focus-visible]:bg-active/90")
            : pressable && "transition-colors hover:bg-hover has-[:focus-visible]:bg-hover",
          // A slow move is not a failed one: the row waits where it was, drawn as unavailable.
          moving.has(node.path) && "opacity-50",
        )}
      >
        {row}
        {actions ? (
          <div
            data-slot="file-tree-action"
            className={cn(
              "cube-rn-view",
              "shrink-0 flex-row items-center gap-0.5 pr-1",
              // Hidden only where a pointer can bring them back. An open menu keeps its trigger on
              // screen after the pointer has left the row for the menu.
              "transition-opacity focus-within:opacity-100 has-[[aria-expanded=true]]:opacity-100 group-hover:opacity-100 [@media(hover:hover)]:opacity-0",
            )}
          >
            {actions}
          </div>
        ) : null}
      </div>
    );
  };

  const renderItems = (nodes: readonly TreeNode<T>[], depth: number): ReactNode =>
    nodes.map((node) => (
      <li
        key={node.path}
        data-slot="file-tree-item"
        className={cn(
          "cube-rn-view",
          "min-w-0 gap-0.5",
          dropInto === node.path && DROP_TARGET_CLASS,
        )}
        {...(canDrop && node.type === "dir" ? dropProps(node.path) : {})}
      >
        {renderRow(node, depth, node.type === "file")}
        {node.type === "dir" && node.children.length > 0 && isOpen(node.path) ? (
          <ul data-slot="file-tree-children" className="cube-rn-view min-w-0 gap-0.5">
            {renderItems(node.children, depth + 1)}
          </ul>
        ) : null}
      </li>
    ));

  if (tree.length === 0 && !pinned?.length) {
    return null;
  }

  return (
    <ul
      data-slot="file-tree"
      aria-label={label}
      className={cn(
        "cube-rn-view",
        "min-w-0 gap-0.5",
        dropInto === "" && DROP_TARGET_CLASS,
        className,
      )}
      {...(canDrop ? { ...dropProps(""), onDragLeave: leaveTree } : {})}
    >
      {pinned?.map((entry) => (
        <li
          key={entry.path}
          data-slot="file-tree-item"
          className="cube-rn-view min-w-0"
          {...(canDrop ? refuseDrop : {})}
        >
          {renderRow(
            { name: entry.path, path: entry.path, type: entry.type, entry, children: [] },
            0,
            true,
            true,
          )}
        </li>
      ))}
      {renderItems(tree, 0)}
    </ul>
  );
}

/**
 * A file's row as the router's link. On the web the caller's element *is* the row — it is cloned
 * with the row's classes and what is inside it, so it stays the router's own `<a>`. On device a
 * link is expo-router's, which takes the row the other way round: it is given `asChild` and wraps
 * the `Pressable`. `drag` is what picks the row up, which only the web has.
 */
function fileLink(
  link: ReactElement,
  isSelected: boolean,
  indent: { paddingLeft: number },
  inside: ReactNode,
  drag: object,
) {
  const element = link as ReactElement<Record<string, unknown>>;
  return React.cloneElement(
    element,
    {
      "data-slot": "file-tree-file",
      className: cn("flex", ROW_CLASS, element.props.className as string | undefined),
      style: indent,
      "aria-current": isSelected ? "page" : undefined,
      ...drag,
    },
    inside,
  );
}

export type { FileTreeProps };
