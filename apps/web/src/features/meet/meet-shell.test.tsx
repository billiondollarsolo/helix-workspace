// @vitest-environment jsdom

import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShellOverlayContext } from "@/components/shell";
import { MeetShell } from "./meet-shell";
import { MeetCall, formatElapsed } from "./meet-call";
import { MeetCallTile } from "./meet-call-tile";
import type { MeetCallSession } from "./meet-shell";
import {
  CALL_PARTICIPANTS,
  RECENT_MEETINGS,
  SCHEDULED_MEETINGS,
} from "./meet-seed";
import * as authModule from "@/lib/auth";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const noopOverlays = {
  openNotifications: () => undefined,
  openPalette: () => undefined,
  openSettings: () => undefined,
};

/* A live `meet.meetings.list` payload covering Today (active) + Recent. */
const meetingsPayload = {
  meetings: [] as unknown[],
  active: [
    {
      id: "room-1",
      threadId: "thread-1",
      roomName: "atlas-sync",
      subject: "Atlas weekly sync",
      title: "Atlas weekly sync",
      jitsiDomain: "meet.localhost",
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
      jitsiDomain: "meet.localhost",
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

function mockTools(handlers: Record<string, () => unknown>) {
  return vi.spyOn(authModule, "authenticatedFetch").mockImplementation((input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const toolId = url.replace("/api/tools/", "");
    const handler = handlers[toolId];
    if (handler === undefined) {
      return Promise.resolve(Response.json({ error: `no mock for ${toolId}` }, { status: 500 }));
    }
    return Promise.resolve(Response.json(handler() as object));
  });
}

function renderWithClient(node: React.ReactNode, root: Root) {
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

function flush() {
  return act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/* Repeatedly flush microtasks until the container shows `text` (or give up). */
async function waitForText(container: HTMLElement, text: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (container.textContent?.includes(text) ?? false) {
      return;
    }
    await flush();
  }
  throw new Error(`Timed out waiting for text: ${text}`);
}

/* Set a controlled input's value through React's native value tracker. */
function setReactInputValue(input: HTMLInputElement, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  if (descriptor?.set !== undefined) {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- invoking a known setter
    Reflect.apply(descriptor.set, input, [value]);
  } else {
    input.value = value;
  }
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const liveSession: MeetCallSession = {
  roomId: "room-1",
  roomName: "atlas-sync",
  subject: "Atlas weekly sync",
  code: "atl-asly-snc",
  jitsiDomain: "meet.localhost",
  token: "jwt-token",
  joinUrl: "https://meet.localhost/atlas-sync?jwt=jwt-token",
  startedAtMs: Date.now() - 32 * 60 * 1000,
};

const offlineSession: MeetCallSession = {
  roomId: "",
  roomName: "qfk-uvtn-pxs",
  subject: "Q3 Roadmap working session",
  code: "qfk-uvtn-pxs",
  jitsiDomain: "meet.localhost",
  token: null,
  joinUrl: null,
  startedAtMs: Date.now(),
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("formatElapsed", () => {
  it("formats sub-hour durations as M:SS", () => {
    expect(formatElapsed(32 * 60 + 14)).toBe("32:14");
    expect(formatElapsed(9)).toBe("0:09");
  });

  it("formats hour-plus durations as H:MM:SS", () => {
    expect(formatElapsed(3661)).toBe("1:01:01");
  });

  it("clamps negative input to zero", () => {
    expect(formatElapsed(-5)).toBe("0:00");
  });
});

describe("Meet seed data (offline fallback)", () => {
  it("has one in-progress meeting in the Today list", () => {
    expect(SCHEDULED_MEETINGS.filter((meeting) => meeting.inProgress)).toHaveLength(1);
  });

  it("gives every scheduled meeting a meeting code", () => {
    for (const meeting of SCHEDULED_MEETINGS) {
      expect(meeting.code.length).toBeGreaterThan(0);
    }
  });

  it("seeds three recent meetings, two recorded", () => {
    expect(RECENT_MEETINGS).toHaveLength(3);
    expect(RECENT_MEETINGS.filter((meeting) => meeting.recorded)).toHaveLength(2);
  });

  it("has exactly one active speaker and one local user", () => {
    expect(CALL_PARTICIPANTS.filter((participant) => participant.speaking)).toHaveLength(1);
    expect(CALL_PARTICIPANTS.filter((participant) => participant.you)).toHaveLength(1);
  });
});

describe("MeetShell hub", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("renders backend meetings from meet.meetings.list", async () => {
    mockTools({ "meet.meetings.list": () => meetingsPayload });
    renderWithClient(<MeetShell />, root);
    await waitForText(container, "Atlas weekly sync");
    expect(container.textContent).toContain("Start a call");
    expect(container.textContent).toContain("Eng standup");
  });

  it("falls back to seed data when meet.meetings.list errors", async () => {
    vi.spyOn(authModule, "authenticatedFetch").mockResolvedValue(
      Response.json({ error: "boom" }, { status: 500 }),
    );
    renderWithClient(<MeetShell />, root);
    await waitForText(container, "Offline data");
    expect(container.textContent).toContain("Q3 Roadmap working session");
  });

  it("starts an instant meeting via meet.create-room + meet.mint-token", async () => {
    const fetchSpy = mockTools({
      "meet.meetings.list": () => meetingsPayload,
      "meet.create-room": () => ({
        id: "room-new",
        threadId: "t",
        roomName: "instant-room",
        subject: "Instant meeting",
        jitsiDomain: "meet.localhost",
        status: "active",
        createdByActorId: "a1",
        startedAt: "2026-05-21T10:00:00.000Z",
        endedAt: null,
        createdAt: "2026-05-21T10:00:00.000Z",
        updatedAt: "2026-05-21T10:00:00.000Z",
      }),
      "meet.mint-token": () => ({
        roomId: "room-new",
        roomName: "instant-room",
        jitsiDomain: "meet.localhost",
        token: "jwt",
        joinUrl: "https://meet.localhost/instant-room?jwt=jwt",
        expiresAt: "2026-05-21T11:00:00.000Z",
      }),
    });
    renderWithClient(<MeetShell />, root);
    await waitForText(container, "Atlas weekly sync");
    const startButton = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Start instant meeting"),
    );
    act(() => {
      startButton?.click();
    });
    await waitForText(container, "REC");
    expect(fetchSpy).toHaveBeenCalledWith("/api/tools/meet.create-room", expect.anything());
    expect(fetchSpy).toHaveBeenCalledWith("/api/tools/meet.mint-token", expect.anything());
    // Entered the in-call view, with the live Jitsi embed.
    expect(container.querySelector("iframe")).not.toBeNull();
  });

  it("opens the schedule dialog and calls meet.create-room with a window", async () => {
    const fetchSpy = mockTools({
      "meet.meetings.list": () => meetingsPayload,
      "meet.create-room": () => ({
        id: "room-sched",
        threadId: "t",
        roomName: "sched-room",
        subject: "Planning",
        jitsiDomain: "meet.localhost",
        status: "scheduled",
        createdByActorId: "a1",
        startedAt: "2026-05-22T10:00:00.000Z",
        endedAt: null,
        createdAt: "2026-05-21T10:00:00.000Z",
        updatedAt: "2026-05-21T10:00:00.000Z",
      }),
    });
    renderWithClient(<MeetShell />, root);
    await flush();
    const scheduleButton = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Schedule for later"),
    );
    act(() => {
      scheduleButton?.click();
    });
    const titleInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="Meeting title"]',
    );
    expect(titleInput).not.toBeNull();
    act(() => {
      if (titleInput) {
        setReactInputValue(titleInput, "Planning");
      }
    });
    const submit = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Schedule",
    );
    act(() => {
      submit?.click();
    });
    await flush();
    expect(fetchSpy).toHaveBeenCalledWith("/api/tools/meet.create-room", expect.anything());
    const createCall = fetchSpy.mock.calls.find(
      (call) => call[0] === "/api/tools/meet.create-room",
    );
    const body = JSON.parse((createCall?.[1]?.body as string) ?? "{}") as Record<string, unknown>;
    expect(body.scheduledStartAt).toBeDefined();
    expect(body.scheduledEndAt).toBeDefined();
  });
});

describe("MeetCall", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("embeds the live Jitsi room when a token was minted", () => {
    renderWithClient(<MeetCall session={liveSession} onLeave={() => undefined} />, root);
    const iframe = container.querySelector("iframe");
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute("src")).toBe(liveSession.joinUrl);
    expect(container.textContent).toContain("helix.meet/atl-asly-snc");
  });

  it("renders the offline-fallback seed stage without a token", () => {
    renderWithClient(<MeetCall session={offlineSession} onLeave={() => undefined} />, root);
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.textContent).toContain("Q3 Roadmap working session");
  });

  it("ends the room via meet.end-room when leaving a live call", async () => {
    const fetchSpy = mockTools({
      "meet.end-room": () => ({ ...meetingsPayload.recent[0], status: "ended" }),
    });
    const onLeave = vi.fn();
    renderWithClient(<MeetCall session={liveSession} onLeave={onLeave} />, root);
    const leaveButton = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Leave"),
    );
    act(() => {
      leaveButton?.click();
    });
    await flush();
    expect(fetchSpy).toHaveBeenCalledWith("/api/tools/meet.end-room", expect.anything());
    expect(onLeave).toHaveBeenCalled();
  });

  it("leaves an offline call without calling meet.end-room", async () => {
    const fetchSpy = vi.spyOn(authModule, "authenticatedFetch");
    const onLeave = vi.fn();
    renderWithClient(<MeetCall session={offlineSession} onLeave={onLeave} />, root);
    const leaveButton = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Leave"),
    );
    act(() => {
      leaveButton?.click();
    });
    await flush();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(onLeave).toHaveBeenCalled();
  });

  it("toggles the in-call chat panel", () => {
    renderWithClient(<MeetCall session={offlineSession} onLeave={() => undefined} />, root);
    expect(container.querySelector('[aria-label="In-call messages"]')).toBeNull();
    const chatButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Show in-call messages"]',
    );
    act(() => {
      chatButton?.click();
    });
    expect(container.querySelector('[aria-label="In-call messages"]')).not.toBeNull();
  });

  it("flips the mic control to a danger state when muted", () => {
    renderWithClient(<MeetCall session={offlineSession} onLeave={() => undefined} />, root);
    const muteButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Mute microphone"]',
    );
    act(() => {
      muteButton?.click();
    });
    expect(container.querySelector('button[aria-label="Unmute microphone"]')).not.toBeNull();
  });
});

describe("MeetCallTile", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("marks the active speaker tile", () => {
    act(() => {
      root.render(
        <MeetCallTile
          participant={{
            id: "p2",
            name: "Mira Okafor",
            muted: false,
            video: true,
            speaking: true,
          }}
        />,
      );
    });
    expect(container.querySelector('[data-speaking="true"]')).not.toBeNull();
  });

  it("renders a raised-hand badge", () => {
    act(() => {
      root.render(
        <MeetCallTile
          participant={{
            id: "p6",
            name: "Sasha Levin",
            muted: false,
            video: false,
            speaking: false,
            hand: true,
          }}
        />,
      );
    });
    expect(
      container.querySelector('[aria-label="Sasha Levin raised their hand"]'),
    ).not.toBeNull();
  });
});
