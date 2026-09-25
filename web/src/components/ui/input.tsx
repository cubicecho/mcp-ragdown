import type {
  ComponentPropsWithoutRef,
  HTMLInputTypeAttribute,
  KeyboardEventHandler,
  Ref,
} from "react";
import {
  INPUT_CLASS,
  INPUT_LEADING_CLASS,
  INPUT_LEADING_PAD_CLASS,
  INPUT_TRAILING_CLASS,
  INPUT_TRAILING_PAD_CLASS,
  INPUT_WRAPPER_CLASS,
  type InputHandle,
  type InputKeyPressEvent,
  type InputKeyPressHandler,
  type InputType,
  type InputProps as SharedInputProps,
} from "@/components/ui/input-base";
import { cn } from "@/lib/utils";

/**
 * The shared contract, widened to everything a DOM `<input>` takes.
 *
 * `onBlur`, `min`/`max`, `value` and `defaultValue` take the DOM's wider types — a `() => void` is
 * still one, and a `string` is still a `string | number | readonly string[]` — and `type` is every
 * DOM input type, of which `InputType` is the cross-platform part. `onKeyPress` hands over the
 * React keyboard event, which is a shared handler's `{ nativeEvent: { key } }` and a shadcn call
 * site's `e.key` at once.
 */
export type InputProps = Omit<
  ComponentPropsWithoutRef<"input">,
  "type" | "className" | "onKeyPress"
> &
  Omit<
    SharedInputProps,
    | "type"
    | "ref"
    | "onBlur"
    | "min"
    | "max"
    | "inputMode"
    | "value"
    | "defaultValue"
    | "onKeyPress"
    | "aria-describedby"
    | "aria-invalid"
  > & {
    type?: HTMLInputTypeAttribute | undefined;
    ref?: Ref<HTMLInputElement> | Ref<InputHandle> | undefined;
    onKeyPress?: KeyboardEventHandler<HTMLInputElement> | undefined;
  };

function Input({
  className,
  type = "text",
  onChange,
  onChangeText,
  onKeyDown,
  onKeyPress,
  onSubmitEditing,
  onEscape,
  leading,
  trailing,
  wrapperClassName,
  ref,
  ...props
}: InputProps) {
  const field = (
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
        // `keydown`, not the DOM's `keypress`: that one is deprecated and never fires for Escape,
        // the key `onKeyPress` is most often passed to hear. react-native-web makes the same swap.
        onKeyPress?.(e);
        if (e.defaultPrevented) return;
        if (e.key === "Enter" && onSubmitEditing) {
          e.preventDefault();
          onSubmitEditing();
        } else if (e.key === "Escape" && onEscape) {
          // Held back from the browser, which would otherwise clear a `type="search"` box under
          // a caller that is putting the old value back.
          e.preventDefault();
          onEscape();
        }
      }}
      {...props}
      className={cn(
        INPUT_CLASS,
        "file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive",
        leading != null && INPUT_LEADING_PAD_CLASS,
        trailing != null && INPUT_TRAILING_PAD_CLASS,
        className,
      )}
    />
  );

  if (leading == null && trailing == null) return field;

  return (
    <div data-slot="input-wrapper" className={cn(INPUT_WRAPPER_CLASS, wrapperClassName)}>
      {leading != null ? (
        <span data-slot="input-leading" className={cn(INPUT_LEADING_CLASS, SLOT_ICON)}>
          {leading}
        </span>
      ) : null}
      {field}
      {trailing != null ? (
        <span data-slot="input-trailing" className={cn(INPUT_TRAILING_CLASS, SLOT_ICON)}>
          {trailing}
        </span>
      ) : null}
    </div>
  );
}

/**
 * On the web an `<svg>` takes `currentColor`, so the slot carries the ink and the icon only needs
 * its size — pinned to the child rather than set on it, so a bare `<Search />` fits. A trailing
 * button's own `hover:text-*` still wins, being on the button.
 */
const SLOT_ICON = "text-muted-foreground [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

export type { InputHandle, InputKeyPressEvent, InputKeyPressHandler, InputType };
export { Input };
