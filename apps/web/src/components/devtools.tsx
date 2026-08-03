import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";

/**
 * Dev-only tooling. Hidden by default when VITE_HELIX_SHOW_DEVTOOLS is not
 * "true" so remote/Tailscale smoke sessions are not covered by the Router
 * Devtools panel (which persists open state and can obscure the app shell).
 */
export function Devtools() {
  if (import.meta.env.VITE_HELIX_SHOW_DEVTOOLS !== "true") {
    return null;
  }

  return (
    <>
      <ReactQueryDevtools buttonPosition="bottom-left" initialIsOpen={false} />
      <TanStackRouterDevtools position="bottom-right" initialIsOpen={false} />
    </>
  );
}
