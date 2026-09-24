import * as React from "react";
import { ColorBar } from "@/components/ui/color-bar";
import { cn } from "@/lib/utils";

// `className` is re-declared rather than inherited: nativewind types it as
// `className?: string`, which under `exactOptionalPropertyTypes` rejects the
// conditional `cond ? 'x' : undefined` several call sites pass.
type ViewProps = Omit<React.ComponentPropsWithoutRef<"div">, "className"> & {
  className?: string | undefined;
};
type TextProps = Omit<React.ComponentPropsWithoutRef<"span">, "className"> & {
  className?: string | undefined;
};

type CardProps = ViewProps & {
  /** Renders a left-edge ColorBar along with the positioning it requires. */
  accentColor?: string | null | undefined;
  /** What the accent colour stands for, for anyone who cannot see it. */
  accentLabel?: string | undefined;
  /**
   * Makes the whole card a target. A card that takes this renders a
   * `Pressable` instead of a `View` — a `View` has no press handling on
   * native, and an `onClick` on a plain `div` is not reachable by keyboard.
   */
  onClick?: React.ComponentPropsWithoutRef<"button">["onClick"] | undefined;
};

const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, accentColor, accentLabel, onClick: onPress, children, ...props }, ref) => {
    const classes = cn(
      "rounded-lg border border-border bg-card text-card-foreground shadow-sm",
      accentColor && "relative overflow-hidden",
      className,
    );
    const inner = (
      <>
        <ColorBar color={accentColor} label={accentLabel} />
        {children}
      </>
    );

    // The two containers are written out rather than picked with `const Container = onPress ?
    // Pressable : View`. They do not actually share a prop list — only one of them takes a press
    // handler — and `rn2web` refuses an element chosen at runtime, because the tag it emits, the
    // reset class it carries and the role it infers all follow from knowing which one it is.
    if (onPress) {
      return (
        <button
          type="button"
          ref={ref as React.Ref<HTMLButtonElement>}
          onClick={onPress}
          className={cn("cube-rn-view cube-rn-pressable", classes)}
          {...(props as React.ComponentPropsWithoutRef<"button">)}
        >
          {inner}
        </button>
      );
    }
    return (
      <div
        ref={ref as React.Ref<HTMLDivElement>}
        className={cn("cube-rn-view", classes)}
        {...(props as React.ComponentPropsWithoutRef<"div">)}
      >
        {inner}
      </div>
    );
  },
);
Card.displayName = "Card";

const CardHeader = React.forwardRef<HTMLDivElement, ViewProps>(({ className, ...props }, ref) => (
  <div
    ref={ref as React.Ref<HTMLDivElement>}
    className={cn("cube-rn-view", "flex flex-col gap-1.5 p-6", className)}
    {...(props as React.ComponentPropsWithoutRef<"div">)}
  />
));
CardHeader.displayName = "CardHeader";

const CardTitle = React.forwardRef<HTMLSpanElement, TextProps>(({ className, ...props }, ref) => (
  <h3
    ref={ref as React.Ref<HTMLHeadingElement>}
    className={cn(
      "cube-rn-text",
      "text-2xl font-semibold leading-none tracking-tight text-card-foreground",
      className,
    )}
    {...(props as React.ComponentPropsWithoutRef<"h3">)}
  />
));
CardTitle.displayName = "CardTitle";

const CardDescription = React.forwardRef<HTMLSpanElement, TextProps>(
  ({ className, ...props }, ref) => (
    <span
      ref={ref as React.Ref<HTMLSpanElement>}
      className={cn("cube-rn-text", "text-sm text-muted-foreground", className)}
      {...(props as React.ComponentPropsWithoutRef<"span">)}
    />
  ),
);
CardDescription.displayName = "CardDescription";

const CardContent = React.forwardRef<HTMLDivElement, ViewProps>(({ className, ...props }, ref) => (
  <div
    ref={ref as React.Ref<HTMLDivElement>}
    className={cn("cube-rn-view", "p-6 pt-0", className)}
    {...(props as React.ComponentPropsWithoutRef<"div">)}
  />
));
CardContent.displayName = "CardContent";

const CardFooter = React.forwardRef<HTMLDivElement, ViewProps>(({ className, ...props }, ref) => (
  <div
    ref={ref as React.Ref<HTMLDivElement>}
    className={cn("cube-rn-view", "flex flex-row items-center p-6 pt-0", className)}
    {...(props as React.ComponentPropsWithoutRef<"div">)}
  />
));
CardFooter.displayName = "CardFooter";

/**
 * The header's trailing slot — a menu button, a status chip.
 *
 * shadcn's web `CardHeader` is a grid and `CardAction` places itself in its second
 * column with `col-start-2 row-span-2 self-start justify-self-end`. Yoga has no grid,
 * so the same position is a self-aligned absolute box: the header already reserves its
 * right padding, and the action is the only thing that sits there.
 */
const CardAction = React.forwardRef<HTMLDivElement, ViewProps>(({ className, ...props }, ref) => (
  <div
    ref={ref as React.Ref<HTMLDivElement>}
    className={cn("cube-rn-view", "absolute right-6 top-6 items-end", className)}
    {...(props as React.ComponentPropsWithoutRef<"div">)}
  />
));
CardAction.displayName = "CardAction";

export { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle };
