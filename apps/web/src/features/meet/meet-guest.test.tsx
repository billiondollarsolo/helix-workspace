// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type * as LiveKit from "livekit-client";
import * as authModule from "@/lib/auth";
import { FakeRoom } from "@/test/livekit";
import { renderWithClient, setReactInputValue, waitForText } from "@/test/meet";
import { MeetGuestPage } from "./meet-guest";
import {
  guestTokenFromHash,
  meetGuestLink,
  postMeetGuestJoin,
  type MeetGuestJoin,
  type MeetGuestJoinInput,
  type MeetGuestJoinResult,
} from "./meet-guest-api";

vi.mock("livekit-client", async (importOriginal) => ({
  ...(await importOriginal<typeof LiveKit>()),
  Room: (await import("@/test/livekit")).FakeRoom,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const TOKEN = "invite-token";

async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  }
}

const guestJoin: MeetGuestJoin = {
  roomId: "room-1",
  roomName: "atlas-sync",
  serverUrl: "wss://workspace.example.test",
  token: "guest-livekit-token",
  recordingActive: false,
  recordingNoticeVersion: "2026-10-15",
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
};

type JoinMock = ReturnType<
  typeof vi.fn<(input: MeetGuestJoinInput, signal: AbortSignal) => Promise<MeetGuestJoinResult>>
>;

function joinReturning(...results: MeetGuestJoinResult[]): JoinMock {
  const mock: JoinMock = vi.fn();
  for (const result of results) mock.mockResolvedValueOnce(result);
  // Anything after the scripted answers keeps the guest waiting.
  mock.mockResolvedValue({ kind: "waiting", retryAfterMs: 1 });
  return mock;
}

describe("MeetGuestPage", () => {
  let container: HTMLDivElement;
  let root: Root;
  let authFetch: MockInstance<typeof authModule.authenticatedFetch>;

  beforeEach(() => {
    FakeRoom.reset();
    localStorage.clear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    // Guests have no session: nothing may call an authenticated API.
    authFetch = vi
      .spyOn(authModule, "authenticatedFetch")
      .mockResolvedValue(Response.json({}, { status: 401 }));
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  function render(join: JoinMock, token = TOKEN) {
    renderWithClient(<MeetGuestPage token={token} join={join} />, root);
  }

  const input = (name: string) =>
    container.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  const button = (text: string) =>
    [...container.querySelectorAll("button")].find((node) => node.textContent.trim() === text) ??
    null;

  function fillAndJoin() {
    act(() => {
      setReactInputValue(input("name")!, "Vera Guest");
      setReactInputValue(input("email")!, "vera@example.com");
    });
    const consent = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].at(
      -1,
    );
    act(() => consent?.click());
    act(() => button("Join")?.click());
  }

  it("asks for the name, email and recording notice before joining", async () => {
    const join = joinReturning();
    render(join);
    expect(container.textContent).toContain("I consent to recording and transcription");
    act(() => button("Join")?.click());
    await waitForText(container, "Enter your name.");
    expect(container.textContent).toContain("Accept the recording notice to join.");
    expect(join).not.toHaveBeenCalled();
  });

  it("waits, keeps checking back with one join grant, then hands off to the call", async () => {
    const join = joinReturning(
      { kind: "waiting", retryAfterMs: 40 },
      { kind: "waiting", retryAfterMs: 40 },
      { kind: "joined", join: guestJoin },
    );
    render(join);
    fillAndJoin();
    await waitForText(container, "Waiting for the host to let you in…");
    await waitFor(() => container.querySelector('main[aria-label="Active meeting"]') !== null);
    await waitFor(() => FakeRoom.instances.length > 0);

    expect(join).toHaveBeenCalledTimes(3);
    const sent = join.mock.calls.map(([sentInput]) => sentInput);
    expect(sent[0]).toMatchObject({
      token: TOKEN,
      email: "vera@example.com",
      name: "Vera Guest",
    });
    expect(new Set(sent.map((value) => value.joinGrantId)).size).toBe(1);
    expect(new Set(sent.map((value) => value.deviceId)).size).toBe(1);

    const room = FakeRoom.latest();
    expect(room.connect).toHaveBeenCalledWith(
      "wss://workspace.example.test",
      "guest-livekit-token",
    );
    // Guest mode: no host, recording or meeting-details controls.
    expect(container.querySelector('button[aria-label="Meeting details"]')).toBeNull();
    expect(container.querySelector('button[aria-label*="recording" i]')).toBeNull();
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="Meeting settings"]')?.disabled,
    ).toBe(true);
    expect(authFetch).not.toHaveBeenCalled();

    act(() => button("Leave")?.click());
    await waitForText(container, "You left the meeting");
    expect(authFetch).not.toHaveBeenCalled();
  });

  it("stops checking back when the guest leaves the waiting screen", async () => {
    const join = joinReturning();
    render(join);
    fillAndJoin();
    await waitForText(container, "Waiting for the host to let you in…");
    act(() => button("Leave")?.click());
    await waitForText(container, "You left the meeting");
    const calls = join.mock.calls.length;
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 30)));
    expect(join.mock.calls.length).toBe(calls);
    expect(join.mock.calls.at(-1)?.[1].aborted).toBe(true);
  });

  it("says so when the host turns the guest away", async () => {
    render(joinReturning({ kind: "waiting", retryAfterMs: 1 }, { kind: "denied" }));
    fillAndJoin();
    await waitForText(container, "The host didn’t let you in.");
  });

  it("says so when the invitation is unknown or expired", async () => {
    render(joinReturning({ kind: "invalid" }));
    fillAndJoin();
    await waitForText(container, "This invitation isn’t valid or has expired.");
  });

  it("treats a link without a token as invalid", () => {
    render(joinReturning(), "");
    expect(container.textContent).toContain("This invitation isn’t valid or has expired.");
  });

  it("lets the guest try again after a validation error", async () => {
    render(joinReturning({ kind: "error", message: "Check your name and email, then try again." }));
    fillAndJoin();
    await waitForText(container, "Check your name and email, then try again.");
    expect(button("Join")).not.toBeNull();
  });
});

describe("postMeetGuestJoin", () => {
  const input: MeetGuestJoinInput = {
    token: TOKEN,
    email: "vera@example.com",
    name: "Vera",
    deviceId: "11111111-1111-4111-8111-111111111111",
    joinGrantId: "22222222-2222-4222-8222-222222222222",
  };

  it.each<[number, unknown, MeetGuestJoinResult]>([
    [202, { waiting: true, retryAfterMs: 3000 }, { kind: "waiting", retryAfterMs: 3000 }],
    [403, { error: "No", denied: true }, { kind: "denied" }],
    [403, { error: "Locked" }, { kind: "blocked" }],
    [404, { error: "Unknown" }, { kind: "invalid" }],
    [
      400,
      { error: "Bad" },
      { kind: "error", message: "Check your name and email, then try again." },
    ],
  ])("maps HTTP %i", async (status, body, expected) => {
    const fetchImpl = vi.fn(() => Promise.resolve(Response.json(body, { status })));
    expect(await postMeetGuestJoin(input, fetchImpl)).toEqual(expected);
  });

  it("posts the consent with the invitation and returns the join payload", async () => {
    const fetchImpl = vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(Response.json(guestJoin)),
    );
    expect(await postMeetGuestJoin(input, fetchImpl)).toEqual({ kind: "joined", join: guestJoin });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("/api/meet/guest/join");
    expect(JSON.parse(init?.body as string)).toEqual({
      ...input,
      recordingNoticeAccepted: true,
      recordingNoticeVersion: "2026-10-15",
    });
  });
});

describe("guest links", () => {
  it("keeps the token in the fragment", () => {
    expect(meetGuestLink("abc.def", "https://ws.example.com")).toBe(
      "https://ws.example.com/meet/guest#abc.def",
    );
    expect(guestTokenFromHash("#abc.def")).toBe("abc.def");
    expect(guestTokenFromHash("abc.def")).toBe("abc.def");
  });
});
