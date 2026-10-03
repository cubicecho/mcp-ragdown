import type { ReactNode } from "react";
import * as React from "react";
import {
  type HeaderContentFooterProps,
  StickyHeaderContentFooter,
} from "@/components/header-content-footer";
import { Badge } from "@/components/ui/badge";
import { IconClassContext } from "@/components/ui/icons-base";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
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

/**
 * Hidden under the breakpoint, shown from it up. `flex` is what the root is on both platforms: a
 * compiled view is a flex column by its reset, and every view on device is one already.
 *
 * Literal classes rather than a composed one, per rule 3: Tailwind's scanner reads source text, so
 * `` `${bp}:flex` `` names a class that is never generated. It is a media query in the stylesheet,
 * not one in JavaScript, so the first paint is already right — no frame with the rail drawn and
 * then taken away.
 */
const HIDE_BELOW = {
  sm: "hidden sm:flex",
  md: "hidden md:flex",
  lg: "hidden lg:flex",
  xl: "hidden xl:flex",
} as const;

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
  /**
   * Under this width the sidebar is not drawn at all; from it up, it is. For a rail that has no
   * room on a phone, where the page puts its furniture in a bar of its own instead. Absent, it is
   * drawn at every width.
   *
   * Hidden is `display: none`, so it leaves the accessibility tree too, rather than staying a
   * landmark with nothing visible in it.
   *
   * Inside a `SidebarLayout`, pass `sidebarHideBelow` to the layout instead: it hides the pane at
   * the same breakpoint and draws the bar that stands in for the rail, from the one value.
   */
  hideBelow?: keyof typeof HIDE_BELOW | undefined;
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
 *
 * **`hideBelow` is its narrow-width answer.** A rail is not a pane that stacks, so under a phone's
 * width it goes rather than landing on top of the page. `hidden md:flex` in `className` did the
 * same only while the root's display came from a class merged before the caller's; these are the
 * same two classes, owned here. Inside a `SidebarLayout` the layout's `sidebarHideBelow` is the
 * same switch one level up — it hides the pane rather than leaving an empty one, and draws the
 * bar that stands in for the rail under the same breakpoint.
 */
export function Sidebar({
  content,
  header,
  footer,
  label,
  side = "start",
  hideBelow,
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
        hideBelow ? HIDE_BELOW[hideBelow] : undefined,
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

/**
 * A section is a navigation landmark (`as="nav"`, which `label` can name) or it is not, and a
 * `label` with no landmark to name is a type error rather than a name nothing reads.
 */
type SidebarSectionLandmarkProps =
  | {
      /**
       * `nav` makes the section a navigation landmark — `<nav>` on the web, `role="navigation"` on
       * device — so a screen reader's landmark jump reaches its rows. For the sections that are
       * the app's navigation; a list of recent items or pinned searches stays out of it.
       */
      as: "nav";
      /**
       * What the landmark is called — "Main", "Projects". Absent, the `title` names it; give one
       * when there is no title, or when two navigation sections would otherwise share a name.
       */
      label?: string | undefined;
    }
  | { as?: undefined; label?: never };

export type SidebarSectionProps = SidebarSectionLandmarkProps & {
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
 *
 * **`as="nav"` makes it the navigation landmark.** `Sidebar` is a complementary `<aside>`, and
 * nothing in a sidebar of links is otherwise navigation, so a landmark jump never reached the rows
 * and every app wrapped the section in a hand-written `<nav aria-label>`. The whole section is the
 * landmark — title, status and list — named by the title unless `label` says otherwise.
 */
export function SidebarSection({
  as,
  label,
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
  const sectionClassName = cn("min-w-0 gap-1", className);

  const body = (
    <>
      {title || action ? (
        <div
          data-slot="sidebar-section-heading"
          className="cube-rn-view min-h-8 min-w-0 flex-row items-center gap-2 px-2"
        >
          <div className="cube-rn-view min-w-0 flex-1">
            {title ? (
              // biome-ignore lint/a11y/useSemanticElements: React Native has no heading element; role="heading" is the cross-platform form
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
    </>
  );

  // Two roots written out rather than one with a chosen role: the compiler picks the tag from the
  // role, and a role it cannot read is one it refuses.
  if (as === "nav") {
    return (
      <nav
        data-slot="sidebar-section"
        {...(label ? { "aria-label": label } : title ? { "aria-labelledby": titleId } : {})}
        className={cn("cube-rn-view", sectionClassName)}
      >
        {body}
      </nav>
    );
  }

  return (
    <div data-slot="sidebar-section" className={cn("cube-rn-view", sectionClassName)}>
      {body}
    </div>
  );
}

type PressableProps = React.ComponentPropsWithoutRef<"button">;

/**
 * A row's status: words, and the glyph that stands for them. An object rather than a node because
 * the words have to reach the row's accessible name on device, and a node's text cannot be read
 * back out into an `accessibilityLabel`.
 */
export type SidebarNavItemStatus = {
  /** What is read, and what is drawn when there is no `icon`. */
  label: string;
  /** What is drawn instead of the label. Decorative: the label is what a screen reader hears. */
  icon?: ReactNode | undefined;
};

/** Off the screen and still read. `sr-only` is a clip, which the device does not have. */
const SR_ONLY = "sr-only";

/** What both forms of the row take. */
type SidebarNavItemBaseProps = Omit<PressableProps, "children" | "className" | "style"> & {
  /** What the row is called. Truncated to one line, never wrapped. */
  label: string;
  /** Before the label. Pass a bare `<Folder />`; the row sizes and colours it. */
  icon?: ReactNode | undefined;
  /** At the far end: how many things are behind the row. */
  count?: number | string | undefined;
  /**
   * What state the row's thing is in — "MCP on", "offline", "draft" — drawn before the `count`.
   * `label` is required because it is what is read: the row's name becomes "Work, MCP on, 2". With
   * an `icon` the icon is what is seen and the label is read only; without one the label is drawn,
   * small and muted. `SidebarSection`'s `status` is the same word for the section's own state.
   */
  status?: SidebarNavItemStatus | undefined;
  // Re-declared rather than inherited, for `exactOptionalPropertyTypes` — see `segmented.tsx`.
  className?: string | undefined;
};

/** The row that goes somewhere, and says where itself. */
type SidebarNavItemLinkProps = {
  /** Where the row goes. The `<a href>` on the web. */
  href: string;
  /** The row for the page on screen — filled, and `aria-current="page"`. */
  active?: boolean | undefined;
};

/**
 * The row that goes somewhere a router link wrapping it names — TanStack's `createLink`, or
 * expo-router's `<Link href asChild>`. Both hand the row its `href` and its press handler at
 * render, so writing either here as well is the destination said twice, and two copies that can
 * drift: the `<a href>` middle-click opens and the route the click goes to.
 *
 * No handler of its own for the same reason: a row with no `href` that *does* take one is the
 * button below, and a row with both `onPress` and `active` is neither.
 */
type SidebarNavItemRouterLinkProps = {
  href?: undefined;
  /** The row for the page on screen — filled, and `aria-current="page"`. */
  active?: boolean | undefined;
  onClick?: never;
};

/**
 * The row that does something — Sign out. No `href`, so no `active`: a button is never the page
 * on screen, and `aria-current` on one would say it was.
 */
type SidebarNavItemButtonProps = {
  href?: never;
  active?: never;
  /** What the row does. Required: it is what tells a button row from a router's link row. */
  onClick: NonNullable<React.ComponentPropsWithoutRef<"button">["onClick"]>;
};

/**
 * A row is a link (`href`, and `active` for the current page), a link whose router supplies the
 * `href`, or a button (`onPress`, never `active`). `onPress` is what tells the last two apart, so
 * `active` on a button is a type error rather than a row that is quietly half of each.
 */
export type SidebarNavItemProps = SidebarNavItemBaseProps &
  (SidebarNavItemLinkProps | SidebarNavItemRouterLinkProps | SidebarNavItemButtonProps);

/** The row's box, the same for both forms — the classes a hand-drawn Sign out row used to copy. */
function rowClassName(active: boolean, className: string | undefined) {
  return cn(
    "min-h-8 min-w-0 flex-row items-center gap-2 rounded-md px-2 py-1.5 transition-colors",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
    // The web half's icons size from here, as a `Button`'s do; device's from the context below.
    "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
    active
      ? "bg-selection text-selection-foreground"
      : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
    className,
  );
}

type SidebarNavItemBodyProps = {
  label: string;
  icon: ReactNode | undefined;
  count: number | string | undefined;
  status: SidebarNavItemStatus | undefined;
  active: boolean;
};

/** What is inside the row, the same for both forms: icon, label, status, count. */
function SidebarNavItemBody({ label, icon, count, status, active }: SidebarNavItemBodyProps) {
  // Native inherits no colour, so the label, the count and the icon each carry it. The active
  // count takes the row's foreground rather than muted: muted on the selection fill is under 4.5:1.
  const text = active ? "text-selection-foreground" : "text-sidebar-foreground";
  const muted = active ? "text-selection-foreground" : "text-muted-foreground";

  return (
    <>
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
      {status?.icon ? (
        <div data-slot="sidebar-nav-item-status-icon" aria-hidden className="cube-rn-view shrink-0">
          <IconClassContext.Provider value={cn("size-4 shrink-0", muted)}>
            {status.icon}
          </IconClassContext.Provider>
        </div>
      ) : null}
      {/* With an icon the words are read and not seen: a clip, as a loading page title's is. */}
      {status ? (
        <span
          data-slot="sidebar-nav-item-status"
          className={cn("cube-rn-text", "shrink-0 text-xs", status.icon ? SR_ONLY : muted)}
        >
          {status.label}
        </span>
      ) : null}
      {count === undefined ? null : (
        <span
          data-slot="sidebar-nav-item-count"
          className={cn("cube-rn-text", "shrink-0 text-xs tabular-nums", muted)}
        >
          {count}
        </span>
      )}
    </>
  );
}

/**
 * One row of a sidebar: a link with an optional icon, a label that truncates, an optional
 * `status` and an optional count. The current page is filled with `selection`, as every chosen
 * control is; hover fills it from `sidebar-accent`.
 *
 * Wrap it in the router's own link rather than passing a router to it:
 *
 * ```tsx
 * <Link href={`/projects/${id}`} asChild>
 *   <SidebarNavItem label={name} active={id === current} />
 * </Link>
 *
 * const SidebarLink = createLink(SidebarNavItem); // TanStack Router
 * <SidebarLink to="/" label="Documents" active={isCurrent} />
 * ```
 *
 * `Link asChild` clones its child with the `href` and the press handler, and `createLink` renders
 * it with both; this forwards the ref and every prop it does not name to the `Pressable`, which is
 * what lets them land. So neither passes `href` to the row — the router's is the one destination,
 * and the row is a real `<a href>` all the same. A router that hands out only a click handler —
 * react-router's `useLinkClickHandler` — passes it as `onClick` beside the row's own `href`.
 *
 * `role="link"` is what makes it a link on both platforms: TalkBack and VoiceOver say "link", and
 * the compiler emits an `<a>`. The current page is said twice, for the same reason `segmented`
 * says its pill twice — `accessibilityState` on device, `aria-current="page"` on the web, which is
 * the one spelling a web screen reader reads and the one react-native-web would have dropped.
 *
 * **With `onPress` and no `href` it is a button** — `onClick` on the web, and no `active`.
 * That is the footer's Sign out: drawn like the Settings row above it, but it does something
 * rather than going somewhere, so it is `role="button"` on device and a `<button type="button">`
 * on the web, and never carries `aria-current`. What decides the element is the `href` the row
 * *renders* with, so a router's row is a link however it was written; a row written with neither
 * and no router around it has nowhere to go and nothing to do, and is drawn as an inert button.
 *
 * ```tsx
 * <SidebarNavItem label="Sign out" icon={<LogOut />} onPress={signOut} />
 * ```
 */
const SidebarNavItem = React.forwardRef<HTMLButtonElement, SidebarNavItemProps>(
  ({ href, label, icon, count, status, active = false, className, ...props }, ref) => {
    // Two elements written out rather than one with a chosen role: the compiler picks the tag from
    // the role, and a button and a link do not share a prop list anyway.
    if (href === undefined) {
      return (
        <button
          type="button"
          ref={ref as React.Ref<HTMLButtonElement>}
          className={cn("cube-rn-view cube-rn-pressable", rowClassName(false, className))}
          {...(props as React.ComponentPropsWithoutRef<"button">)}
        >
          <SidebarNavItemBody
            label={label}
            icon={icon}
            count={count}
            status={status}
            active={false}
          />
        </button>
      );
    }

    return (
      <a
        ref={ref as React.Ref<HTMLAnchorElement>}
        // React Native has no `href` and no `aria-current`; the web has both, and needs both. The
        // web names the row from the text inside it; device reads a pressable as one element, so
        // its name is joined here — before `props`, so a caller's own label still wins.
        href={href}
        aria-current={active ? "page" : undefined}
        className={cn("cube-rn-view cube-rn-pressable", rowClassName(active, className))}
        {...(props as React.ComponentPropsWithoutRef<"a">)}
      >
        <SidebarNavItemBody
          label={label}
          icon={icon}
          count={count}
          status={status}
          active={active}
        />
      </a>
    );
  },
);
SidebarNavItem.displayName = "SidebarNavItem";

export type BarNavItemProps = Omit<PressableProps, "children" | "className" | "style"> & {
  /**
   * What the place is called. Nothing draws it, so it is the link's accessible name — an icon with
   * no name is announced as "link" — and the tooltip a pointer or a long press brings up.
   */
  label: string;
  /** The whole of what is drawn. Pass a bare `<Folder />`; the item sizes and colours it. */
  icon: ReactNode;
  /**
   * Where it goes — the `<a href>` on the web. Left out when a router's link names it: TanStack's
   * `createLink`, or expo-router's `<Link href asChild>`, both of which hand it the `href`.
   */
  href?: string | undefined;
  /** The item for the page on screen — filled, and `aria-current="page"`. */
  active?: boolean | undefined;
  /**
   * How many things are behind the place, as a small badge on the icon's corner and in the name:
   * "Skills, 12". The badge has a corner to fit in, so cap a long one where it is passed — `"99+"`.
   */
  count?: number | string | undefined;
  /**
   * What state the place's thing is in, as a dot on the icon's other corner and in the name:
   * "Servers, 2 failing". The same object `SidebarNavItem` takes, so one array feeds both; the bar
   * has room for neither its words nor its `icon`, so the dot is all that is drawn and the `label`
   * is what is read.
   */
  status?: SidebarNavItemStatus | undefined;
  // Re-declared rather than inherited, for `exactOptionalPropertyTypes` — see `segmented.tsx`.
  className?: string | undefined;
};

/**
 * A place in the bar: `SidebarNavItem` with only its icon drawn, for `SidebarLayout`'s `nav` (and
 * `TopBarLayout`'s), where a row's label has no room.
 *
 * It takes the row's props — `label`, `icon`, `active`, `count`, `status`, `href` — so an app's
 * list of places is one array rendered twice, once into the rail and once into the bar:
 *
 * ```tsx
 * const BarLink = createLink(BarNavItem); // beside createLink(SidebarNavItem)
 * nav={places.map((p) => (
 *   <BarLink key={p.to} to={p.to} label={p.label} icon={p.icon} count={p.count} active={…} />
 * ))}
 * ```
 *
 * Every app drew this by hand, as a router link with a class string, and the copies drifted on the
 * three things that matter. **The name**: an icon-only link has none unless it is given one, so
 * `label` is required, and it is also the tooltip, since the icon is all a sighted user has. **The
 * current one**: filled with `selection` and `aria-current="page"`, where the copies used the grey
 * that means hover. **The count**: a row's count had nowhere to go on the bar, so the bar dropped
 * it — here it is a badge on the icon, a `status` is a dot, and both are in the name the way the
 * row builds it: "Skills, MCP on, 12".
 *
 * It binds to a router exactly as the row does — it forwards its ref and every prop it does not
 * name to the `Pressable`, so `createLink` and `<Link href asChild>` hand it the `href` and the
 * press handling, and react-router's `useLinkClickHandler` goes in as `onClick` beside an `href`.
 *
 * It is always a link. The bar's buttons — the theme switch, sign out — are `ActionButton`s in the
 * bar's `action`, not places in its `nav`.
 *
 * **The provider.** It renders its own `TooltipProvider`, as `ActionButton` does and for the same
 * reason: an installed component cannot assume the app has one at its root.
 */
const BarNavItem = React.forwardRef<HTMLButtonElement, BarNavItemProps>(
  ({ href, label, icon, count, status, active = false, className, ...props }, ref) => {
    // Native inherits no colour, so the icon carries its own; the web half's takes the link's.
    const text = active ? "text-selection-foreground" : "text-muted-foreground";

    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <a
              ref={ref as React.Ref<HTMLAnchorElement>}
              data-slot="bar-nav-item"
              // Nothing inside is text, so the name is written out on both platforms — joined the
              // way the row's is, and before `props`, so a caller's own label still wins.
              aria-label={[label, status?.label, count]
                .filter((part) => part !== undefined)
                .join(", ")}
              // React Native has no `href` and no `aria-current`; the web has both, and needs both.
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "cube-rn-view cube-rn-pressable",
                "relative size-8 shrink-0 items-center justify-center rounded-md transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
                active
                  ? "bg-selection text-selection-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                className,
              )}
              {...(props as React.ComponentPropsWithoutRef<"a">)}
            >
              <IconClassContext.Provider value={cn("size-4 shrink-0", text)}>
                {icon}
              </IconClassContext.Provider>
              {count === undefined ? null : (
                // Hung off the item's top corner, in the 8px the icon leaves above it, so the count
                // sits over the glyph's corner rather than over the glyph — and by little enough
                // that it never reaches a neighbour's icon. The ring in the bar's own fill is what
                // keeps it apart from what is under it. The text is its own element because a
                // badge's label is 12px on a 16px line, which is taller than that corner.
                <Badge
                  variant="secondary"
                  className="-right-1.5 -top-1.5 absolute border-background px-1 py-0"
                >
                  <span className="cube-rn-text font-medium text-[10px] text-secondary-foreground leading-3 tabular-nums">
                    {count}
                  </span>
                </Badge>
              )}
              {status ? (
                // No label on the dot: it is decoration, and the words are in the link's name.
                <Badge className="-bottom-0.5 -right-0.5 absolute h-2.5 w-2.5 border-background" />
              ) : null}
            </a>
          </TooltipTrigger>
          <TooltipContent side="bottom">{label}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  },
);
BarNavItem.displayName = "BarNavItem";

export { BarNavItem, SidebarNavItem };
