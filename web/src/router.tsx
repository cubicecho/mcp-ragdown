import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { DocsPage } from "@/routes/docs";
import { HomePage } from "@/routes/home";
import { SettingsPage, type SettingsTab } from "@/routes/settings";

const rootRoute = createRootRoute({ component: AppShell });

/** `/` picks a folder: the last one used here, else the first, else offers to make one. */
const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: HomePage,
});

/** `edit` opens `doc` in the editor, once: the page drops it as soon as the editor is open. */
export type DocsSearch = { doc?: string; tag?: string; edit?: boolean };

/**
 * One folder's documents. The selected file (relative to the folder) and the tag filter live in
 * the URL, so a preview can be linked to, reloaded, and walked back through with the browser's
 * own buttons.
 */
const docsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/f/$folder",
  validateSearch: (search: Record<string, unknown>): DocsSearch => ({
    ...(typeof search.doc === "string" && search.doc ? { doc: search.doc } : {}),
    ...(typeof search.tag === "string" && search.tag ? { tag: search.tag } : {}),
    ...(search.edit === true || search.edit === "true" ? { edit: true } : {}),
  }),
  component: DocsPage,
});

const SETTINGS_TABS: readonly string[] = ["folders", "browser", "server"];

/** Settings, with the open tab in the URL. No `tab` is the folders. */
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  validateSearch: (search: Record<string, unknown>): { tab?: SettingsTab } =>
    typeof search.tab === "string" && search.tab !== "folders" && SETTINGS_TABS.includes(search.tab)
      ? { tab: search.tab as SettingsTab }
      : {},
  component: SettingsPage,
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([homeRoute, docsRoute, settingsRoute]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
