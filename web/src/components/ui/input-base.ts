import type { Ref } from "react";

/**
 * Everything but `text`, `number`, `password` and the four keyboard types falls back to plain text
 * entry off web.
 *
 * `password` is here because it is the one non-web type native implements properly:
 * `secureTextEntry` masks the field and tells the platform keyboard to leave it out of
 * autocorrect and the suggestion strip. `email`, `search`, `url` and `tel` raise the matching
 * keyboard on device — they are `inputMode`s there and real input types on web. `time`,
 * `datetime-local`, `date` and `color` are real DOM controls with no native counterpart, and
 * degrade to a text box.
 *
 * The web half takes every DOM input type on top of these (`input.web.tsx`), so a shadcn call site
 * with `type="checkbox"` or `type="file"` still compiles there; this list is the part that means
 * something on both platforms.
 */
export type InputType =
  | "text"
  | "number"
  | "password"
  | "email"
  | "search"
  | "url"
  | "tel"
  | "time"
  | "date"
  | "datetime-local"
  | "color";

/** The keyboard each type raises on native when the caller has not chosen one with `inputMode`. */
export const NATIVE_INPUT_MODE: Partial<Record<InputType, NonNullable<InputProps["inputMode"]>>> = {
  number: "numeric",
  email: "email",
  search: "search",
  url: "url",
  tel: "tel",
};

/**
 * What a caller may do to an input imperatively. `select` is web-only —
 * `TextInput` has no equivalent — so callers must treat it as optional.
 *
 * On web the ref is the `<input>` itself rather than an object built to this shape: an
 * `HTMLInputElement` already has both methods, so a `Ref<InputHandle>` is served by it, and a
 * shadcn call site holding a `useRef<HTMLInputElement>` gets the element it asked for.
 */
export type InputHandle = {
  focus: () => void;
  select?: () => void;
};

export type InputProps = {
  value?: string | undefined;
  /** Uncontrolled: where the text starts, when nothing above is holding `value`. */
  defaultValue?: string | undefined;
  onChangeText?: ((text: string) => void) | undefined;
  onBlur?: (() => void) | undefined;
  /** Enter on web, the return key on native. */
  onSubmitEditing?: (() => void) | undefined;
  placeholder?: string | undefined;
  type?: InputType | undefined;
  /**
   * Which keyboard to raise. Not the same knob as `type`: `type="number"` is what
   * gets the DOM spinners and the browser's numeric parsing, `inputMode="decimal"`
   * is what gets a phone keypad, and a number field wants both.
   */
  inputMode?: "text" | "decimal" | "numeric" | "tel" | "search" | "email" | "url" | undefined;
  maxLength?: number | undefined;
  /** Web only; the native keyboard has no equivalent constraint. */
  min?: number | undefined;
  max?: number | undefined;
  disabled?: boolean | undefined;
  className?: string | undefined;
  /**
   * Ties the control to its `<label>` on the web. React Native takes `id` as its `nativeID`, so on
   * device it is only a target for another element's `aria-labelledby`.
   */
  id?: string | undefined;
  /**
   * The accessible name, for an input no `<label>` points at — the time box beside
   * a date trigger. `TextInput` takes it on device, and react-native-web renders it.
   */
  "aria-label"?: string | undefined;
  /**
   * The accessible name by reference. The web honours a list of ids; Android reads one, and iOS
   * none, so a native caller that needs the name everywhere passes `aria-label` too.
   */
  "aria-labelledby"?: string | undefined;
  autoFocus?: boolean | undefined;
  ref?: Ref<InputHandle> | undefined;
};

export const INPUT_CLASS =
  "border-input bg-background text-foreground ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring flex h-10 w-full rounded-md border px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2";
