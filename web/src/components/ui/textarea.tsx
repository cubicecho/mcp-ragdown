import type { ComponentPropsWithRef } from "react";
import {
  type TextareaProps as SharedTextareaProps,
  TEXTAREA_CLASS,
} from "@/components/ui/textarea-base";
import { cn } from "@/lib/utils";

/** The shared contract, widened to everything a DOM `<textarea>` takes. */
export type TextareaProps = Omit<ComponentPropsWithRef<"textarea">, "className"> &
  Omit<SharedTextareaProps, "onBlur" | "value"> & {
    value?: ComponentPropsWithRef<"textarea">["value"];
  };

function Textarea({ onChange, onChangeText, className, ...props }: TextareaProps) {
  return (
    <textarea
      data-slot="textarea"
      onChange={(e) => {
        onChange?.(e);
        onChangeText?.(e.target.value);
      }}
      {...props}
      className={cn(
        TEXTAREA_CLASS,
        // `resize-y` is the browser's own affordance and has no native
        // counterpart; `disabled:` is the DOM attribute doing what the native
        // half spells out as `disabled && "opacity-50"`.
        "resize-y disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive",
        className,
      )}
    />
  );
}

export { Textarea };
