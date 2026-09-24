import type { ReactNode } from "react";

export type PopoverProps = {
  /**
   * Both optional, together: pass neither and the popover keeps its own open
   * state. `form-field` opens a hint popover from a trigger and never reads the
   * state back, and requiring the pair there meant a `useState` at every call
   * site that existed only to be handed straight back.
   */
  open?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  defaultOpen?: boolean | undefined;
  children: ReactNode;
};

export type PopoverTriggerProps = {
  /**
   * Hand the press handler to the single child element rather than wrapping it.
   * Always pass it: a `Pressable` wrapping a `Button` never fires on native,
   * because the inner pressable claims the touch responder.
   */
  asChild?: boolean | undefined;
  children: ReactNode;
};

export type PopoverContentProps = {
  className?: string | undefined;
  /** Web only — the native sheet is centred and has nothing to align to. */
  align?: "start" | "center" | "end" | undefined;
  children?: ReactNode;
};

/**
 * Closes the popover it is inside. `asChild` hands the press to a `Button` rather than wrapping
 * it — the same shape as `DialogClose`, so a pane's Done button does not need the caller to own
 * `open` just to set it back to `false`.
 */
export type PopoverCloseProps = {
  asChild?: boolean | undefined;
  className?: string | undefined;
  children?: ReactNode;
};

/** Web only in effect: the native sheet is centred, so it renders its children and anchors nothing. */
export type PopoverAnchorProps = {
  asChild?: boolean | undefined;
  children?: ReactNode;
};

/** `PopoverHeader`, `PopoverTitle` and `PopoverDescription` — shadcn's heading block for a pane. */
export type PopoverSectionProps = {
  className?: string | undefined;
  children?: ReactNode;
};
