import type { QueryClient } from "@tanstack/react-query";
import type { WebPlatformHost } from "@helix/sdk-web";

export interface RouterContext {
  queryClient: QueryClient;
  platformHost: WebPlatformHost;
}
