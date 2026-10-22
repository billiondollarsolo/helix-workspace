// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type * as LiveKit from "livekit-client";
import * as authModule from "@/lib/auth";
import { FakeRoom } from "@/test/livekit";
import { flush, renderWithClient } from "@/test/meet";
import { settle } from "@/test/ui";
import { MeetCall } from "./meet-call";
import type { MeetCallSession } from "./meet-shell";

vi.mock("livekit-client", async (importOriginal) => ({
  ...(await importOriginal<typeof LiveKit>()),
  Room: (await import("@/test/livekit")).FakeRoom,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const session: MeetCallSession = {
  roomId: "room-1",
  roomName: "atlas-sync",
  subject: "Atlas weekly sync",
  code: "atl-asly-snc",
  serverUrl: "wss://workspace.example.test",
  token: "livekit-token",
  recordingAvailable: false,
  canStartRecording: false,
  recordingNoticeVersion: "2026-10-15",
  recordingActive: false,
  controls: {
    roomId: "room-1",
    hostActorId: "a1",
    cohostActorIds: [],
    lobbyEnabled: false,
    locked: false,
    mutePolicy: "open",
    presenterPolicy: "everyone",
    presenterSubject: null,
    chatPolicy: "everyone",
    reactionPolicy: "everyone",
    version: 1,
  },
  canModerate: true,
  startedAtMs: Date.now(),
  media: { audioMuted: true, videoMuted: true, audioInputId: null, videoInputId: null },
};

describe("MeetCall leave", () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchSpy: MockInstance<typeof authModule.authenticatedFetch>;

  beforeEach(() => {
    FakeRoom.reset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    fetchSpy = vi
      .spyOn(authModule, "authenticatedFetch")
      .mockImplementation(() => Promise.resolve(Response.json({})));
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  async function joinAndLeave(callSession: MeetCallSession, setup?: (room: FakeRoom) => void) {
    const onLeave = vi.fn();
    renderWithClient(<MeetCall session={callSession} onLeave={onLeave} />, root);
    await flush();
    await flush();
    const room = FakeRoom.latest();
    if (setup !== undefined) act(() => setup(room));
    await settle();
    const leaveButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Leave",
    );
    act(() => leaveButton?.click());
    await settle();
    const ended = fetchSpy.mock.calls.some(([input]) => input === "/api/tools/meet.end-room");
    return { ended, onLeave };
  }

  it("ends the meeting when the host leaves an empty call", async () => {
    const { ended, onLeave } = await joinAndLeave(session, (room) => {
      room.addRemote("EG_recorder", "");
    });
    expect(ended).toBe(true);
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it("keeps the meeting going when someone else is still in it", async () => {
    const { ended, onLeave } = await joinAndLeave(session, (room) => {
      room.addRemote("user-2", "Sam");
    });
    expect(ended).toBe(false);
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it("never ends the meeting for an attendee", async () => {
    const { ended } = await joinAndLeave({ ...session, canModerate: false });
    expect(ended).toBe(false);
  });
});
