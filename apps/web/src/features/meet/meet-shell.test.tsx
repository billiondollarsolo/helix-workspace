// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as TanStackRouter from "@tanstack/react-router";
import type * as LiveKit from "livekit-client";
import { MeetCall, RecordingNotice, formatElapsed } from "./meet-call";
import { announceRecordingStarted } from "./meet-call-controls";
import { sessionFromToken } from "./meet-join";
import type { MeetCallSession } from "./meet-shell";
import type { MeetTokenRecord } from "./api";
import * as authModule from "@/lib/auth";
import { FakeRoom } from "@/test/livekit";
import { flush, meetingsPayload, mockTools, renderWithClient } from "@/test/meet";

vi.mock("livekit-client", async (importOriginal) => ({
  ...(await importOriginal<typeof LiveKit>()),
  Room: (await import("@/test/livekit")).FakeRoom,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof TanStackRouter>();
  return {
    ...actual,
    useRouter: () => ({ invalidate: () => Promise.resolve() }),
  };
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const liveSession: MeetCallSession = {
  roomId: "room-1",
  roomName: "atlas-sync",
  subject: "Atlas weekly sync",
  code: "atl-asly-snc",
  serverUrl: "wss://workspace.example.test",
  token: "livekit-token",
  recordingAvailable: true,
  canStartRecording: true,
  recordingNoticeVersion: "2026-10-15",
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
  media: { audioMuted: false, videoMuted: false, audioInputId: null, videoInputId: null },
};

/** A session that hasn't yet received its minted join URL. Used to verify the
 *  call view renders a "connecting" placeholder while waiting for the room. */
const pendingSession: MeetCallSession = {
  roomId: "",
  roomName: "qfk-uvtn-pxs",
  subject: "Q3 Roadmap working session",
  code: "qfk-uvtn-pxs",
  serverUrl: null,
  token: null,
  recordingAvailable: false,
  canStartRecording: false,
  recordingNoticeVersion: "2026-10-15",
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
  media: { audioMuted: false, videoMuted: false, audioInputId: null, videoInputId: null },
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

describe("sessionFromToken", () => {
  const token: MeetTokenRecord = {
    roomId: "room-1",
    roomName: "atlas-sync",
    serverUrl: "wss://workspace.example.test",
    token: "livekit-token",
    joinUrl: "wss://workspace.example.test",
    expiresAt: "2026-10-21T10:05:00.000Z",
    recordingAvailable: false,
    canStartRecording: false,
    recordingNoticeVersion: "2026-10-15",
    recordingActive: false,
    controls: liveSession.controls,
    canModerate: false,
  };
  const room = {
    roomName: "atlas-sync",
    subject: "Atlas weekly sync",
    code: "atl-asly-snc",
    startedAtMs: 1,
    media: liveSession.media,
  };

  it("carries the LiveKit server URL and token into the call session", () => {
    expect(sessionFromToken(token, room)).toMatchObject({
      roomId: "room-1",
      serverUrl: "wss://workspace.example.test",
      token: "livekit-token",
      media: liveSession.media,
    });
  });

  it("treats a missing or empty server URL as not connectable", () => {
    expect(sessionFromToken({ ...token, serverUrl: "" }, room).serverUrl).toBeNull();
    const withoutUrl = Object.fromEntries(
      Object.entries(token).filter(([key]) => key !== "serverUrl"),
    ) as unknown as MeetTokenRecord;
    expect(sessionFromToken(withoutUrl, room).serverUrl).toBeNull();
  });
});

describe("MeetCall", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    FakeRoom.reset();
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

  it("connects LiveKit with the session server URL and token and renders the grid", async () => {
    renderWithClient(<MeetCall session={liveSession} onLeave={() => undefined} />, root);
    await flush();
    expect(FakeRoom.latest().connect).toHaveBeenCalledWith(
      "wss://workspace.example.test",
      "livekit-token",
    );
    const stage = container.querySelector(`[aria-label="Meeting: ${liveSession.subject}"]`);
    expect(stage).not.toBeNull();
    expect(container.querySelector('[aria-label="Meeting details"]')?.textContent).toContain(
      "atl-asly-snc",
    );
  });

  it("renders a connecting placeholder when no join URL is available yet", () => {
    renderWithClient(<MeetCall session={pendingSession} onLeave={() => undefined} />, root);
    expect(container.textContent).toContain("Waiting for the meeting room to connect");
    expect(FakeRoom.instances).toHaveLength(0);
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

  it("disables the in-call controls until the room reports joined", async () => {
    FakeRoom.connectError = new Error("signal connection failed");
    renderWithClient(<MeetCall session={liveSession} onLeave={() => undefined} />, root);
    await flush();
    const mic = container.querySelector<HTMLButtonElement>('button[aria-label="Mute microphone"]');
    expect(mic).not.toBeNull();
    expect(mic?.disabled).toBe(true);
    expect(container.textContent).toContain("signal connection failed");
  });

  it("enables controls once joined and offers only LiveKit-supported features", async () => {
    renderWithClient(<MeetCall session={liveSession} onLeave={() => undefined} />, root);
    await flush();
    await flush();
    const mic = container.querySelector<HTMLButtonElement>('button[aria-label="Mute microphone"]');
    expect(mic?.disabled).toBe(false);
    expect(container.querySelector('button[aria-label="Share screen"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Raise hand"]')).not.toBeNull();

    const options = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Show call options"]',
    );
    act(() => options?.click());
    const labels = [...container.querySelectorAll("button")].map((button) => button.textContent);
    expect(labels).toEqual(
      expect.arrayContaining(["Use speaker layout", "Disable noise suppression"]),
    );
    expect(container.textContent).not.toMatch(/breakout|blur/iu);
  });

  it("hides chat and screen share when the join token does not grant them", async () => {
    renderWithClient(<MeetCall session={liveSession} onLeave={() => undefined} />, root);
    await flush();
    await flush();
    const room = FakeRoom.latest();
    act(() => {
      room.localParticipant.permissions = {
        canPublish: true,
        canPublishData: false,
        canPublishSources: [1, 2],
        canUpdateMetadata: true,
      };
      room.emit("participantPermissionsChanged", undefined, room.localParticipant);
    });
    expect(container.querySelector('button[aria-label="Show in-call messages"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Share screen"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Raise hand"]')).not.toBeNull();
  });

  it("badges unread chat while the panel is closed and clears it on open", async () => {
    renderWithClient(<MeetCall session={liveSession} onLeave={() => undefined} />, root);
    await flush();
    await flush();
    const room = FakeRoom.latest();
    const remote = room.addRemote("actor-2", "Ana");
    act(() => {
      room.emit(
        "dataReceived",
        new TextEncoder().encode(JSON.stringify({ id: "m1", text: "hello" })),
        remote,
        0,
        "chat",
      );
    });
    const chatButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Show in-call messages"]',
    );
    expect(chatButton?.textContent).toContain("1");
    act(() => chatButton?.click());
    expect(container.querySelector('[aria-label="In-call messages"]')?.textContent).toContain(
      "hello",
    );
    expect(
      container.querySelector('button[aria-label="Hide in-call messages"]')?.textContent,
    ).not.toContain("1");
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
    // LiveKit reports the running recording once connected.
    FakeRoom.latest().isRecording = true;
    await flush();
    await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Recording in progress",
    );
  });
});
