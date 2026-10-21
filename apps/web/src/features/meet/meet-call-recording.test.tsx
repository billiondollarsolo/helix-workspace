// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as LiveKit from "livekit-client";
import { MeetCall } from "./meet-call";
import { recordingAudience } from "./meet-call-recording";
import type { MeetCallSession } from "./meet-shell";
import * as authModule from "@/lib/auth";
import { FakeRoom } from "@/test/livekit";
import { flush, renderWithClient } from "@/test/meet";
import { axeViolations, settle } from "@/test/ui";

vi.mock("livekit-client", async (importOriginal) => ({
  ...(await importOriginal<typeof LiveKit>()),
  Room: (await import("@/test/livekit")).FakeRoom,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const moderatorSession: MeetCallSession = {
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
  startedAtMs: Date.now(),
  media: { audioMuted: true, videoMuted: true, audioInputId: null, videoInputId: null },
};

type ToolReply = { readonly status?: number; readonly body: unknown } | Promise<Response>;

/** Answers `/api/tools/<id>` from `replies`; the session lookup gets a user. */
function mockToolFetch(replies: Record<string, () => ToolReply>) {
  return vi.spyOn(authModule, "authenticatedFetch").mockImplementation((input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const reply = replies[url.replace("/api/tools/", "")];
    if (reply === undefined) return Promise.resolve(Response.json({}, { status: 404 }));
    const value = reply();
    if (value instanceof Promise) return value;
    return Promise.resolve(Response.json(value.body, { status: value.status ?? 200 }));
  });
}

function toolCalls(fetchSpy: ReturnType<typeof mockToolFetch>, toolId: string) {
  return fetchSpy.mock.calls.filter(([input]) => input === `/api/tools/${toolId}`);
}

describe("MeetCall recording", () => {
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

  async function joinCall(session: MeetCallSession = moderatorSession) {
    renderWithClient(<MeetCall session={session} onLeave={() => undefined} />, root);
    await flush();
    await flush();
    return FakeRoom.latest();
  }

  const recordButton = () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Start recording"]');
  const stopButton = () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Stop recording"]');
  const recPill = () =>
    [...container.querySelectorAll(".chip")].find((chip) => chip.textContent.includes("REC")) ??
    null;
  const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
  const dialogButton = (name: string) =>
    [...(dialog()?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent === name,
    ) ?? null;

  it.each([
    ["recording isn't available", { recordingAvailable: false }],
    ["the caller can't start recording", { canStartRecording: false }],
  ])("hides the record control when %s", async (_case, overrides) => {
    await joinCall({ ...moderatorSession, ...overrides });
    expect(container.querySelector('button[aria-label*="recording" i]')).toBeNull();
  });

  it("asks before recording, then starts and stops through the server", async () => {
    const fetchSpy = mockToolFetch({
      "meet.recording.start": () => ({
        body: { recordingId: "rec-1", startedAt: "2026-10-21T10:00:00.000Z" },
      }),
      "meet.recording.stop": () => ({ body: { stopped: true } }),
    });
    const room = await joinCall();
    act(() => {
      room.addRemote("actor-2", "Ana");
    });

    act(() => recordButton()?.click());
    await settle();
    expect(dialog()?.textContent).toContain("Everyone in this call (2 people) will be recorded.");
    expect(toolCalls(fetchSpy, "meet.recording.start")).toHaveLength(0);
    expect(await axeViolations()).toEqual([]);

    act(() => dialogButton("Start recording")?.click());
    await settle();
    expect(dialog()).toBeNull();
    expect(toolCalls(fetchSpy, "meet.recording.start")[0]?.[1]).toMatchObject({
      body: JSON.stringify({ roomId: "room-1" }),
    });
    // The server accepted; the control offers Stop while LiveKit catches up.
    expect(stopButton()).not.toBeNull();

    act(() => {
      room.setRecording(true);
    });
    expect(recPill()).not.toBeNull();
    expect(container.textContent).toContain("Recording in progress");

    act(() => stopButton()?.click());
    await settle();
    expect(dialog()).toBeNull();
    expect(toolCalls(fetchSpy, "meet.recording.stop")[0]?.[1]).toMatchObject({
      body: JSON.stringify({ roomId: "room-1" }),
    });
    act(() => {
      room.setRecording(false);
    });
    expect(recPill()).toBeNull();
    expect(container.textContent).not.toContain("Recording in progress");
    expect(recordButton()).not.toBeNull();
  });

  it("doesn't record when the confirmation is cancelled", async () => {
    const fetchSpy = mockToolFetch({});
    await joinCall();
    act(() => recordButton()?.click());
    await settle();
    expect(dialog()?.textContent).toContain("You’re the only one here now");
    act(() => dialogButton("Cancel")?.click());
    await settle();
    expect(dialog()).toBeNull();
    expect(toolCalls(fetchSpy, "meet.recording.start")).toHaveLength(0);
  });

  it("shows the pending state while the server works", async () => {
    let resolve: (response: Response) => void = () => undefined;
    mockToolFetch({
      "meet.recording.start": () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    });
    await joinCall();
    act(() => recordButton()?.click());
    await settle();
    act(() => dialogButton("Start recording")?.click());
    await settle();

    const pending = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Starting recording…"]',
    );
    expect(pending?.getAttribute("aria-busy")).toBe("true");
    expect(
      [...container.querySelectorAll('[role="status"]')].map((node) => node.textContent),
    ).toContain("Starting recording…");
    act(() => pending?.click());
    await act(async () => {
      resolve(Response.json({ recordingId: "rec-1", startedAt: "2026-10-21T10:00:00.000Z" }));
      await Promise.resolve();
    });
    await settle();
    expect(stopButton()).not.toBeNull();
  });

  it("shows the server's reason when recording can't start", async () => {
    const message =
      "Recording requires an active moderator and current consent from every participant.";
    mockToolFetch({
      "meet.recording.start": () => ({ status: 409, body: { error: message } }),
    });
    await joinCall();
    act(() => recordButton()?.click());
    await settle();
    act(() => dialogButton("Start recording")?.click());
    await settle();

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(message);
    expect(recordButton()).not.toBeNull();
    expect(recPill()).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("follows LiveKit's recording status for every participant", async () => {
    const room = await joinCall({
      ...moderatorSession,
      canStartRecording: false,
      canModerate: false,
    });
    expect(recPill()).toBeNull();

    act(() => {
      room.setRecording(true);
    });
    expect(recPill()).not.toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Recording in progress",
    );

    act(() => {
      room.setRecording(false);
    });
    expect(recPill()).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("takes LiveKit's status over the join response once connected", async () => {
    renderWithClient(
      <MeetCall
        session={{ ...moderatorSession, recordingActive: true }}
        onLeave={() => undefined}
      />,
      root,
    );
    // Before connecting, the join response warns straight away.
    expect(recPill()).not.toBeNull();
    await flush();
    await flush();
    // The recording ended between the join response and connecting.
    expect(recPill()).toBeNull();
    expect(recordButton()).not.toBeNull();
  });
});

describe("recordingAudience", () => {
  it("names how many people will be recorded", () => {
    expect(recordingAudience(1)).toContain("only one here");
    expect(recordingAudience(3)).toBe("Everyone in this call (3 people) will be recorded.");
  });
});
