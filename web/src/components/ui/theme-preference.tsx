import { useEffect, useSyncExternalStore } from "react";
import {
  isThemePreference,
  THEME_STORAGE_KEY,
  type ThemePreference,
  type ThemePreferenceOptions,
  type ThemePreferenceState,
} from "@/components/ui/theme-preference-base";

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** Every hook on the page, told when one of them writes. `storage` events only reach other tabs. */
const listeners = new Set<() => void>();

/** The choice when storage refused it, so a click still sticks for the life of the page. */
let unsaved: ThemePreference | null = null;

function read(): ThemePreference {
  if (unsaved) return unsaved;
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : "system";
  } catch {
    // Storage switched off, or a sandboxed frame: there is nothing to read, which is `system`.
    return "system";
  }
}

function prefersDark() {
  return typeof window.matchMedia === "function" && window.matchMedia(DARK_QUERY).matches;
}

function apply(preference: ThemePreference) {
  const classes = document.documentElement.classList;
  classes.toggle("dark", preference === "dark" || (preference === "system" && prefersDark()));
  classes.toggle("light", preference === "light");
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  const onStorage = (event: StorageEvent) => {
    if (event.key === THEME_STORAGE_KEY || event.key === null) onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** Module-level, so every caller's setter is the same function and safe in a dependency list. */
function setPreference(next: ThemePreference) {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
    unsaved = null;
  } catch {
    // Not persisted, but still applied: the page should not ignore the click.
    unsaved = next;
  }
  apply(next);
  for (const listener of listeners) listener();
}

/**
 * The stored light / dark / system choice, and a setter that stores and applies it. Call it where
 * the app starts, so the choice is applied — and, on System, kept in step with the device — on
 * every screen, not only the one with the picker on it.
 */
export function useThemePreference(_options: ThemePreferenceOptions = {}): ThemePreferenceState {
  const preference = useSyncExternalStore(subscribe, read, () => "system" as const);

  useEffect(() => {
    apply(preference);
    if (preference !== "system" || typeof window.matchMedia !== "function") return;
    // Following the device means repainting when the device changes, without a reload.
    const query = window.matchMedia(DARK_QUERY);
    const onChange = () => apply("system");
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [preference]);

  return [preference, setPreference] as const;
}
