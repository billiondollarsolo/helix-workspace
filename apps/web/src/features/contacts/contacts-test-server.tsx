/* Test-only helpers for Contacts suites: a fake tool API on top of `fetch`,
   a contact factory, and a mount with a fresh QueryClient. */
import type { Contact } from "@helix/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { vi } from "vitest";
import { mount, type Mounted } from "@/test/ui";

interface ToolCall {
  readonly tool: string;
  readonly body: Record<string, unknown>;
}

type ToolHandler = (body: Record<string, unknown>) => unknown;

/** Stub `fetch` so `/v1/api/tools/<id>` calls go to `handlers`. */
export function fakeContactsApi(handlers: Record<string, ToolHandler>) {
  const calls: ToolCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const tool = /\/api\/tools\/([^/?]+)$/u.exec(url)?.[1];
      if (tool === undefined) {
        return Promise.resolve(Response.json({ error: `unexpected ${url}` }, { status: 500 }));
      }
      const body =
        typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      calls.push({ tool, body });
      const handler = handlers[tool];
      if (handler === undefined) {
        return Promise.resolve(Response.json({ error: `no handler for ${tool}` }, { status: 500 }));
      }
      try {
        return Promise.resolve(Response.json(handler(body) ?? {}));
      } catch (error) {
        return Promise.resolve(
          Response.json({ error: { message: (error as Error).message } }, { status: 400 }),
        );
      }
    }),
  );
  document.cookie = "helix_csrf=test-csrf; path=/";
  return { calls, called: (tool: string) => calls.filter((call) => call.tool === tool) };
}

let nextId = 0;

export function contact(overrides: Partial<Contact> & Pick<Contact, "displayName">): Contact {
  nextId += 1;
  return {
    id: `00000000-0000-4000-8000-${String(nextId).padStart(12, "0")}`,
    givenName: "",
    familyName: "",
    company: "",
    jobTitle: "",
    emails: [],
    phones: [],
    addresses: [],
    birthday: null,
    notes: "",
    labels: [],
    photoDataUrl: null,
    starred: false,
    memberActorId: null,
    updatedAt: "2026-10-01T12:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

export function mountWithQueries(ui: ReactNode): Mounted & { readonly client: QueryClient } {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 }, mutations: { retry: false } },
  });
  return { ...mount(<QueryClientProvider client={client}>{ui}</QueryClientProvider>), client };
}
