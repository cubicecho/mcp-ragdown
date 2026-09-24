import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { DocsPage } from "@/routes/docs";
import { SettingsPage } from "@/routes/settings";

const rootRoute = createRootRoute({ component: AppShell });

/**
 * The selected file lives in the URL, so a preview can be linked to, reloaded, and walked back
 * through with the browser's own buttons.
 */
const docsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: (search: Record<string, unknown>): { doc?: string } =>
    typeof search.doc === "string" && search.doc ? { doc: search.doc } : {},
  component: DocsPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsPage,
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([docsRoute, settingsRoute]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
