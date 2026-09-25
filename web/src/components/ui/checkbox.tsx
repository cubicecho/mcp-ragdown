import { Checkbox as CheckboxPrimitive } from "radix-ui";
import type { ComponentPropsWithRef } from "react";
import { CHECKBOX_CLASS } from "@/components/ui/checkbox-base";
import { Check } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

/**
 * radix's props, with `className` re-declared for `exactOptionalPropertyTypes`. Every prop of the
 * shared contract but `accessibilityLabel` is already one of radix's; a `() => void` is a DOM
 * `onBlur`.
 */
export type CheckboxProps = Omit<
  ComponentPropsWithRef<typeof CheckboxPrimitive.Root>,
  "className"
> & {
  className?: string | undefined;
  /**
   * The device half's name for the box, taken here so a call site shared across both halves —
   * typechecked against the device half, so this is all it passes — still names it. It becomes
   * `aria-label`; an `aria-label` of its own wins. Optional, because on the web a
   * `<Label htmlFor={id}>` can name the box instead.
   */
  "aria-label"?: string | undefined;
};

function Checkbox({
  className,
  "aria-label": accessibilityLabel,
  "aria-label": ariaLabel,
  ...props
}: CheckboxProps) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      {...props}
      aria-label={ariaLabel ?? accessibilityLabel}
      className={cn(
        CHECKBOX_CLASS,
        "peer flex border-input bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground",
        className,
      )}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="flex items-center justify-center text-current"
      >
        <Check className="h-3 w-3" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
