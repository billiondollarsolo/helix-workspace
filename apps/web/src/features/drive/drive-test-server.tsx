/* Test-only helpers for Drive suites: a fake tool API on top of `fetch`, an
   entry factory, and a mount that provides a fresh QueryClient. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { vi } from "vitest";
import { mount, settle, type Mounted } from "@/test/ui";
import type { DriveApiEntry } from "./api";

export const ME = "00000000-0000-4000-8000-000000000001";
export const OTHER = "00000000-0000-4000-8000-000000000002";

interface ToolCall {
  readonly tool: string;
  readonly body: Record<string, unknown>;
}

type ToolHandler = (body: Record<string, unknown>) => unknown;

/** Stub `fetch`: the session is ME, and `/api/tools/<id>` calls go to `handlers`. */
export function fakeDriveApi(handlers: Record<string, ToolHandler>) {
  const calls: ToolCall[] = [];
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/auth/get-session")) {
      return Promise.resolve(
        Response.json({
          user: { id: "session", email: "owner@helix.test", name: "Owner One", actorId: ME },
        }),
      );
    }
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
        Response.json({ error: { message: (error as Error).message } }, { status: 409 }),
      );
    }
  });
  vi.stubGlobal("fetch", fetchMock);
  document.cookie = "helix_csrf=test-csrf; path=/";
  return {
    calls,
    called: (tool: string) => calls.filter((call) => call.tool === tool),
  };
}

export function entry(
  overrides: Partial<DriveApiEntry> & Pick<DriveApiEntry, "id" | "type" | "name">,
): DriveApiEntry {
  return {
    folderId: null,
    ownerActorId: ME,
    ownerDisplayName: "Owner One",
    uploadState: overrides.type === "file" ? "active" : undefined,
    available: overrides.type === "file" ? true : undefined,
    metadata: {},
    deletedAt: null,
    createdAt: "2026-05-20T12:00:00.000Z",
    updatedAt: "2026-05-20T12:00:00.000Z",
    ...overrides,
  };
}

export function mountWithQueries(ui: ReactNode): Mounted & { readonly client: QueryClient } {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 }, mutations: { retry: false } },
  });
  const mounted = mount(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return { ...mounted, client };
}

/** Let queries resolve and React flush (several rounds of fetch + render). */
export async function flush(rounds = 6): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await settle();
  }
}
