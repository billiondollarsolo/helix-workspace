// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as LiveKit from "livekit-client";
import * as authModule from "@/lib/auth";
import { FakeRoom } from "@/test/livekit";
import { flush, renderWithClient, waitForText } from "@/test/meet";
import { settle } from "@/test/ui";
import { MeetCall } from "./meet-call";
import type { MeetLobbyRequest } from "./api";
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
  startedAtMs: Date.now(),
  media: { audioMuted: true, videoMuted: true, audioInputId: null, videoInputId: null },
};

const vera: MeetLobbyRequest = {
  participantSubject: "guest:invite-1",
  displayName: "Vera",
  requestedAt: "2026-10-21T10:00:00.000Z",
};
const sam: MeetLobbyRequest = {
  participantSubject: "guest:invite-2",
  displayName: "Sam",
  requestedAt: "2026-10-21T10:00:05.000Z",
};

function mockTools(replies: Record<string, () => unknown>) {
  return vi.spyOn(authModule, "authenticatedFetch").mockImplementation((input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const reply = replies[url.replace("/api/tools/", "")];
    if (reply === undefined) return Promise.resolve(Response.json({}, { status: 404 }));
    return Promise.resolve(Response.json(reply()));
  });
}

function toolCalls(spy: ReturnType<typeof mockTools>, toolId: string) {
  return spy.mock.calls.filter(([input]) => input === `/api/tools/${toolId}`);
}

describe("MeetCall lobby", () => {
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
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  async function joinCall(callSession: MeetCallSession = session) {
    renderWithClient(<MeetCall session={callSession} onLeave={() => undefined} />, root);
    await flush();
    await flush();
    return FakeRoom.latest();
  }

  const button = (label: string) =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

  it("shows who is waiting and admits them through the server", async () => {
    let waiting: MeetLobbyRequest[] = [vera];
    const spy = mockTools({
      "meet.lobby.list": () => ({ waiting }),
      "meet.lobby.admit": () => {
        waiting = [];
        return { admitted: true };
      },
    });
    await joinCall();
    await waitForText(container, "Vera is waiting to join");
    expect(toolCalls(spy, "meet.lobby.list")[0]?.[1]).toMatchObject({
      body: JSON.stringify({ roomId: "room-1" }),
    });
    const listed = toolCalls(spy, "meet.lobby.list").length;

    act(() => button("Admit Vera")?.click());
    await settle();
    await settle();
    expect(toolCalls(spy, "meet.lobby.admit")[0]?.[1]).toMatchObject({
      body: JSON.stringify({ roomId: "room-1", participantSubject: "guest:invite-1" }),
    });
    expect(toolCalls(spy, "meet.lobby.list").length).toBeGreaterThan(listed);
    expect(container.textContent).not.toContain("is waiting to join");
  });

  it("denies a guest and lists several waiting at once", async () => {
    let waiting: MeetLobbyRequest[] = [vera, sam];
    const spy = mockTools({
      "meet.lobby.list": () => ({ waiting }),
      "meet.lobby.deny": () => {
        waiting = [vera];
        return { denied: true };
      },
    });
    await joinCall();
    await waitForText(container, "2 people are waiting to join");
    expect(container.textContent).toContain("Sam");

    act(() => button("Deny Sam")?.click());
    await waitForText(container, "Vera is waiting to join");
    expect(toolCalls(spy, "meet.lobby.deny")[0]?.[1]).toMatchObject({
      body: JSON.stringify({ roomId: "room-1", participantSubject: "guest:invite-2" }),
    });
  });

  it("refetches the list when the server's lobby message arrives", async () => {
    let waiting: MeetLobbyRequest[] = [];
    const spy = mockTools({ "meet.lobby.list": () => ({ waiting }) });
    const room = await joinCall();
    await settle();
    const listed = toolCalls(spy, "meet.lobby.list").length;
    expect(listed).toBe(1);

    waiting = [vera];
    act(() => {
      room.emit(
        "dataReceived",
        new TextEncoder().encode(JSON.stringify({ type: "lobby.waiting" })),
        undefined,
        0,
        "helix.lobby",
      );
    });
    await waitForText(container, "Vera is waiting to join");
    expect(toolCalls(spy, "meet.lobby.list").length).toBe(listed + 1);

    // Other topics and payloads don't trigger a refetch.
    act(() => {
      room.emit("dataReceived", new TextEncoder().encode("{}"), undefined, 0, "helix.lobby");
    });
    await settle();
    expect(toolCalls(spy, "meet.lobby.list").length).toBe(listed + 1);
  });

  it("doesn't ask for the lobby when the participant can't moderate", async () => {
    const spy = mockTools({ "meet.lobby.list": () => ({ waiting: [vera] }) });
    await joinCall({ ...session, canModerate: false });
    await settle();
    expect(toolCalls(spy, "meet.lobby.list")).toHaveLength(0);
    expect(container.textContent).not.toContain("waiting to join");
  });

  it("names what the lobby toggle does", async () => {
    mockTools({ "meet.lobby.list": () => ({ waiting: [] }) });
    await joinCall();
    act(() => button("Meeting settings")?.click());
    expect(container.textContent).toContain("Guests wait in lobby: on");
    expect(container.textContent).toContain("Invite guest");
  });
});
