import { cva } from "class-variance-authority";

export type ItemVariant = "default" | "outline" | "muted";
export type ItemSize = "default" | "sm";
export type ItemMediaVariant = "default" | "icon" | "image";

/**
 * The row: its children side by side, wrapping — `ItemHeader` and `ItemFooter` take a line of their
 * own. `outline` is the bordered card-per-row, `muted` a filled one.
 */
export const itemVariants = cva(
  "flex-row flex-wrap items-center rounded-md border border-transparent",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        outline: "border-border",
        muted: "bg-muted/50",
      },
      size: {
        default: "gap-4 p-4",
        sm: "gap-2.5 px-4 py-3",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

/**
 * The start of the row: an icon in a small tile, an image, or whatever is passed. On the web an
 * `<svg>` or `<img>` inside is sized for you; on a device pass it sized (`size-4`, `size-full`).
 */
export const itemMediaVariants = cva("shrink-0 flex-row items-center justify-center gap-2", {
  variants: {
    variant: {
      default: "bg-transparent",
      icon: "size-8 rounded-sm border border-border bg-muted",
      image: "size-10 overflow-hidden rounded-sm",
    },
  },
  defaultVariants: { variant: "default" },
});

/** The middle: the title over the description, taking the row's spare width. */
export const ITEM_CONTENT_CLASS = "flex-1 gap-1";

/** The title's line: text, a badge beside it, side by side. */
export const ITEM_TITLE_CLASS = "flex-row items-center gap-2";

/** The title's type. On a device it goes on the `Text` a string is wrapped in, with its ink. */
export const ITEM_TITLE_TEXT = "text-sm leading-snug font-medium";

/** The muted line under the title, two lines at most. */
export const ITEM_DESCRIPTION_CLASS =
  "line-clamp-2 text-sm leading-normal font-normal text-muted-foreground";

/** The far end: buttons, a menu. */
export const ITEM_ACTIONS_CLASS = "flex-row items-center gap-2";

/** A full-width line above the rest of the row. */
export const ITEM_HEADER_CLASS = "flex-row items-center justify-between gap-2";

/** A full-width line below the rest of the row. */
export const ITEM_FOOTER_CLASS = "flex-row items-center justify-between gap-2";

/** The rule between rows in an `ItemGroup`. */
export const ITEM_SEPARATOR_CLASS = "my-0 shrink-0 bg-border";
