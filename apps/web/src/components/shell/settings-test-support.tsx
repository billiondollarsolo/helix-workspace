/* Helpers for the settings section tests: a real query client, and a fetch
   mock that answers `/v1/api/...` paths from a table and records each call. */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { vi } from "vitest";
import { sessionQueryKeys } from "@/lib/auth";
import { mount } from "@/test/ui";

export const sessionUser = {
  id: "login-1",
  email: "morgan@example.com",
  name: "Morgan Lee",
  actorId: "00000000-0000-4000-8000-0000000000a1",
  twoFactorEnabled: false,
};

export interface ApiCall {
  readonly path: string;
  readonly method: string;
  readonly body: unknown;
}

type Handler = (body: unknown) => unknown;

/** Answer API paths (without the /v1 prefix) from `routes`; anything else is a 404. */
export function mockApi(routes: Record<string, Handler | object>): ApiCall[] {
  const calls: ApiCall[] = [];
  document.cookie = `helix_csrf=${"p".repeat(43)}; Path=/`;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url, "http://localhost").pathname.replace(/^\/v1/u, "");
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ path, method: init?.method ?? "GET", body });
    const route = routes[path];
    if (route === undefined) {
      return Promise.resolve(
        Response.json({ error: { message: `No mock for ${path}` } }, { status: 404 }),
      );
    }
    const result: unknown = typeof route === "function" ? (route as Handler)(body) : route;
    return Promise.resolve(result instanceof Response ? result : Response.json(result));
  });
  return calls;
}

export function renderWithClient(ui: ReactNode, seed: (client: QueryClient) => void = () => {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQueryKeys.current, sessionUser);
  seed(client);
  const view = mount(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return { client, ...view };
}
