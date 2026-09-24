import type { ReactNode } from "react";
import * as React from "react";
import {
  type HeaderContentFooterProps,
  StickyHeaderContentFooter,
} from "@/components/header-content-footer";
import { IconClassContext } from "@/components/ui/icons-base";
import { cn } from "@/lib/utils";

/**
 * A chassis slot laid out as a column with gaps between what it holds.
 *
 * The chassis keeps its slots the block boxes a web caller expects (`SLOT` there), which is right
 * for a page header and wrong here: a sidebar's header is a brand and a button stacked, and its
 * footer a column of rows, so both want the gap a flex column gives. On device every view is
 * already one.
 */
const STACK = "flex flex-col";

export type SidebarProps = {
  /** The body: sections, rows, whatever the rail lists. The only part that scrolls. */
  content: ReactNode;
  /** The brand, a primary action. Stays put while the body scrolls. Absent, no row is drawn. */
  header?: ReactNode | undefined;
  /** Quiet rows — settings, sign out, the account. Drawn over a hairline. */
  footer?: ReactNode | undefined;
  /**
   * What the sidebar is called — "Main", "Projects". It names the `<aside>` on the web, which is
   * what tells a screen reader's landmark list one complementary region from another.
   */
  label?: string | undefined;
  /**
   * Which edge of the screen the sidebar sits against, which decides the edge its border is on.
   * `start` (the default) draws it on the right, facing the content.
   */
  side?: "start" | "end" | undefined;
  /** The scrolling body, for restoring a scroll position — see `HeaderContentFooter`. */
  contentRef?: HeaderContentFooterProps["contentRef"];
  /** On the root. A different width is a `w-*` here. */
  className?: string | undefined;
  headerClassName?: string | undefined;
  contentClassName?: string | undefined;
  footerClassName?: string | undefined;
};

/**
 * The sidebar frame: header, a body that scrolls, footer, on the sidebar palette.
 *
 * **Fixed width, `w-64`.** A navigation rail's width is set by the longest name it has to show,
 * not by the window, so it does not grow with the screen — shadcn's own sidebar is the same
 * `16rem`. Inside a `SidebarLayout`, pass `sidebarWidth="auto"` so the pane is as wide as this and
 * no wider; a narrower or wider rail is one `w-*` in `className`, not a width scale of its own.
 *
 * **It draws its own border**, in `sidebar-border`, on the edge that faces the content. That is
 * the one thing `SidebarLayout`'s `divider="line"` warns against — but a sidebar that sits beside
 * the content at every width is not a pane that stacks, and the border is part of the palette the
 * sidebar owns. Under a layout that does stack, use `divider="none"` and `className="border-r-0"`
 * and let the layout draw the rule, or leave the layout at `stackBelow="never"`.
 *
 * It needs a height, like any sticky chassis: `h-full`, so the ancestors up to the viewport have
 * to give it one or the body grows instead of scrolling.
 */
export function Sidebar({
  content,
  header,
  footer,
  label,
  side = "start",
  contentRef,
  className,
  headerClassName,
  contentClassName,
  footerClassName,
}: SidebarProps) {
  return (
    // `complementary` rather than `webAs="aside"`: it is the same `<aside>` once compiled, and it
    // is also what react-native-web renders, where a bare `div` would carry an `aria-label` that
    // ARIA prohibits on an element with no role.
    <aside
      data-slot="sidebar"
      aria-label={label}
      className={cn(
        "cube-rn-view",
        "h-full w-64 min-h-0 shrink-0 border-sidebar-border bg-sidebar",
        side === "start" ? "border-r" : "border-l",
        className,
      )}
    >
      <StickyHeaderContentFooter
        header={header}
        content={content}
        footer={footer}
        contentRef={contentRef}
        // `flex-1` rather than the preset's `h-full` alone: the frame's own border is inside its
        // height, and a percentage height would overflow it by the border's width.
        className="min-h-0 flex-1"
        headerClassName={cn(STACK, "gap-2 p-3", headerClassName)}
        contentClassName={cn(STACK, "gap-4 p-2", contentClassName)}
        footerClassName={cn(STACK, "gap-0.5 border-sidebar-border border-t p-2", footerClassName)}
      />
    </aside>
  );
}

export type SidebarSectionProps = {
  /** The overline over the rows. A short noun — "Projects", "Pinned". */
  title?: ReactNode | undefined;
  /**
   * The rows, as an array — `projects.map(…)`, each with its `key`. Each one becomes an item of
   * the list, so pass the rows themselves rather than a fragment or a wrapper around them: a
   * wrapper would be one item holding every row.
   */
  content?: ReactNode | undefined;
  /**
   * What the section says instead of rows, or before them: failed, loading, empty. Drawn between
   * the title and the list, so it is the place for a `<QueryState compact … />`, which renders
   * nothing once there are rows.
   */
  status?: ReactNode | undefined;
  /** The title row's far end: an add button, a filter. */
  action?: ReactNode | undefined;
  /**
   * The title's heading rank. `2` by default — the sidebar sits beside the page, not under its
   * `h1`. Pick it by structure, never by size; the text is the same at every level.
   */
  level?: 1 | 2 | 3 | 4 | 5 | 6 | undefined;
  className?: string | undefined;
  /** On the list the rows are items of. */
  contentClassName?: string | undefined;
};

/**
 * A titled list of rows in a sidebar.
 *
 * The rows are a real list — `role="list"` and `role="listitem"`, a `<ul>` and its `<li>`s on the
 * web — named by the title, so a screen reader says "Projects, list, 12 items" before the first
 * row rather than reading twelve links with nothing to say where they end. The items are drawn
 * here rather than by `SidebarNavItem`, because the same row stands alone in a footer, where an
 * item with no list around it is markup axe rejects.
 *
 * The title is `Section`'s overline at a rail's inset, not `Section` itself: a section's body is
 * fields with a gap between them, and a sidebar's is rows that butt up against one another.
 *
 * No list is drawn when there are no rows, so an empty or loading section is the title and its
 * `status` and nothing else — not an empty `<ul>` announced as "list, 0 items".
 */
export function SidebarSection({
  title,
  content,
  status,
  action,
  level = 2,
  className,
  contentClassName,
}: SidebarSectionProps) {
  const titleId = React.useId();
  const rows = React.Children.toArray(content);

  return (
    <div data-slot="sidebar-section" className={cn("cube-rn-view", "min-w-0 gap-1", className)}>
      {title || action ? (
        <div
          data-slot="sidebar-section-heading"
          className="cube-rn-view min-h-8 min-w-0 flex-row items-center gap-2 px-2"
        >
          <div className="cube-rn-view min-w-0 flex-1">
            {title ? (
              <span
                data-slot="sidebar-section-title"
                id={titleId}
                role="heading"
                aria-level={level}
                className="cube-rn-text truncate font-semibold text-muted-foreground text-xs uppercase tracking-wide"
              >
                {title}
              </span>
            ) : null}
          </div>
          {action ? (
            <div data-slot="sidebar-section-action" className="cube-rn-view shrink-0">
              {action}
            </div>
          ) : null}
        </div>
      ) : null}

      {status}

      {rows.length > 0 ? (
        <ul
          data-slot="sidebar-section-list"
          {...(title ? { "aria-labelledby": titleId } : {})}
          className={cn("cube-rn-view", "min-w-0 gap-0.5", contentClassName)}
        >
          {rows.map((row, index) => (
            <li
              // `toArray` has already keyed every element from the caller's own keys.
              key={React.isValidElement(row) && row.key !== null ? row.key : index}
              data-slot="sidebar-section-item"
              className="cube-rn-view min-w-0"
            >
              {row}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export type SidebarNavItemProps = Omit<
  React.ComponentPropsWithoutRef<"button">,
  "children" | "className" | "style"
> & {
  /** Where the row goes. The `<a href>` on the web; a router `Link` wrapping it supplies it too. */
  href: string;
  /** What the row is called. Truncated to one line, never wrapped. */
  label: string;
  /** Before the label. Pass a bare `<Folder />`; the row sizes and colours it. */
  icon?: ReactNode | undefined;
  /** At the far end: how many things are behind the row. */
  count?: number | string | undefined;
  /** The row for the page on screen — filled, and `aria-current="page"`. */
  active?: boolean | undefined;
  // Re-declared rather than inherited, for `exactOptionalPropertyTypes` — see `segmented.tsx`.
  className?: string | undefined;
};

/**
 * One row of a sidebar: a link with an optional icon, a label that truncates, and an optional
 * count, filled from `sidebar-accent` when it is the current page and on hover.
 *
 * Wrap it in the router's own link rather than passing a router to it:
 *
 * ```tsx
 * <Link href={`/projects/${id}`} asChild>
 *   <SidebarNavItem href={`/projects/${id}`} label={name} active={id === current} />
 * </Link>
 * ```
 *
 * `Link asChild` clones its child with the press handler, and this forwards the ref and every prop
 * it does not name to the `Pressable`, which is what lets the clone land. On a DOM app whose router
 * link has no `asChild`, pass the router's click handler as `onClick` — react-router's
 * `useLinkClickHandler`, TanStack's `createLink` — and the `<a href>` is already there.
 *
 * `role="link"` is what makes it a link on both platforms: TalkBack and VoiceOver say "link", and
 * the compiler emits an `<a>`. The current page is said twice, for the same reason `segmented`
 * says its pill twice — `accessibilityState` on device, `aria-current="page"` on the web, which is
 * the one spelling a web screen reader reads and the one react-native-web would have dropped.
 */
const SidebarNavItem = React.forwardRef<HTMLButtonElement, SidebarNavItemProps>(
  ({ href, label, icon, count, active = false, className, ...props }, ref) => {
    // Native inherits no colour, so the label, the count and the icon each carry it. The active
    // count takes the row's foreground rather than muted: muted on the accent fill is under 4.5:1.
    const text = active ? "text-sidebar-accent-foreground" : "text-sidebar-foreground";

    return (
      <a
        ref={ref as React.Ref<HTMLAnchorElement>}
        // React Native has no `href` and no `aria-current`; the web has both, and needs both.
        href={href}
        aria-current={active ? "page" : undefined}
        className={cn(
          "cube-rn-view cube-rn-pressable",
          "min-h-8 min-w-0 flex-row items-center gap-2 rounded-md px-2 py-1.5 transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
          // The web half's icons size from here, as a `Button`'s do; device's from the context below.
          "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
          active
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
          className,
        )}
        {...(props as React.ComponentPropsWithoutRef<"a">)}
      >
        {icon ? (
          <IconClassContext.Provider value={cn("size-4 shrink-0", text)}>
            {icon}
          </IconClassContext.Provider>
        ) : null}
        <span
          data-slot="sidebar-nav-item-label"
          className={cn(
            "cube-rn-text",
            "min-w-0 flex-1 truncate text-sm",
            active && "font-medium",
            text,
          )}
        >
          {label}
        </span>
        {count === undefined ? null : (
          <span
            data-slot="sidebar-nav-item-count"
            className={cn(
              "cube-rn-text",
              "shrink-0 text-xs tabular-nums",
              active ? "text-sidebar-accent-foreground" : "text-muted-foreground",
            )}
          >
            {count}
          </span>
        )}
      </a>
    );
  },
);
SidebarNavItem.displayName = "SidebarNavItem";

export { SidebarNavItem };
