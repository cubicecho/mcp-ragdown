import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import * as React from "react";
import { IconClassContext } from "@/components/ui/icons-base";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex flex-row items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        /** A destructive action that is not the emphasis of its row. */
        "destructive-outline":
          "border border-destructive/40 bg-transparent text-destructive hover:bg-destructive/10",
        outline:
          "border border-input bg-background text-foreground hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "text-muted-foreground hover:bg-accent hover:text-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2",
        /** Small enough to sit inline in a list row without setting its height. */
        xs: "h-7 rounded-lg px-3",
        sm: "h-9 rounded-md px-3",
        lg: "h-11 rounded-md px-8",
        icon: "h-10 w-10",
        // shadcn's icon ladder, on this file's own heights: each square is the height of the
        // text size it is named after, so an icon button sits flush in a row of text buttons.
        "icon-xs": "h-7 w-7 rounded-lg [&_svg]:size-3.5",
        "icon-sm": "h-9 w-9",
        "icon-lg": "h-11 w-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

/**
 * The half of each variant that has to live on the `<Text>` for native.
 *
 * Not a duplicate of the container's `text-*` classes — both are needed. Web
 * reads the container's (and hands it to the icons through `currentColor`);
 * native reads this one, because a `<Text>` inherits nothing from the `View`
 * above it.
 */
const buttonTextVariants = cva("font-medium", {
  variants: {
    size: {
      default: "text-sm",
      xs: "text-xs",
      sm: "text-sm",
      lg: "text-sm",
      icon: "text-sm",
      "icon-xs": "text-xs",
      "icon-sm": "text-sm",
      "icon-lg": "text-sm",
    },
    variant: {
      default: "text-primary-foreground",
      destructive: "text-destructive-foreground",
      "destructive-outline": "text-destructive",
      outline: "text-foreground",
      secondary: "text-secondary-foreground",
      ghost: "text-muted-foreground",
      link: "text-primary underline",
    },
  },
  defaultVariants: { variant: "default", size: "default" },
});

export type ButtonProps = Omit<React.ComponentPropsWithoutRef<"button">, "children" | "className"> &
  VariantProps<typeof buttonVariants> & {
    // Re-declared rather than inherited: nativewind types it as
    // `className?: string`, which under `exactOptionalPropertyTypes` rejects the
    // conditional `cond ? 'x' : undefined` that call sites pass.
    className?: string | undefined;
    /**
     * Render the single child with the button's look and behaviour instead of a
     * `Pressable` around it.
     *
     * radix's `Slot` on both platforms, for the reason `ui/form.tsx` gives: it only
     * clones its child with merged props, so there is no DOM in it and it works under
     * React Native unchanged. Upstream shadcn components that wrap this Button — the
     * `alert-dialog` action and cancel buttons — are written against it.
     */
    asChild?: boolean | undefined;
    children?: React.ReactNode;
  };

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, disabled, asChild, children, ...props }, ref) => {
    const styling = cn(
      buttonVariants({ variant, size, className }),
      // `disabled:` has no pseudo-class to hang off a Pressable on either
      // platform, so the disabled look is applied directly.
      disabled && "opacity-50",
    );

    const body = (
      // Icons inside a button take the variant's text colour. On web they
      // already inherit it, so `icons.web.tsx` ignores this; native has no
      // inheritance and this is where the colour comes from.
      <IconClassContext.Provider value={buttonTextVariants({ variant, size })}>
        {React.Children.map(children, (child) =>
          typeof child === "string" || typeof child === "number" ? (
            <span className={cn("cube-rn-text", buttonTextVariants({ variant, size }))}>
              {child}
            </span>
          ) : (
            child
          ),
        )}
      </IconClassContext.Provider>
    );

    // Two returns rather than one variable element: `Slot.Root` is typed for the DOM
    // and `Pressable` for a `View`, and a union of the two types nothing usefully —
    // every prop below would have to satisfy both. Written out, each branch is checked
    // against the element it actually renders.
    if (asChild) {
      return (
        // `Slot.Root` is declared over `HTMLAttributes<HTMLElement>` because radix ships
        // for the DOM, but it renders nothing itself — it clones its child with these
        // props merged in. The element that receives them is the caller's, so the DOM
        // typing describes neither side, and the cast is the honest way to say so.
        <Slot.Root
          className={styling}
          {...({ ...props, disabled } as unknown as React.HTMLAttributes<HTMLElement>)}
          ref={ref as unknown as React.Ref<HTMLElement>}
        >
          {body}
        </Slot.Root>
      );
    }

    return (
      <button
        type="button"
        ref={ref as React.Ref<HTMLButtonElement>}
        disabled={disabled}
        className={cn("cube-rn-view cube-rn-pressable", styling)}
        {...(props as React.ComponentPropsWithoutRef<"button">)}
      >
        {body}
      </button>
    );
  },
);
Button.displayName = "Button";

export { Button, buttonTextVariants, buttonVariants };
