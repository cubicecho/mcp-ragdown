export type TextareaProps = {
  value?: string | undefined;
  /** Uncontrolled: where the text starts, when nothing above is holding `value`. */
  defaultValue?: string | undefined;
  onChangeText?: ((text: string) => void) | undefined;
  onBlur?: (() => void) | undefined;
  placeholder?: string | undefined;
  /** Visible lines; the box grows no further and scrolls instead. */
  rows?: number | undefined;
  maxLength?: number | undefined;
  disabled?: boolean | undefined;
  className?: string | undefined;
  /** Web only: ties the control to its `<label>`. */
  id?: string | undefined;
};

/**
 * The placeholder colour rides here as a `placeholder:` variant, the same way
 * `INPUT_CLASS` does it. NativeWind 4's `placeholderClassName` prop is gone in
 * 5; the variant compiles to `placeholderTextColor` on device and to a real
 * `::placeholder` rule on web.
 */
export const TEXTAREA_CLASS =
  "border-input bg-background text-foreground ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring min-h-[80px] w-full rounded-md border px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2";
