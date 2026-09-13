import { useSyncExternalStore } from "react";

/**
 * Light, dark, or whatever the machine says. A store rather than a context: the toggle in the
 * sidebar is the only writer, and `index.html` has already painted the stored choice.
 */
const KEY = "ragdown.theme";

export type Theme = "light" | "dark" | "system";

const isTheme = (value: string | null): value is Theme =>
  value === "light" || value === "dark" || value === "system";

let current = read();
const listeners = new Set<() => void>();

function read(): Theme {
  try {
    const stored = localStorage.getItem(KEY);
    return isTheme(stored) ? stored : "system";
  } catch {
    // Storage can be denied outright — private windows, blocked site data. Following the OS
    // is the right default anyway; it just will not be remembered.
    return "system";
  }
}

const prefersDark = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;

/** Which of the two we actually paint, once `system` has been asked. */
export const resolveTheme = (theme: Theme): "light" | "dark" =>
  theme === "system" ? (prefersDark() ? "dark" : "light") : theme;

function apply() {
  document.documentElement.classList.toggle("dark", resolveTheme(current) === "dark");
}

export function setTheme(theme: Theme) {
  if (theme === current) return;
  current = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // As above: the choice still holds for this tab.
  }
  apply();
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/**
 * Started once from `main.tsx`. The OS can change its mind while the app is open, and on
 * `system` that has to redraw — so the listener stays attached rather than being read once.
 */
export function startTheme() {
  apply();
  if (typeof matchMedia !== "function") return;
  const query = matchMedia("(prefers-color-scheme: dark)");
  query.addEventListener("change", () => {
    if (current !== "system") return;
    apply();
    for (const listener of listeners) listener();
  });
}

/** What the user chose — `system` stays `system`, because that is what the toggle shows. */
export const useTheme = () =>
  useSyncExternalStore(
    subscribe,
    () => current,
    () => current,
  );

/** What is on the screen. The toaster needs this one: it has no `system` of its own worth using. */
export const useResolvedTheme = () =>
  useSyncExternalStore(
    subscribe,
    () => resolveTheme(current),
    () => "dark" as const,
  );
