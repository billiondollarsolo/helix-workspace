import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  ColorModeProvider,
  DialogProvider,
  WebPlatformProvider,
  createWebPlatformHost,
  useColorMode,
} from "@helix/sdk-web";
import { Toaster } from "sonner";
import { routeTree } from "./routeTree.gen";
import { registerPlatformShellContributions } from "./plugins/platform-shell";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      staleTime: 30_000,
      throwOnError: true,
    },
  },
});

const platformHost = createWebPlatformHost({
  queryClient,
  getColorMode: () => {
    const mode = document.documentElement.dataset.colorMode;
    return mode === "light" || mode === "dark" || mode === "system" ? mode : "system";
  },
});

registerPlatformShellContributions(platformHost);

const router = createRouter({
  routeTree,
  context: {
    queryClient,
    platformHost,
  },
  defaultPreload: "intent",
  defaultPendingMinMs: 200,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

function AppProviders() {
  return (
    <StrictMode>
      <ColorModeProvider>
        <WebPlatformProvider host={platformHost} useColorMode={useColorMode}>
          <DialogProvider>
            <QueryClientProvider client={queryClient}>
              <RouterProvider router={router} />
              <Toaster richColors closeButton />
            </QueryClientProvider>
          </DialogProvider>
        </WebPlatformProvider>
      </ColorModeProvider>
    </StrictMode>
  );
}

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Missing #root element.");
}

createRoot(rootElement).render(<AppProviders />);
