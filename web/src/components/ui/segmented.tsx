import type { ReactNode } from "react";
import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The container class, for a pill the caller renders itself.
 *
 * `hover:` and `transition-colors` are no-ops on device and real on web, which
 * is the intended asymmetry: a pointer exists on one platform and not the other.
 */
export function segmentedItemClass(active: boolean, className?: string) {
  return cn(
    "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
    active
      ? "bg-primary text-primary-foreground"
      : "text-muted-foreground hover:bg-muted hover:text-foreground",
    className,
  );
}

/**
 * The `<Text>` half of the pill. Native does not inherit colour, so a pill
 * built from a `Pressable` needs the colour on its label, not on its container.
 * A pill built from a router `<Link>` does not need this — a link renders a
 * `Text` and text-in-text does inherit.
 */
export function segmentedTextClass(active: boolean, className?: string) {
  return cn(
    "text-sm font-medium",
    active ? "text-primary-foreground" : "text-muted-foreground",
    className,
  );
}

/**
 * What a `SegmentedGroup` tells the pills inside it: which value is current, who
 * to tell when another is pressed, and whether they sit in the frame.
 */
type SegmentedGroupContextValue = {
  value: string | undefined;
  onValueChange: ((value: string) => void) | undefined;
  framed: boolean;
};

const SegmentedGroupContext = React.createContext<SegmentedGroupContextValue | null>(null);

/**
 * The row's two looks. `framed` is an input-height box, so a segmented control
 * beside a select or an input lines up with it; `plain` is the pills on the
 * page with nothing round them, for a toolbar or a nav bar.
 */
const SEGMENTED_GROUP_VARIANTS = {
  framed: "h-10 rounded-md border border-input bg-background p-1",
  plain: "",
} as const;

export type SegmentedGroupProps = Omit<
  React.ComponentPropsWithoutRef<"div">,
  "children" | "className" | "style" | "role"
> & {
  /**
   * The current pill's `value`. With it, a `SegmentedButton value="week"` works
   * out whether it is current, so no pill needs `active={x === value}`.
   */
  value?: string | undefined;
  /** Called with a pill's `value` when it is pressed. */
  onValueChange?: ((value: string) => void) | undefined;
  /** `framed` (the default) draws the input-height box; `plain` draws the row alone. */
  variant?: keyof typeof SEGMENTED_GROUP_VARIANTS | undefined;
  /**
   * The group's name, read on entering it: "Scale view, group". Give one
   * whenever no visible heading names the choice.
   */
  "aria-label"?: string | undefined;
  /** The id of a visible heading that names the group, in place of `aria-label`. */
  "aria-labelledby"?: string | undefined;
  className?: string | undefined;
  children: ReactNode;
};

/**
 * The row a set of pills sits in, and the name of what they choose between.
 *
 * `role="group"` rather than `radiogroup`, because the pills are toggle buttons
 * with `aria-pressed`, not radios: a `radiogroup` promises one tab stop and arrow
 * keys, which a row of buttons does not have, and a nav bar's pills are links.
 * Without the group a screen reader hears "Week, toggle button, pressed" with
 * nothing saying what Week was chosen from.
 *
 * Holds no value of its own. `value` and `onValueChange` are the caller's, and
 * both are optional: a row of pills that each pass `active` still works inside it.
 */
const SegmentedGroup = React.forwardRef<HTMLDivElement, SegmentedGroupProps>(
  ({ value, onValueChange, variant = "framed", className, children, ...props }, ref) => {
    const framed = variant === "framed";
    const context = React.useMemo(
      () => ({ value, onValueChange, framed }),
      [value, onValueChange, framed],
    );
    return (
      <SegmentedGroupContext.Provider value={context}>
        <div
          ref={ref as React.Ref<HTMLDivElement>}
          role="group"
          className={cn(
            "cube-rn-view",
            "flex-row items-center gap-1 self-start",
            // A flex container is block-level on the web and would stretch the
            // frame across the page; on device `self-start` already hugs it.
            "w-fit",
            SEGMENTED_GROUP_VARIANTS[variant],
            className,
          )}
          {...(props as React.ComponentPropsWithoutRef<"div">)}
        >
          {children}
        </div>
      </SegmentedGroupContext.Provider>
    );
  },
);
SegmentedGroup.displayName = "SegmentedGroup";

export type SegmentedButtonProps = Omit<
  React.ComponentPropsWithoutRef<"button">,
  "children" | "className" | "style"
> & {
  /**
   * Whether this is the current pill. Wins over a group's `value` when both are
   * given, so a call site written before `SegmentedGroup` keeps working.
   */
  active?: boolean | undefined;
  /**
   * This pill's value inside a `SegmentedGroup`: it is current when the group's
   * `value` matches, and pressing it hands this to the group's `onValueChange`.
   */
  value?: string | undefined;
  // Re-declared rather than inherited: nativewind types it as `className?:
  // string`, which under `exactOptionalPropertyTypes` rejects the conditional
  // `cond ? "x" : undefined` that call sites pass.
  className?: string | undefined;
  children: ReactNode;
};

/**
 * A pressable pill.
 *
 * `children` is passed through untouched unless it is a bare string, in which
 * case it is wrapped in a `<Text>` carrying the active colour — the common case,
 * and the one where forgetting the wrapper is a runtime error on native.
 *
 * Takes the rest of a `Pressable`'s props and forwards a ref, the same contract
 * `button.tsx` has and for the same reason: a closed prop set silently drops
 * everything a wrapper tries to hand it — a `TooltipTrigger asChild`'s ref and
 * `aria-*`, an `onLongPress`, a `testID` — with nothing erroring to say so.
 */
const SegmentedButton = React.forwardRef<HTMLButtonElement, SegmentedButtonProps>(
  ({ active, value, className, children, onClick: onPress, ...props }, ref) => {
    const group = React.useContext(SegmentedGroupContext);
    const current = active ?? (group !== null && value !== undefined && group.value === value);
    return (
      <button
        type="button"
        ref={ref as React.Ref<HTMLButtonElement>}
        // The same fact again, in the only spelling the web understands.
        //
        // react-native-web does not read `accessibilityState` at all — it forwards an allowlist of
        // `aria-*` props and nothing else — so without this line the active pill is styled but
        // silent, and a screen reader user cannot tell which of the set is current. It is
        // `aria-pressed` rather than `aria-selected` because this is a `button`, and `aria-selected`
        // is only defined on `option`, `tab`, `row`, `gridcell` and `treeitem`; on a button it is
        // markup axe rejects. React Native has no `aria-pressed`, hence the platform guard.
        aria-pressed={current}
        onClick={(event) => {
          if (group && value !== undefined) group.onValueChange?.(value);
          onPress?.(event);
        }}
        className={cn(
          // Inside the frame a pill is 4px shorter, so it fits the input-height
          // box instead of spilling past its padding.
          "cube-rn-view cube-rn-pressable",
          group?.framed ? "rounded-md px-3 py-1" : "rounded-md px-3 py-1.5",
          current ? "bg-primary" : "hover:bg-muted",
          // The label colour on the container too, which native ignores and web
          // reads: an element child passes through untouched below, so on web its
          // colour can only come from inheriting it here.
          current ? "text-primary-foreground" : "text-muted-foreground",
          className,
        )}
        {...(props as React.ComponentPropsWithoutRef<"button">)}
      >
        {typeof children === "string" ? (
          <span className={cn("cube-rn-text", segmentedTextClass(current))}>{children}</span>
        ) : (
          children
        )}
      </button>
    );
  },
);
SegmentedButton.displayName = "SegmentedButton";

export { SegmentedButton, SegmentedGroup };
