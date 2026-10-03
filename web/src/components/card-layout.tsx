import type { ReactNode } from "react";
import { Children } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

export type CardLayoutProps = {
  /** The body. */
  content?: ReactNode | undefined;
  /**
   * A string, a heading, whatever names the card. Absent, no header row is drawn. On device it is
   * rendered inside a `Text`, so pass text or inline text nodes.
   */
  title?: ReactNode | undefined;
  /**
   * Which heading the title is, `1 | 2 | 3` — 3 by default, a card under a page title. A card that
   * *is* the page (a sign-in, a token gate, a lone settings panel) passes `1`, so the page has an
   * `<h1>`. The title is the same size at every level: pick the rank by where it sits.
   */
  level?: 1 | 2 | 3 | undefined;
  /** One line on what the card holds, or what changing it costs. */
  description?: ReactNode | undefined;
  /**
   * Sits before the title. On the web it is sized to the text — pass a bare `<Plus />`. On device
   * an icon cannot be sized from outside it, so pass it at the size you want.
   */
  icon?: ReactNode | undefined;
  /** The header's far end: an add button, a menu, a switch. */
  action?: ReactNode | undefined;
  /** Shown instead of `content` when there is nothing in it — an empty list, no results. */
  empty?: ReactNode | undefined;
  /**
   * Whether the body is still being fetched. On, a skeleton stands in for it and `empty` is not
   * consulted — data that has not arrived is not data that came back empty, and a card that says
   * "no members yet" for half a second before showing four of them is worse than one that waits.
   *
   * A caller wanting its own placeholder passes it as `content` and leaves this off.
   */
  loading?: boolean | undefined;
  /** The footer's start. A timestamp, a note, a destructive action held away from the rest. */
  footer?: ReactNode | undefined;
  /** The footer's end. The buttons. Given alone, the footer is simply right-aligned. */
  footerActions?: ReactNode | undefined;
  className?: string | undefined;
  headerClassName?: string | undefined;
  contentClassName?: string | undefined;
  footerClassName?: string | undefined;
};

/** Sized from outside on the web; see the file comment for the device. */
const ICON = "[&_svg]:size-4";

/**
 * A wrapper around a caller's node, not layout of its own: a block box on the web, where a compiled
 * view would otherwise be a flex column and lay a sentence and its link out as two rows.
 */
const SLOT = "block";

/** A bar standing in for text that has not arrived — `Skeleton`'s look, on both platforms. */
const BAR = cn("h-4 rounded-md bg-accent", "animate-pulse");

/**
 * A string slot's colour, on every platform. The compiled half would inherit the card's, but
 * react-native-web is web too and gives every `Text` its own black `color`.
 */
const INK = "text-card-foreground";

/**
 * The header, as a row that wraps: the title and description in one column, the action after it.
 *
 * The action used to be `CardAction`, which is absolute and so reserves no width — right for the
 * badge or lone button it was written for, and wrong for anything wider, because a long title ran
 * on underneath it. `CardAction` cannot be given a place in the flow instead: `CardHeader` is a
 * column whose children are the title and the description, as shadcn's is, and Yoga has no grid
 * to put a third child beside them. So the shell that owns this header's children lays them out,
 * and the primitive stays as it is for a card composed by hand.
 *
 * `items-start` keeps the action in the corner `CardAction` held: level with the top of the
 * title, at the far end. `gap-y-1.5` is `CardHeader`'s own gap, for the action's line once it has
 * wrapped.
 */
const HEADER = "flex-row flex-wrap items-start gap-x-4 gap-y-1.5";

/**
 * The header's text. `basis-40` is the floor the header wraps on: the title keeps 10rem beside
 * the action or the action goes under it. Less than `Section`'s, because a card title truncates
 * and so can give up more before it stops naming the card — and because the lower the floor, the
 * narrower the card in which a single button still sits where it always did.
 */
const HEADER_TEXT = "min-w-0 flex-1 basis-40 gap-1.5";

/**
 * The header's action, never shrunk and never wider than the header: on a line of its own, a
 * fragment of controls wraps on this row instead of running out of the card.
 */
const HEADER_ACTION = cn(
  "max-w-full shrink-0 flex-row flex-wrap items-center gap-2",
  // The caller's own wrapping row, in a browser: a flex item there is as wide as its content and
  // a react-native-web view does not shrink, so without this it runs out of the card. Yoga
  // measures a child against its parent's width, and NativeWind has no child selector anyway.
  "[&>*]:max-w-full",
);

/**
 * The `footerActions` row. It shrinks to the footer and wraps rather than holding its buttons on
 * one line: a view does not shrink by default on either half, so three buttons in a phone-width
 * card ran past its left edge instead of moving the last one down. `justify-end` keeps a wrapped
 * line against the right edge, where the primary action is.
 */
const ACTIONS = "min-w-0 shrink flex-row flex-wrap items-center justify-end gap-2";

/** A string on its own is a crash on device, so a string slot gets a `Text` around it. */
function asText(node: ReactNode) {
  return typeof node === "string" || typeof node === "number" ? (
    <span className={cn("cube-rn-text", INK)}>{node}</span>
  ) : (
    node
  );
}

/**
 * A card with its slots already placed.
 *
 * The shape is the one every card in these apps arrives at on its own — an icon and a title, a
 * line of description under it, an action at the far end of the header, a body, and a footer
 * that holds the buttons — and writing it out each time is how they drift: some put the action
 * beside the title and some under it, some give the description a `text-sm` and some a `text-xs`,
 * and a card with nothing to show says so in a different voice on every screen.
 *
 * Every slot is a node, `content` included, so a card is one element at the call site and the
 * question "where does this go?" has one answer per prop. `empty` and `loading` are the two that
 * are not slots the caller places: they are what the body says when the data came back empty, and
 * while it has not come back at all. A list rendered from a `map` reaches the first state on its
 * own the moment its array is empty.
 */
export function CardLayout({
  content,
  title,
  level = 3,
  description,
  icon,
  action,
  empty,
  loading = false,
  footer,
  footerActions,
  className,
  headerClassName,
  contentClassName,
  footerClassName,
}: CardLayoutProps) {
  // `Children.count` rather than a truth test: `{items.map(…)}` on an empty array is an empty
  // array, not null, and it is the shape a card is nearly always handed.
  const isEmpty = Children.count(content) === 0;
  const body = loading ? <CardLayoutSkeleton /> : isEmpty && empty ? asText(empty) : content;

  const hasText = Boolean(title || description);
  const hasHeader = Boolean(hasText || action);
  const hasFooter = Boolean(footer || footerActions);

  return (
    <Card data-slot="card-layout" className={className}>
      {hasHeader ? (
        <CardHeader className={cn(HEADER, !hasText && "justify-end", headerClassName)}>
          {hasText ? (
            <div className={cn("cube-rn-view", HEADER_TEXT)}>
              {title ? (
                // The icon sits beside the heading rather than inside it: a heading is a `Text`,
                // and a view inside a `Text` is not something the device lays out.
                <div className="cube-rn-view min-w-0 flex-row items-center gap-2">
                  {icon ? (
                    // Sized here rather than by the caller, so an icon passed as `<Plus />` and
                    // one passed as `<Plus className="size-4" />` land at the same size.
                    <div className={cn("cube-rn-view", "shrink-0 text-muted-foreground", ICON)}>
                      {icon}
                    </div>
                  ) : null}
                  {/* The padding is what stops `truncate` clipping the title: `CardTitle` is
                      `leading-none`, so the line box is exactly 1em and `overflow: hidden` cuts
                      the ascenders and descenders off it. The negative margin gives the space
                      back, so the header keeps the height shadcn drew it at. */}
                  <CardTitle level={level} className="-my-1 min-w-0 shrink truncate py-1">
                    {title}
                  </CardTitle>
                </div>
              ) : null}
              {description ? <CardDescription>{description}</CardDescription> : null}
            </div>
          ) : null}
          {action ? <div className={cn("cube-rn-view", HEADER_ACTION)}>{action}</div> : null}
        </CardHeader>
      ) : null}

      {/* The header keeps its real title while loading: only the part that is waiting waits. */}
      {body ? (
        <CardContent className={cn(SLOT, "min-w-0", contentClassName)}>{body}</CardContent>
      ) : null}

      {hasFooter ? (
        <CardFooter
          className={cn(
            footer && footerActions && "justify-between",
            !footer && "justify-end",
            footerClassName,
          )}
        >
          {asText(footer)}
          {footerActions ? (
            <div className={cn("cube-rn-view", ACTIONS)}>{footerActions}</div>
          ) : null}
        </CardFooter>
      ) : null}
    </Card>
  );
}

/**
 * Three bars at the widths a paragraph or a short list settles at, so the card holds roughly the
 * height its content will and the page does not jump when the data lands.
 */
function CardLayoutSkeleton() {
  return (
    <div data-slot="card-layout-skeleton" className="cube-rn-view gap-2" aria-hidden>
      <div className={cn("cube-rn-view", BAR, "w-2/3")} />
      <div className={cn("cube-rn-view", BAR, "w-full")} />
      <div className={cn("cube-rn-view", BAR, "w-1/2")} />
    </div>
  );
}
