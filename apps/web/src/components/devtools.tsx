import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";

export function Devtools() {
  return (
    <>
      <ReactQueryDevtools buttonPosition="bottom-left" initialIsOpen={false} />
      <TanStackRouterDevtools position="bottom-right" />
    </>
  );
}
