export type SearchInputOwnProps = {
  /**
   * The accessible name. A search box usually has no visible label, and an unnamed one is read as
   * "search field" and nothing else. `aria-label` wins over it, and a box pointed at by
   * `aria-labelledby` or an `id` (a `<label htmlFor>`, a `FormField`) takes its name from there
   * unless `label` is passed as well.
   */
  label?: string | undefined;
  /** The clear button's name. Announced, since the ✕ alone says nothing. */
  clearLabel?: string | undefined;
  /**
   * Off, there is no clear button. On, it shows only while there is text to clear, so an empty
   * box is not a box with a dead control in it.
   */
  clearable?: boolean | undefined;
};

/**
 * Hides the ✕ WebKit and Blink draw in a `type="search"` box, so the one clear button is the named
 * one. The web half's alone: react-native-web's reset already hides it, and a device has none.
 */
export const SEARCH_INPUT_CLASS = "[&::-webkit-search-cancel-button]:appearance-none";

export const SEARCH_LABEL = "Search";
export const SEARCH_CLEAR_LABEL = "Clear search";

/**
 * The name to put in `aria-label`, or none. `label` is a default only where nothing else names the
 * box, because `aria-label` outranks a `<label htmlFor>` — a "Search" there would silently replace
 * the visible label a `FormField` drew.
 */
export function searchInputName({
  label,
  ariaLabel,
  ariaLabelledBy,
  id,
}: {
  label: string | undefined;
  ariaLabel: string | undefined;
  ariaLabelledBy: string | undefined;
  id: string | undefined;
}): string | undefined {
  if (ariaLabel !== undefined) return ariaLabel;
  if (label !== undefined) return label;
  return ariaLabelledBy || id ? undefined : SEARCH_LABEL;
}
