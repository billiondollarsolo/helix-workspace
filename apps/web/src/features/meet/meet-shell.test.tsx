// @vitest-environment jsdom

import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as TanStackRouter from "@tanstack/react-router";
import { ShellOverlayContext } from "@/components/shell";
import { MeetShell } from "./meet-shell";
import { MeetCall, RecordingNotice, formatElapsed } from "./meet-call";
import {
  announceRecordingStarted,
  breakoutRoomsFromJitsi,
  meetCapabilitiesFromCommands,
  qualityTelemetryFromJitsi,
} from "./jitsi-external-api";
import type { MeetCallSession } from "./meet-shell";
import * as authModule from "@/lib/auth";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof TanStackRouter>();
  return {
    ...actual,
    useRouter: () => ({ invalidate: () => Promise.resolve() }),
  };
});

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
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
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
    if (container.textContent.includes(text)) {
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
  recordingAvailable: true,
  canStartRecording: true,
  recordingNoticeVersion: "2026-09-02",
  recordingActive: false,
  controls: {
    roomId: "room-1",
    hostActorId: "a1",
    cohostActorIds: [],
    lobbyEnabled: true,
    locked: false,
    mutePolicy: "open",
    presenterPolicy: "everyone",
    presenterSubject: null,
    chatPolicy: "everyone",
    reactionPolicy: "everyone",
    version: 1,
  },
  canModerate: true,
  startedAtMs: Date.now() - 32 * 60 * 1000,
};

/** A session that hasn't yet received its minted join URL. Used to verify the
 *  call view renders a "connecting" placeholder while waiting for the room. */
const pendingSession: MeetCallSession = {
  roomId: "",
  roomName: "qfk-uvtn-pxs",
  subject: "Q3 Roadmap working session",
  code: "qfk-uvtn-pxs",
  jitsiDomain: "meet.localhost",
  token: null,
  joinUrl: null,
  recordingAvailable: false,
  canStartRecording: false,
  recordingNoticeVersion: "2026-09-02",
  recordingActive: false,
  controls: {
    roomId: "",
    hostActorId: null,
    cohostActorIds: [],
    lobbyEnabled: true,
    locked: false,
    mutePolicy: "open",
    presenterPolicy: "everyone",
    presenterSubject: null,
    chatPolicy: "everyone",
    reactionPolicy: "everyone",
    version: 1,
  },
  canModerate: false,
  startedAtMs: Date.now(),
};

afterEach(() => {
  vi.unstubAllGlobals();
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

describe("recording notice", () => {
  it("announces recording audibly", () => {
    const speak = vi.fn();
    vi.stubGlobal(
      "SpeechSynthesisUtterance",
      class {
        constructor(readonly text: string) {}
      },
    );
    vi.stubGlobal("speechSynthesis", { speak });
    announceRecordingStarted();
    expect(speak.mock.calls[0]?.[0]).toMatchObject({ text: "Recording started" });
  });
});

describe("Meet quality telemetry", () => {
  it("keeps only bounded numeric QoS fields from a Jitsi event", () => {
    expect(
      qualityTelemetryFromJitsi({
        participantId: "private-participant",
        token: "secret-token",
        stats: {
          packetLoss: 12,
          jitter: 250,
          rtt: 800,
          bitrate: 50,
          bridgeLoad: 95,
          media: "must-not-leave-the-iframe",
        },
        connectionQuality: 20,
      }),
    ).toEqual({
      event: "quality",
      packetLossPercent: 12,
      jitterMs: 250,
      rttMs: 800,
      bitrateKbps: 50,
      connectionQuality: 20,
      bridgeLoadPercent: 95,
    });
    expect(
      qualityTelemetryFromJitsi({
        connectionQuality: 30,
        jvbRTT: 450,
        bitrate: { download: 40, upload: 50, video: { upload: 45 } },
        packetLoss: { download: 8, upload: 12, total: 10 },
        transport: [{ ip: "must-not-leave-the-iframe", jitter: 125, rtt: 450 }],
      }),
    ).toEqual({
      event: "quality",
      packetLossPercent: 10,
      jitterMs: 125,
      rttMs: 450,
      bitrateKbps: 90,
      connectionQuality: 30,
      bridgeLoadPercent: undefined,
    });
    expect(qualityTelemetryFromJitsi({ packetLoss: 101, rtt: Number.NaN })).toBeNull();
  });
});

describe("Meet product capabilities", () => {
  it("exposes only complete commands supported by the loaded deployment", () => {
    expect(
      meetCapabilitiesFromCommands([
        "toggleTileView",
        "setNoiseSuppressionEnabled",
        "setBlurredBackground",
        "addBreakoutRoom",
        "autoAssignToBreakoutRooms",
        "closeBreakoutRoom",
        "joinBreakoutRoom",
        "toggleSubtitles",
        "startRecording",
      ]),
    ).toEqual({
      tileView: true,
      noiseSuppression: true,
      backgroundBlur: true,
      breakoutRooms: true,
    });
    expect(
      meetCapabilitiesFromCommands([
        "toggleTileView",
        "addBreakoutRoom",
        "autoAssignToBreakoutRooms",
        "joinBreakoutRoom",
      ]).breakoutRooms,
    ).toBe(false);
  });

  it("retains only bounded room summaries from participant-bearing Jitsi payloads", () => {
    expect(
      breakoutRoomsFromJitsi({
        main: {
          id: "main",
          isMainRoom: true,
          participants: { "private@example.test": { displayName: "Private person" } },
        },
        design: {
          id: "design",
          name: "Design",
          jid: "secret@breakout.example.test",
          participants: { one: {}, two: {} },
        },
      }),
    ).toEqual([
      { id: "main", name: "Main room", isMainRoom: true, participantCount: 1 },
      { id: "design", name: "Design", isMainRoom: false, participantCount: 2 },
    ]);
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

  it("surfaces an unavailable indicator when meet.meetings.list errors", async () => {
    vi.spyOn(authModule, "authenticatedFetch").mockResolvedValue(
      Response.json({ error: "boom" }, { status: 500 }),
    );
    renderWithClient(<MeetShell />, root);
    // No fabricated rows — just the surface-level "Meetings unavailable" chip.
    await waitForText(container, "Meetings unavailable");
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
        recordingAvailable: true,
        canStartRecording: true,
        recordingNoticeVersion: "2026-09-02",
        recordingActive: false,
      }),
    });
    renderWithClient(<MeetShell />, root);
    await waitForText(container, "Atlas weekly sync");
    const startButton = [...container.querySelectorAll("button")].find((b) =>
      b.textContent.includes("Start instant meeting"),
    );
    act(() => {
      startButton?.click();
    });
    const consentButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "I consent and join",
    );
    expect(container.textContent).toContain("global all-parties recording policy");
    act(() => {
      consentButton?.click();
    });
    await waitForText(container, "helix.meet/");
    expect(fetchSpy).toHaveBeenCalledWith("/api/tools/meet.create-room", expect.anything());
    expect(fetchSpy).toHaveBeenCalledWith("/api/tools/meet.mint-token", expect.anything());
    const mintCall = fetchSpy.mock.calls.find((call) => call[0] === "/api/tools/meet.mint-token");
    if (mintCall === undefined) throw new Error("Expected Meet token request.");
    const mintBody = JSON.parse(mintCall[1]?.body as string) as Record<string, unknown>;
    expect(mintBody).toMatchObject({
      recordingNoticeAccepted: true,
      recordingNoticeVersion: "2026-09-02",
    });
    expect(mintBody.deviceId).toEqual(expect.any(String));
    expect(mintBody.joinGrantId).toEqual(expect.any(String));
    // Entered the in-call view: the Jitsi host element should be present.
    expect(container.querySelector('[aria-label^="Jitsi meeting:"]')).not.toBeNull();
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
      b.textContent.includes("Schedule for later"),
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
    if (createCall === undefined) throw new Error("Expected Meet room request.");
    const body = JSON.parse(createCall[1]?.body as string) as Record<string, unknown>;
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

  it("renders a Jitsi host element when a token was minted", () => {
    renderWithClient(<MeetCall session={liveSession} onLeave={() => undefined} />, root);
    // Jitsi External API mounts its iframe inside our host div asynchronously,
    // after external_api.js loads. In tests that script never loads, so we just
    // verify the host is wired and the room subject + code are present.
    const host = container.querySelector(`[aria-label="Jitsi meeting: ${liveSession.subject}"]`);
    expect(host).not.toBeNull();
    expect(container.textContent).toContain("helix.meet/atl-asly-snc");
  });

  it("renders a connecting placeholder when no join URL is available yet", () => {
    renderWithClient(<MeetCall session={pendingSession} onLeave={() => undefined} />, root);
    expect(container.textContent).toContain("Waiting for the meeting room to connect");
  });

  it("leaves a live call locally without ending it for everyone", async () => {
    const fetchSpy = mockTools({
      "meet.end-room": () => ({ ...meetingsPayload.recent[0], status: "ended" }),
    });
    const onLeave = vi.fn();
    renderWithClient(<MeetCall session={liveSession} onLeave={onLeave} />, root);
    const leaveButton = [...container.querySelectorAll("button")].find((b) =>
      b.textContent.includes("Leave"),
    );
    act(() => {
      leaveButton?.click();
    });
    await flush();
    expect(fetchSpy).not.toHaveBeenCalledWith("/api/tools/meet.end-room", expect.anything());
    expect(onLeave).toHaveBeenCalled();
  });

  it("does not call meet.end-room when leaving a pending (no-roomId) session", async () => {
    const fetchSpy = vi.spyOn(authModule, "authenticatedFetch");
    const onLeave = vi.fn();
    renderWithClient(<MeetCall session={pendingSession} onLeave={onLeave} />, root);
    const leaveButton = [...container.querySelectorAll("button")].find((b) =>
      b.textContent.includes("Leave"),
    );
    act(() => {
      leaveButton?.click();
    });
    await flush();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(onLeave).toHaveBeenCalled();
  });

  it("toggles the in-call chat panel", () => {
    renderWithClient(<MeetCall session={liveSession} onLeave={() => undefined} />, root);
    expect(container.querySelector('[aria-label="In-call messages"]')).toBeNull();
    const chatButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Show in-call messages"]',
    );
    act(() => {
      chatButton?.click();
    });
    expect(container.querySelector('[aria-label="In-call messages"]')).not.toBeNull();
  });

  it("disables the in-call controls until the Jitsi room reports joined", () => {
    renderWithClient(<MeetCall session={liveSession} onLeave={() => undefined} />, root);
    // External API never finishes loading in jsdom; controls should be wired
    // but disabled. Once videoConferenceJoined fires the disabled flag flips.
    const mic = container.querySelector<HTMLButtonElement>('button[aria-label="Mute microphone"]');
    expect(mic).not.toBeNull();
    expect(mic?.disabled).toBe(true);
  });

  it("accurately disables recording when no healthy recorder was reported", () => {
    renderWithClient(
      <MeetCall
        session={{ ...liveSession, recordingAvailable: false }}
        onLeave={() => undefined}
      />,
      root,
    );
    const recording = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Recording unavailable"]',
    );
    expect(recording).not.toBeNull();
    expect(recording?.disabled).toBe(true);
  });

  it("shows an assertive persistent notice while recording", () => {
    renderWithClient(<RecordingNotice active />, root);
    const notice = container.querySelector('[role="alert"][aria-live="assertive"]');
    expect(notice?.textContent).toContain("audio, video, and shared content");
  });

  it("shows the recording notice immediately to a late joiner", async () => {
    renderWithClient(
      <MeetCall session={{ ...liveSession, recordingActive: true }} onLeave={() => undefined} />,
      root,
    );
    await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Recording in progress",
    );
  });

  it("wires only runtime-supported parity controls to Jitsi", async () => {
    const listeners = new Map<string, (payload: unknown) => void>();
    const executeCommand = vi.fn();
    class FakeJitsiApi {
      addListener(event: string, handler: (payload: unknown) => void) {
        listeners.set(event, handler);
      }
      executeCommand = executeCommand;
      getSupportedCommands = () => [
        "toggleTileView",
        "setNoiseSuppressionEnabled",
        "setBlurredBackground",
        "addBreakoutRoom",
        "autoAssignToBreakoutRooms",
        "closeBreakoutRoom",
        "joinBreakoutRoom",
      ];
      listBreakoutRooms = () =>
        Promise.resolve({
          design: { id: "design", name: "Design", participants: { one: {}, two: {} } },
        });
      getIFrame = () => null;
      dispose() {}
    }
    vi.stubGlobal("JitsiMeetExternalAPI", FakeJitsiApi);

    renderWithClient(
      <MeetCall
        session={{ ...liveSession, jitsiDomain: "parity.localhost" }}
        onLeave={() => undefined}
      />,
      root,
    );
    await flush();
    act(() => listeners.get("videoConferenceJoined")?.({}));
    await flush();

    const options = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Show call options"]',
    );
    act(() => options?.click());
    await waitForText(container, "Design (2)");

    for (const label of [
      "Use tile layout",
      "Enable noise suppression",
      "Blur background",
      "Add breakout room",
      "Auto-assign participants",
      "Join Design",
      "Close Design",
    ]) {
      const button = [...container.querySelectorAll("button")].find(
        (candidate) => candidate.textContent === label || candidate.ariaLabel === label,
      );
      act(() => button?.click());
    }

    expect(executeCommand.mock.calls).toEqual(
      expect.arrayContaining([
        ["toggleTileView"],
        ["setNoiseSuppressionEnabled", { enabled: true }],
        ["setBlurredBackground", "blur"],
        ["addBreakoutRoom"],
        ["autoAssignToBreakoutRooms"],
        ["joinBreakoutRoom", "design"],
        ["closeBreakoutRoom", "design"],
      ]),
    );
    expect(container.textContent).not.toMatch(/captions|polls|livestream|whiteboard/iu);
  });
});
