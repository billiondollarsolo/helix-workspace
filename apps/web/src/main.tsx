import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DialogProvider, WebPlatformProvider, createWebPlatformHost } from "@helix/sdk-web";
import { useColorMode } from "@/components/color-mode";
import { AppToaster } from "@/components/ui/toast";
import { QUERY_RETRY_DEFAULTS } from "@/lib/query-retry";
import { routeTree } from "./routeTree.gen";
import "./styles.css";
// Side-effect import: hydrates the appearance store (theme/density/accent)
// from localStorage and applies it to the document root.
import "@/components/settings-store";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      ...QUERY_RETRY_DEFAULTS,
      staleTime: 30_000,
      // Background failures must not unmount a working screen or discard drafts.
      throwOnError: (_error, query) => query.state.data === undefined,
    },
    mutations: { retry: false },
  },
});

const platformHost = createWebPlatformHost({ queryClient });

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
      <WebPlatformProvider host={platformHost} useColorMode={useColorMode}>
        <DialogProvider>
          <QueryClientProvider client={queryClient}>
            <RouterProvider router={router} />
            <AppToaster />
          </QueryClientProvider>
        </DialogProvider>
      </WebPlatformProvider>
    </StrictMode>
  );
}

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Missing #root element.");
}

createRoot(rootElement).render(<AppProviders />);
