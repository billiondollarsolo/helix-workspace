/* Meet test fixtures: a live meetings payload, a tool-call mock and render
   helpers shared by the Meet unit tests. */

import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Root } from "react-dom/client";
import { vi } from "vitest";
import { ShellOverlayContext } from "@/components/shell";
import * as authModule from "@/lib/auth";
import { shellOverlaysForTest } from "@/test/shell-overlays";

const noopOverlays = shellOverlaysForTest();

/* A live `meet.meetings.list` payload covering Today (active) + Recent. */
export const meetingsPayload = {
  meetings: [] as unknown[],
  active: [
    {
      id: "room-1",
      threadId: "thread-1",
      roomName: "atlas-sync",
      subject: "Atlas weekly sync",
      title: "Atlas weekly sync",
      mediaDomain: "meet.localhost",
      status: "active",
      code: "atl-asly-snc",
      host: { actorId: "a1", displayName: "Mira Okafor", email: null, role: "owner" },
      attendees: [],
      attendeeCount: 4,
      startedAt: "2026-05-21T09:00:00.000Z",
      endedAt: null,
      scheduledStartAt: null,
      scheduledEndAt: null,
      durationSeconds: null,
      recorded: false,
      recordingArtifacts: [],
      summaries: [],
      createdAt: "2026-05-21T09:00:00.000Z",
      updatedAt: "2026-05-21T09:00:00.000Z",
    },
  ],
  scheduled: [] as unknown[],
  recent: [
    {
      id: "room-2",
      threadId: "thread-2",
      roomName: "eng-standup",
      subject: "Eng standup",
      title: "Eng standup",
      mediaDomain: "meet.localhost",
      status: "ended",
      code: "eng-stnd-up0",
      host: { actorId: "a1", displayName: "Mira Okafor", email: null, role: "owner" },
      attendees: [],
      attendeeCount: 8,
      startedAt: "2026-05-21T08:00:00.000Z",
      endedAt: "2026-05-21T08:27:00.000Z",
      scheduledStartAt: null,
      scheduledEndAt: null,
      durationSeconds: 1620,
      recorded: true,
      recordingArtifacts: [],
      summaries: [],
      createdAt: "2026-05-21T08:00:00.000Z",
      updatedAt: "2026-05-21T08:27:00.000Z",
    },
  ],
};
meetingsPayload.meetings = [...meetingsPayload.active, ...meetingsPayload.recent];

export function mockTools(handlers: Record<string, () => unknown>) {
  return vi.spyOn(authModule, "authenticatedFetch").mockImplementation((input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const toolId = url.replace("/api/tools/", "");
    const handler = handlers[toolId];
    if (handler === undefined) {
      return Promise.resolve(Response.json({ error: `no mock for ${toolId}` }, { status: 500 }));
    }
    return Promise.resolve(Response.json(handler() as object));
  });
}

export function renderWithClient(node: React.ReactNode, root: Root) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <ShellOverlayContext.Provider value={noopOverlays}>{node}</ShellOverlayContext.Provider>
      </QueryClientProvider>,
    );
  });
}

export function flush() {
  return act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/* Wait until the container shows `text`. On the clock, not for a number of
   turns: the hub's code is loaded on demand, and on a busy machine that takes
   more turns than any fixed count. */
export async function waitForText(container: HTMLElement, text: string) {
  const deadline = Date.now() + 5_000;
  do {
    if (container.textContent.includes(text)) {
      return;
    }
    await flush();
    // Let module loading and timers run, which microtasks alone do not.
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for text: ${text}`);
}

/* Set a controlled input's value through React's native value tracker. */
export function setReactInputValue(input: HTMLInputElement, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  if (descriptor?.set !== undefined) {
    Reflect.apply(descriptor.set, input, [value]);
  } else {
    input.value = value;
  }
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
