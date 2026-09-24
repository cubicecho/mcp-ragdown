import type { ComponentPropsWithoutRef, HTMLInputTypeAttribute, Ref } from "react";
import {
  INPUT_CLASS,
  type InputHandle,
  type InputType,
  type InputProps as SharedInputProps,
} from "@/components/ui/input-base";
import { cn } from "@/lib/utils";

/**
 * The shared contract, widened to everything a DOM `<input>` takes.
 *
 * `onBlur`, `min`/`max`, `value` and `defaultValue` take the DOM's wider types — a `() => void` is
 * still one, and a `string` is still a `string | number | readonly string[]` — and `type` is every
 * DOM input type, of which `InputType` is the cross-platform part.
 */
export type InputProps = Omit<ComponentPropsWithoutRef<"input">, "type" | "className"> &
  Omit<
    SharedInputProps,
    "type" | "ref" | "onBlur" | "min" | "max" | "inputMode" | "value" | "defaultValue"
  > & {
    type?: HTMLInputTypeAttribute | undefined;
    ref?: Ref<HTMLInputElement> | Ref<InputHandle> | undefined;
  };

function Input({
  className,
  type = "text",
  onChange,
  onChangeText,
  onKeyDown,
  onSubmitEditing,
  ref,
  ...props
}: InputProps) {
  return (
    <input
      // The element is the handle: it has `focus` and `select`, which is all `InputHandle` asks.
      ref={ref as Ref<HTMLInputElement>}
      data-slot="input"
      type={type}
      onChange={(e) => {
        onChange?.(e);
        onChangeText?.(e.target.value);
      }}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (e.key === "Enter" && onSubmitEditing && !e.defaultPrevented) {
          e.preventDefault();
          onSubmitEditing();
        }
      }}
      {...props}
      className={cn(
        INPUT_CLASS,
        "file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive",
        className,
      )}
    />
  );
}

export type { InputHandle, InputType };
export { Input };
