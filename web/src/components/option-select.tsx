import type { ComponentProps, ReactNode } from "react";
import { useMemo } from "react";
import {
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  Select as SelectRoot,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export type SelectOption = {
  label: ReactNode;
  value: string;
  /**
   * The heading this option is drawn under. Options sharing one are drawn together beneath it,
   * in the order they were given rather than sorted — a board's lanes are ordered, and
   * alphabetical would be wrong.
   */
  group?: string | undefined;
  /**
   * The row's class, on the `SelectItem` itself. The only way in before this was to wrap the
   * label, which styles the text and leaves the row's padding, tick and highlight in the body
   * face — and model ids, SHA prefixes and file paths are `font-mono` because they are
   * identifiers. `llama3.1:8b` beside `gpt-4o-mini` in prose is a list of sentences.
   */
  className?: string | undefined;
};

/** A rule across the list. An entry that is not an option, so it has no `value`. */
export type SelectSeparatorEntry = { separator: true };

/**
 * A row that says something about the list rather than offering a choice: *Loading…*, or why
 * the fetch failed.
 *
 * **It is not a disabled option.** That is the workaround every hand-written version reaches for,
 * and it is a row the keyboard still walks onto and a reader still hears as a choice — one they
 * are told they may not have — when it was never a choice at all.
 *
 * So the row itself is `aria-hidden`, because a listbox may own only options and groups and axe
 * is right to say so; it is radix's own reason for hiding its separator. The words are announced
 * from an `sr-only` live region beside the control instead, always mounted — a live region added
 * to the document in the same breath as its text is announced unreliably or not at all, and the
 * whole case here is that the menu opens *before* the list exists. Same argument as
 * `ActionButton`'s `hint`.
 *
 * `className` because the two of these are rarely the same colour — a wait is muted and a
 * failure is not.
 */
export type SelectNoteEntry = { note: ReactNode; className?: string | undefined };

/**
 * What `options` holds: the options, and the rules between them.
 *
 * A list of peers is still a list of peers — nothing here is written until an option is not one.
 * The case that asked for it: a picker answering "where does this card go when it passes" with
 * *stay here*, then the other lanes, then *archive it*, which is not a lane at all. Without a
 * rule the last row sits flush against the lane names and reads as one of them, and the
 * workaround is a sentence doing a divider's job — `"Archive it — off the board"`.
 *
 * A note is the same argument for a row that is not a choice: once `{ separator: true }` proved
 * the list can hold an entry that is not an option, a menu that is still loading has somewhere
 * to say so.
 */
export type SelectEntry = SelectOption | SelectSeparatorEntry | SelectNoteEntry;

/** Generic over the entry, so the same test sorts a raw list and the blocks built from one. */
function isSeparator<T extends object>(entry: T): entry is T & SelectSeparatorEntry {
  return "separator" in entry;
}

/** The same, for the other entry that is not an option. */
function isNote<T extends object>(entry: T): entry is T & SelectNoteEntry {
  return "note" in entry;
}

type SelectBlock =
  | SelectSeparatorEntry
  | SelectNoteEntry
  | { group?: string | undefined; options: SelectOption[] };

/**
 * The flat list, as the runs Radix draws: a rule and a note are each their own block, and
 * consecutive options sharing a `group` are one.
 *
 * Walked rather than bucketed, because the order is the caller's and a group that reappears
 * later is a caller who meant it. Options with no `group` are a block with no heading, which is
 * every list that has not asked for one.
 */
function blocksOf(entries: readonly SelectEntry[]): SelectBlock[] {
  const blocks: SelectBlock[] = [];
  for (const entry of entries) {
    if (isSeparator(entry) || isNote(entry)) {
      blocks.push(entry);
      continue;
    }
    const last = blocks.at(-1);
    // `"options" in last` rather than two negations: it is the shape being asked for.
    if (last && "options" in last && last.group === entry.group) {
      last.options.push(entry);
    } else {
      blocks.push({ group: entry.group, options: [entry] });
    }
  }
  return blocks;
}

/** Off the screen and still read. `sr-only` is a clip, which the device does not have. */
const SR_ONLY = "sr-only";

/** Never seen, but react-native-web gives every `Text` its own black `color` all the same. */
const NOTE_INK = "text-foreground";

/**
 * A note in the menu is a row, and one `Text` rather than a box around one, because the element
 * carrying the words is the one that has to be `aria-hidden`. On device a `Text` in a column is
 * already a row; the compiled `<span>` is inline, where its padding takes no room, so it says so.
 */
const NOTE_ROW = "block";

// The trigger's props, because the rest is spread onto the trigger — the field wiring (`id`, the
// `aria-*` props, `disabled`, `onBlur`) and anything else a call site already passes. Taken from
// `SelectTrigger` rather than spelled out, so each half gets its own: on the web that trigger is
// radix's `<button>` and honours every attribute one does, and on device it is the subset
// `select-base.ts` names.
type OptionSelectProps = Omit<
  ComponentProps<typeof SelectTrigger>,
  "value" | "onChange" | "type" | "children" | "className" | "disabled"
> & {
  className?: string | undefined;
  disabled?: boolean | undefined;
  options: readonly SelectEntry[];
  value?: string | undefined;
  onValueChange: (value: string) => void;
  /** What the trigger says with nothing chosen. */
  placeholder?: string | undefined;
  /**
   * Whether the menu is open, and being told when that changes. The same controlled pair as
   * everywhere else in the set; pass `onOpenChange` on its own to be told without taking over.
   *
   * This is what a menu that fills when it opens needs. The fetch is `enabled: opened`, so a
   * form of twenty fields asks the server nothing for the eighteen the reader never touches —
   * and the select root is the only thing that knows, which is the one element this control does
   * not hand back.
   */
  open?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  /** The dropdown's class. `className` still goes to the trigger, which is the control. */
  contentClassName?: string | undefined;
};

/**
 * A select taking a list of options, rather than seven primitives to assemble. On both halves:
 * radix's listbox under the trigger on the web, the `Select` sheet on device.
 *
 * The other four pickers in this set ship twice — a control taking `value` and `onValueChange`,
 * and a bound field wrapping it. Select shipped once, as `SelectField`, so the only way to get
 * one was through a TanStack form: a filter bar, a search box or a `useState` screen had to
 * hand-write the trigger, the value, the content and the mapped items, and there are ten of
 * those across these projects.
 *
 * They are hand-written wrong in the same place every time. **The `Select` root renders
 * nothing** — radix's draws no DOM and the device's is a context — so an `id` or an
 * `aria-invalid` put on it goes nowhere; both belong on the trigger. Which is why this takes the
 * rest of the trigger's props and spreads them there — the shape
 * `FormField`'s function form hands its control, so this drops into one without a wrapper:
 *
 * ```tsx
 * <FormField
 *   label="Kind"
 *   control={(wired) => (
 *     <OptionSelect {...wired} options={KINDS} value={kind} onValueChange={setKind} />
 *   )}
 * />
 * ```
 *
 * **The name is `OptionSelect` because `Select` did not survive an install.** This shipped as
 * `Select`, on the reasoning that the import path tells it apart from the primitive at
 * `ui/select` the way it does for shadcn itself. It does not: the shadcn CLI resolves a
 * cross-item import by the source file's *basename*, so with `control/select.tsx` and
 * `ui/select.tsx` both in one install it rewrote `app-form`'s import to the primitive. That
 * compiles as far as the import and fails on the members, three files from the cause — see #36.
 * A name a human disambiguates by path is not one the CLI does, so no item here may share a
 * basename with a shadcn primitive.
 */
export function OptionSelect({
  options,
  value,
  onValueChange,
  placeholder,
  open,
  onOpenChange,
  className,
  contentClassName,
  disabled,
  ...props
}: OptionSelectProps) {
  const blocks = useMemo(() => blocksOf(options), [options]);
  const notes = useMemo(() => options.filter(isNote), [options]);
  // Handed to `SelectValue` rather than left for the select to find. Radix mirrors the chosen
  // item's text into the trigger by itself, but the device's sheet is not mounted while it is
  // closed and has nothing to mirror from — so the label is looked up here, once, for both.
  const chosen = useMemo(
    () => options.find((entry): entry is SelectOption => "value" in entry && entry.value === value),
    [options, value],
  );

  return (
    <SelectRoot
      value={value ?? ""}
      onValueChange={onValueChange}
      disabled={disabled}
      open={open}
      onOpenChange={onOpenChange}
    >
      {/* Full width by default, because a select in a field is one and a trigger that shrinks to
          its longest option makes a column of them ragged. `cn` lets a caller say otherwise. */}
      <SelectTrigger {...props} className={cn("w-full", className)}>
        <SelectValue placeholder={placeholder}>{chosen?.label}</SelectValue>
      </SelectTrigger>
      {/*
        Where the notes are announced from. It sits here rather than in the menu because the menu
        is the listbox and a listbox may own only options and groups — and because the menu is
        unmounted on close (radix's popper, the device's sheet), while a live region has to be in
        the tree *before* its text is to be read out at all. The root draws nothing, so this is a
        sibling of the trigger.
      */}
      <div role="status" aria-live="polite" className={cn("cube-rn-view", SR_ONLY)}>
        {notes.map((entry, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a message about the list has no id
          <span key={`note-${index}`} className={cn("cube-rn-text", NOTE_INK)}>
            {entry.note}
          </span>
        ))}
      </div>
      <SelectContent className={contentClassName}>
        {/*
          Keyed by position, and it has to be: a rule has no identity of its own, and a heading
          that appears twice is a caller who meant it, so neither is unique. The list is the
          caller's and is drawn in the order given, so a position is stable enough.
        */}
        {blocks.map((block, index) => {
          if (isSeparator(block)) {
            // biome-ignore lint/suspicious/noArrayIndexKey: a rule has no identity of its own
            return <SelectSeparator key={`block-${index}`} />;
          }
          if (isNote(block)) {
            return (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: nor does a message about the list
                key={`block-${index}`}
                // Hidden here and announced from the live region above. A listbox may own only
                // options and groups, which is why radix hides its own separator the same way.
                aria-hidden
                className={cn(
                  "cube-rn-text",
                  NOTE_ROW,
                  "px-2 py-1.5 text-muted-foreground text-sm",
                  block.className,
                )}
              >
                {block.note}
              </span>
            );
          }
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: nor does a repeated heading
            <SelectGroup key={`block-${index}`}>
              {block.group ? <SelectLabel>{block.group}</SelectLabel> : null}
              {block.options.map((option) => (
                <SelectItem key={option.value} value={option.value} className={option.className}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
          );
        })}
      </SelectContent>
    </SelectRoot>
  );
}
