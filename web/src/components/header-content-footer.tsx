import type { ReactNode, Ref } from "react";
import { cn } from "@/lib/utils";

/**
 * The column a page's chrome and its content share.
 *
 * A header that caps itself while the table beneath it runs to the pane edge reads as two
 * screens stacked, and the mismatch is there at every width, not only past the cap: the header
 * carries its own inset and the table did not. One class, applied to every slot, is what keeps
 * the title above the first column rather than beside it.
 *
 * The cap is the `2xl` breakpoint. The web reads it from the theme variable so it moves with the
 * app's own breakpoints; native has no such variable, so it spells the default (`96rem`) out.
 */
export const PAGE_COLUMN = "mx-auto w-full max-w-(--breakpoint-2xl)";

/**
 * The reading column: a page of prose, a settings screen, a form.
 *
 * Narrower than {@link PAGE_COLUMN} because the constraint is a line length, not a viewport.
 * Both app shells that had grown a page component of their own defaulted to exactly this, and
 * then disagreed about what the *other* width was called — one said `max-w-5xl` and the other
 * `max-w-none`, both spelled `wide`. Naming the columns is what stops the third app inventing an
 * eleventh value: across these projects there are 51 capped page columns wearing 10 widths.
 */
export const PROSE_COLUMN = "mx-auto w-full max-w-3xl";

const COLUMNS = {
  full: undefined,
  page: PAGE_COLUMN,
  prose: PROSE_COLUMN,
} as const;

/** The column names `width` takes. Exported for shells that pass one through. */
export type HeaderContentFooterWidth = keyof typeof COLUMNS;

export type HeaderContentFooterProps = {
  /** The body. The only slot that grows. */
  content: ReactNode;
  /** Page title, toolbar, filters — whatever stays above the body. Absent, no row is drawn. */
  header?: ReactNode | undefined;
  /** Paging, totals, a save bar. Absent, no row is drawn. */
  footer?: ReactNode | undefined;
  /**
   * Whether the body scrolls inside the chassis rather than growing it.
   *
   * On, the header and footer stay put while the body moves, which needs the chassis to have a
   * height to divide — `h-full`, or a parent that gives it one. Off, the chassis is as tall as
   * what is in it and the page scrolls as a whole.
   */
  scroll?: boolean | undefined;
  /**
   * - `full` — slots fill whatever box the chassis was given. Print sheets, dialogs, and
   *   anything already inside its own column.
   * - `page` — slots share the capped, centred {@link PAGE_COLUMN}, inset to match the header.
   *   Every list page, every board.
   * - `prose` — the narrower {@link PROSE_COLUMN}. Settings, a detail page, a form.
   */
  width?: HeaderContentFooterWidth | undefined;
  /**
   * The scrolling body, for a caller that has to reach it — restoring a scroll position. A
   * `<div>` on the web and, while `scroll` is on, the `ScrollView` on device.
   */
  contentRef?: Ref<HTMLDivElement> | undefined;
  className?: string | undefined;
  headerClassName?: string | undefined;
  /**
   * On the body. On device, where the scroller and what it scrolls are two boxes, this goes on
   * the scrolled content — padding on the scroller itself would scroll away with nothing.
   */
  contentClassName?: string | undefined;
  footerClassName?: string | undefined;
};

type BodyProps = {
  content: ReactNode;
  scroll: boolean;
  column: string | undefined;
  contentRef: HeaderContentFooterProps["contentRef"];
  className: string | undefined;
};

/**
 * How a slot lays out what it was handed.
 *
 * A compiled view is a flex column (`cube-rn-reset.css`), which is what React Native does and what
 * a web caller who passed a sentence and a link does not expect: each would become its own row.
 * The slots are wrappers around a caller's nodes, not layout of their own, so on the web they stay
 * the block boxes they always were. On device there is no other kind of box.
 */
const SLOT = "block";

/**
 * The floor every body needs, whichever element it is. See {@link HeaderContentFooter}.
 *
 * The growth differs. On the web `flex-1` is `1 1 0%`, which in a chassis of no set height — a
 * dialog capped by `max-h` — still sizes from content. Yoga's `flex: 1` starts from nothing, so the
 * same body in the same dialog collapses to zero; there it starts from its content (`basis-auto`),
 * grows into a height it is given and shrinks under a cap.
 */
const BODY = cn("relative min-h-0 min-w-0", "flex-1");

/**
 * The body, which is the one part that is a different element on each platform.
 *
 * Written as statements rather than a ternary because the two arms are different elements, and
 * the compiler refuses an element chosen at runtime — it folds `Platform.OS === "web"` to `true`
 * and keeps the first arm, and the `ScrollView` below it is dropped as unreachable.
 */
function Body({ content, scroll, column, contentRef, className }: BodyProps) {
  return (
    <div
      data-slot="header-content-footer-content"
      // The chassis's own ref type is the device's scroller; on the web both are a `<div>`.
      ref={contentRef as unknown as Ref<HTMLDivElement>}
      // A scrolling region a keyboard cannot reach is a region a keyboard user cannot read:
      // the mouse wheel moves it and nothing else does, which axe reports as
      // `scrollable-region-focusable`. A tab stop is the fix the rule asks for, and it costs
      // nothing when the body already holds focusable children — the caret goes to them next.
      tabIndex={scroll ? 0 : undefined}
      className={cn("cube-rn-view", SLOT, BODY, scroll && "overflow-y-auto", column, className)}
    >
      {content}
    </div>
  );
}

/**
 * Header, body, footer, in a column.
 *
 * A flex column rather than three fixed grid rows, because the rows only line up when all three
 * slots are present: with `grid-rows-[min-content_1fr_min-content]` and no header, the body
 * auto-places into the min-content row and is squashed to its own text, and any `gap` on the
 * chassis is still spent on the slots that are not there. Flex gives the same shape — the body
 * takes the leftover, the chrome takes what it needs — and an absent slot costs nothing. It is
 * also the only one of the two Yoga has, which is what lets this be one component.
 *
 * `min-h-0` / `min-w-0` on the body is not decoration. A flex item's floor is its content, so
 * one wide child — a table, a long unbroken string — grows the chassis and pushes the chrome off
 * the screen instead of scrolling inside it, and `scroll` does nothing at all without the floor.
 */
export function HeaderContentFooter({
  content,
  header,
  footer,
  scroll = false,
  width = "full",
  contentRef,
  className,
  headerClassName,
  contentClassName,
  footerClassName,
}: HeaderContentFooterProps) {
  // The header slot stays unpadded: a page header carries its own `px-4`, and the body matches
  // it so the two edges line up.
  const column = COLUMNS[width];
  const bodyColumn = column && cn(column, "px-4");

  return (
    // `shrink` because a chassis is sized by its parent, and a view does not shrink by default.
    <div
      data-slot="header-content-footer"
      className={cn("cube-rn-view", "min-h-0 min-w-0 shrink flex-col", className)}
    >
      {header ? (
        <div
          data-slot="header-content-footer-header"
          className={cn("cube-rn-view", SLOT, "min-w-0 shrink-0", column, headerClassName)}
        >
          {header}
        </div>
      ) : null}

      <Body
        content={content}
        scroll={scroll}
        column={bodyColumn}
        contentRef={contentRef}
        className={contentClassName}
      />

      {footer ? (
        <div
          data-slot="header-content-footer-footer"
          className={cn("cube-rn-view", SLOT, "min-w-0 shrink-0", bodyColumn, footerClassName)}
        >
          {footer}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The same chassis with the body scrolling and the chrome pinned — a list page, a pane inside a
 * split, anything whose header should not leave with the rows.
 *
 * It needs a height to divide, so it defaults to filling its parent.
 */
export function StickyHeaderContentFooter({
  className,
  ...props
}: Omit<HeaderContentFooterProps, "scroll">) {
  return <HeaderContentFooter scroll {...props} className={cn("h-full", className)} />;
}
