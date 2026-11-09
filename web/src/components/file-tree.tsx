import type { ReactElement, ReactNode } from "react";
import * as React from "react";
import { CollapsibleTrigger } from "@/components/collapsible";
import { rowFillClass, rowLink } from "@/components/list-item";
import { File, Folder } from "@/components/ui/icons";
import { IconClassContext } from "@/components/ui/icons-base";
import { buildTree, isValidMove, type TreeEntry, type TreeNode } from "@/lib/tree";
import { actionGap, cn, type SlotNode, touchRowClass } from "@/lib/utils";

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
  /**
   * The open file: its key as `entries` listed it, which `onSelect` hands back. Its row is tinted,
   * a step further under the pointer, and its link or button says it is the current one. The
   * node's cleaned `path` is matched too, so `a/b.md` still finds the file listed as `a//b.md`.
   */
  selected?: string | undefined;
  /**
   * The router's link to a file, as an element with no children — `<Link to="/notes/$" />` — which
   * the row is drawn inside. For an app that keeps the open file in the URL, so the row is a real
   * `<a href>` that a middle click opens. Given this, `onSelect` is not called.
   */
  linkSlot?: ((node: TreeNode<T>) => ReactElement) | undefined;
  /**
   * A file's row was pressed. For an app that holds the open file in state; the row is a button.
   * `path` is the file's key exactly as `entries` listed it (`entry.path`), so an object store's
   * `a//b.md` comes back as `a//b.md` and not as the tree's cleaned `a/b.md`. The node is the
   * row's, for the rest of its entry.
   */
  onSelect?: ((path: string, node: TreeNode<T>) => void) | undefined;
  /**
   * The small facts after a row's name: a size, a count, a badge. A string is drawn muted and extra
   * small; an element is placed as it is. Inside the pressed area. Called for folders too.
   *
   * On the selected row the meta takes the row's ink. On the web that overrides a node's own
   * colour classes (and turns its borders to the ink at /50); on a device icons follow through
   * `IconClassContext` but a node's own `Text` cannot be reached, so a node meta should not set
   * its own colour — leave a Badge's variant to do it, or pass a string.
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
   * folder's path, and `""` for the top level. Both are the tree's cleaned paths, so `into/name`
   * is where the row lands. `node` is the dragged row: its `type` says whether `from` was the file
   * or the folder when the two share a path, and its `entry.path` is the key as listed. Given
   * this, rows can be dragged: on the web, with a pointer. The tree reorders nothing itself — move
   * the file and hand back new `entries`. While a returned promise is pending the row is drawn
   * muted; a rejection is the caller's to report.
   */
  onMove?: ((from: string, into: string, node: TreeNode<T>) => void | Promise<void>) | undefined;
  /** Whether this row may be dropped there. Asked while dragging; a refused folder is not tinted. */
  canMove?: ((node: TreeNode<T>, into: string) => boolean) | undefined;
  /** On the tree's outer list. A dragged row can be dropped on it to move to the top level. */
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

/** Which row a node is: a file and a folder can share a path (see `buildTree`). */
const nodeKey = (node: TreeNode) => `${node.type}:${node.path}`;

/** How long a dragged row rests on a shut folder before it opens, so a drop can go deeper. */
const SPRING_OPEN_MS = 600;

/** The folder a drop would land in, and what is under it. */
// The chosen-row tint: a drop target is chosen, as the file picker's zone is under a drag.
const DROP_TARGET_CLASS = "rounded-md bg-active/40";

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
 * folds what is under it, each file a link (`linkSlot`) or a button (`onSelect`). The nesting is
 * `buildTree`'s, from `@/lib/tree`.
 *
 * It is a list of lists and not a `role="tree"`, which would promise arrow keys and typeahead.
 * Row actions are siblings of the pressed part, because a button in a button is invalid. With
 * `onMove` a row is dragged onto a folder; HTML drag and drop has no touch or keyboard form, so
 * the caller keeps a "Move to…" row action as well.
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
  const treeId = React.useId();
  // What a folder's `aria-controls` names. A path may hold a space, which would split the id list.
  const childrenId = (path: string) => `${treeId}${encodeURIComponent(path)}`;
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
        if (after.delete(path) === false) {
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
  // The rows whose move is pending, by `nodeKey`.
  const [moving, setMoving] = React.useState(NO_PATHS);

  const droppable = (node: TreeNode<T>, into: string) =>
    isValidMove(node.path, into, node.type) &&
    moving.has(nodeKey(node)) === false &&
    (canMove?.(node, into) ?? true);
  const dropInto = dragged && over !== null && droppable(dragged, over) ? over : null;

  const endDrag = () => {
    setDragged(null);
    setOver(null);
  };

  const move = (node: TreeNode<T>, into: string) => {
    const done: unknown = onMove?.(node.path, into, node);
    if (done instanceof Promise === false) {
      return;
    }
    const key = nodeKey(node);
    setMoving((before) => new Set(before).add(key));
    const settle = () =>
      setMoving((before) => {
        const after = new Set(before);
        after.delete(key);
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
      if (droppable(dragged, into) === false) {
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
        move(dragged, into);
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
    if (event.currentTarget.contains(next) === false) {
      setOver(null);
    }
  };

  const canDrop = onMove !== undefined;

  const springOpen =
    dragged &&
    over &&
    // The file `logs` can go into the folder `logs`; the folder cannot go into itself.
    (dragged.type === "file" || over !== dragged.path) &&
    folders.includes(over) &&
    isOpen(over) === false
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
    const isSelected =
      isFile && selected !== undefined && (selected === node.entry?.path || selected === node.path);
    // On the chosen tint, and inside the folder a drag is over (the same tint), /60 is under 4.5:1.
    const inDrop =
      dropInto !== null &&
      (dropInto === "" ||
        (isFile === false && node.path === dropInto) ||
        node.path.startsWith(`${dropInto}/`));
    const muted = inDrop || isSelected ? "text-foreground" : "text-foreground/60";
    const indent = { paddingLeft: depth * INDENT + EDGE };
    // A finger's 44pt on device, where the web's 32px row is too small to aim at (#470).
    const rowClass = cn(ROW_CLASS, touchRowClass());
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
          // The chevron before it is the trigger's own.
          <Folder aria-hidden className={cn("size-4 shrink-0", muted)} />
        )}
        <span
          data-slot="file-tree-name"
          className={cn(
            "cube-rn-text",
            "min-w-0 shrink font-mono text-sm",
            // `truncate` is the ellipsis on the web; on device it is `numberOfLines`, which is
            // what `line-clamp-1` becomes and what `truncate` does not.
            "truncate",
            "text-foreground",
          )}
        >
          {node.name}
        </span>
        {facts ? (
          <div
            data-slot="file-tree-meta"
            className={cn(
              "cube-rn-view",
              "shrink-0 flex-row items-center gap-1",
              // On the chosen row's tint everything in the meta takes the row's ink, over a
              // caller's own colour classes: a muted outline Badge's grey is under 4.5:1 there. Its
              // edges go to the ink at /50, so an outline still reads. Web only — a device has no
              // descendant selector, so there icons follow through the context below and a node's
              // own text keeps its colour (see `meta`).
              isSelected && "text-foreground [&_*]:text-foreground! [&_*]:border-foreground/50!",
            )}
          >
            <IconClassContext.Provider value={cn("size-4 shrink-0", muted)}>
              {asText(facts, cn("text-xs tabular-nums", muted))}
            </IconClassContext.Provider>
          </div>
        ) : null}
      </>
    );

    let row: ReactElement;
    if (isFile === false) {
      const expanded = isOpen(node.path);
      row = (
        <CollapsibleTrigger
          data-slot="file-tree-folder"
          open={expanded}
          onClick={() => toggle(node.path)}
          controls={expanded && node.children.length > 0 ? childrenId(node.path) : undefined}
          className={rowClass}
          // Centred on the row rather than set down to a first line of text, and muted as the
          // folder's icon is.
          chevronClassName={cn("mt-0", muted)}
          style={indent}
          webProps={drag}
          contentSlot={inside}
        />
      );
    } else if (linkSlot) {
      // `drag` is what picks the row up, which only the web has.
      row = rowLink(
        linkSlot(node),
        {
          slot: "file-tree-file",
          className: rowClass,
          selected: isSelected,
          style: indent,
          webProps: drag,
        },
        inside,
      );
    } else if (onSelect) {
      row = (
        <button
          type="button"
          data-slot="file-tree-file"
          aria-current={isSelected ? true : undefined}
          onClick={() => onSelect(node.entry?.path ?? node.path, node)}
          className={cn("cube-rn-view cube-rn-pressable", rowClass)}
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
          className={cn("cube-rn-view", rowClass)}
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
          rowFillClass(isSelected, pressable),
          // A slow move is not a failed one: the row waits where it was, drawn as unavailable.
          moving.has(nodeKey(node)) && "opacity-50",
        )}
      >
        {row}
        {actions ? (
          <div
            data-slot="file-tree-action"
            className={cn(
              "cube-rn-view",
              "shrink-0 flex-row items-center pr-1",
              // The rhythm's action gap: 4px between the `icon-xs` buttons a tree row takes.
              actionGap(actions),
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
        // A file and a folder can share a path (see `buildTree`).
        key={`${node.type}:${node.path}`}
        data-slot="file-tree-item"
        className={cn(
          "cube-rn-view",
          "min-w-0 gap-0.5",
          node.type === "dir" && dropInto === node.path && DROP_TARGET_CLASS,
        )}
        {...(canDrop && node.type === "dir" ? dropProps(node.path) : {})}
      >
        {renderRow(node, depth, node.type === "file")}
        {node.type === "dir" && node.children.length > 0 && isOpen(node.path) ? (
          <ul
            data-slot="file-tree-children"
            id={childrenId(node.path)}
            className="cube-rn-view min-w-0 gap-0.5"
          >
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

export type { FileTreeProps };
