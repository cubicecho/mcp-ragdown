import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TokenGate } from "@/components/token-gate";
import { useThemePreference } from "@/components/ui/theme-preference";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ApiError } from "@/lib/api";
import { router } from "@/router";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: true,
      // A 4xx is an answer, not a blip: retrying a 401 or a 404 only delays saying so.
      retry: (failures, error) =>
        !(error instanceof ApiError && error.status < 500) && failures < 2,
    },
  },
});

/**
 * Applies the stored theme on every screen, the token gate included, and keeps "system" in step
 * with the OS while the app is open. `index.html` has already painted it before this mounts.
 */
function App() {
  useThemePreference();
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <TokenGate>
          <RouterProvider router={router} />
        </TokenGate>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
