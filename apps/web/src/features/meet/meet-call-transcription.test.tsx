// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as LiveKit from "livekit-client";
import { MeetCall } from "./meet-call";
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

const hostSession: MeetCallSession = {
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
  transcriptionAvailable: true,
  transcriptionActive: false,
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

type ToolReply = { readonly status?: number; readonly body: unknown };

function mockToolFetch(replies: Record<string, () => ToolReply>) {
  return vi.spyOn(authModule, "authenticatedFetch").mockImplementation((input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const reply = replies[url.replace("/api/tools/", "")];
    if (reply === undefined) return Promise.resolve(Response.json({}, { status: 404 }));
    const value = reply();
    return Promise.resolve(Response.json(value.body, { status: value.status ?? 200 }));
  });
}

function toolBodies(fetchSpy: ReturnType<typeof mockToolFetch>, toolId: string) {
  return fetchSpy.mock.calls
    .filter(([input]) => input === `/api/tools/${toolId}`)
    .map(([, init]) => init?.body);
}

const state = (transcribing: boolean) => ({ v: 1, type: "state", transcribing });
const caption = (itemId: string, text: string, final: boolean) => ({
  v: 1,
  type: "caption",
  itemId,
  speakerIdentity: "actor-2",
  speakerName: "Ana",
  text,
  final,
});

describe("MeetCall transcription", () => {
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

  async function joinCall(session: MeetCallSession = hostSession, guestName?: string) {
    renderWithClient(
      <MeetCall session={session} onLeave={() => undefined} guestName={guestName} />,
      root,
    );
    await flush();
    await flush();
    return FakeRoom.latest();
  }

  const button = (label: string) =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  const chip = () =>
    [...container.querySelectorAll(".chip")].find((node) =>
      node.textContent.includes("Transcribing"),
    ) ?? null;
  const overlay = () => container.querySelector<HTMLElement>('[data-testid="meet-captions"]');
  const liveRegion = () =>
    container.querySelector<HTMLElement>('[data-testid="meet-captions-live"]');
  const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
  const dialogButton = (name: string) =>
    [...(dialog()?.querySelectorAll("button") ?? [])].find((node) => node.textContent === name) ??
    null;

  it("turns the chip and notice on and off with the state packets", async () => {
    const room = await joinCall({ ...hostSession, transcriptionAvailable: false });
    expect(chip()).toBeNull();
    expect(button("Show captions")).toBeNull();

    act(() => {
      room.receiveData("helix.captions", state(true));
    });
    expect(chip()).not.toBeNull();
    expect(container.textContent).toContain("Transcription is on");

    act(() => {
      room.receiveData("helix.captions", state(false));
    });
    expect(chip()).toBeNull();
    expect(container.textContent).not.toContain("Transcription is on");
  });

  it("ignores captions sent by a person in the call", async () => {
    const room = await joinCall();
    act(() => {
      const sam = room.addRemote("user-2", "Sam");
      room.receiveData("helix.captions", state(true), sam);
      room.receiveData("helix.captions", caption("x", "Fake words", true), sam);
    });
    expect(chip()).toBeNull();
    expect(container.textContent).not.toContain("Fake words");
    act(() => {
      room.receiveData(
        "helix.captions",
        state(true),
        room.addRemote("TR_cap-1", "Live transcription"),
      );
    });
    expect(chip()).not.toBeNull();
  });

  it("shows the chip from the join response", async () => {
    await joinCall({ ...hostSession, transcriptionActive: true });
    expect(chip()).not.toBeNull();
  });

  it("renders interim captions dimmed, then the final line, and announces only finals", async () => {
    const room = await joinCall();
    act(() => {
      room.receiveData("helix.captions", state(true));
      room.receiveData("helix.captions", caption("i1", "Shall we", false));
    });
    const interim = overlay()?.querySelector("p");
    expect(interim?.textContent).toBe("Ana: Shall we");
    expect(interim?.getAttribute("data-final")).toBe("false");
    expect(interim?.className).toContain("opacity");
    expect(liveRegion()?.textContent).toBe("");

    act(() => {
      room.receiveData("helix.captions", caption("i1", "Shall we start?", true));
    });
    const lines = overlay()?.querySelectorAll("p") ?? [];
    expect(lines).toHaveLength(1);
    expect(lines[0]?.textContent).toBe("Ana: Shall we start?");
    expect(lines[0]?.getAttribute("data-final")).toBe("true");
    expect(liveRegion()?.textContent).toBe("Ana: Shall we start?");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("hides and shows the caption overlay with the CC button", async () => {
    const room = await joinCall();
    act(() => {
      room.receiveData("helix.captions", state(true));
      room.receiveData("helix.captions", caption("i1", "Hello", true));
    });
    expect(overlay()).not.toBeNull();

    act(() => button("Hide captions")?.click());
    expect(overlay()).toBeNull();
    expect(liveRegion()).toBeNull();

    act(() => button("Show captions")?.click());
    expect(overlay()?.textContent).toContain("Hello");
  });

  it("asks before transcribing, then starts and stops through the server", async () => {
    const fetchSpy = mockToolFetch({
      "meet.transcription.set": () => ({ body: { ok: true } }),
    });
    const room = await joinCall();

    act(() => button("Start transcription")?.click());
    await settle();
    expect(dialog()?.textContent).toContain("Transcribe this meeting?");
    expect(dialog()?.textContent).toContain("Drive");
    expect(toolBodies(fetchSpy, "meet.transcription.set")).toHaveLength(0);

    act(() => dialogButton("Start transcription")?.click());
    await settle();
    expect(dialog()).toBeNull();
    expect(toolBodies(fetchSpy, "meet.transcription.set")).toEqual([
      JSON.stringify({ roomId: "room-1", enabled: true }),
    ]);
    expect(button("Stop transcription")).not.toBeNull();

    act(() => {
      room.receiveData("helix.captions", state(true));
    });
    act(() => button("Stop transcription")?.click());
    await settle();
    expect(dialog()).toBeNull();
    expect(toolBodies(fetchSpy, "meet.transcription.set")[1]).toBe(
      JSON.stringify({ roomId: "room-1", enabled: false }),
    );
  });

  it("doesn't transcribe when the confirmation is cancelled", async () => {
    const fetchSpy = mockToolFetch({});
    await joinCall();
    act(() => button("Start transcription")?.click());
    await settle();
    act(() => dialogButton("Cancel")?.click());
    await settle();
    expect(dialog()).toBeNull();
    expect(toolBodies(fetchSpy, "meet.transcription.set")).toHaveLength(0);
  });

  it("shows the server's reason when transcription can't start", async () => {
    const message = "Transcription needs current capture consent from everyone in the call.";
    mockToolFetch({
      "meet.transcription.set": () => ({ status: 409, body: { error: message } }),
    });
    await joinCall();
    act(() => button("Start transcription")?.click());
    await settle();
    act(() => dialogButton("Start transcription")?.click());
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(message);
    expect(button("Start transcription")).not.toBeNull();
  });

  it("hides the host control when transcription isn't available", async () => {
    await joinCall({ ...hostSession, transcriptionAvailable: undefined });
    expect(container.querySelector('button[aria-label*="transcription" i]')).toBeNull();
  });

  it("gives guests captions and CC but never the host control", async () => {
    const room = await joinCall(
      {
        ...hostSession,
        canModerate: false,
        transcriptionAvailable: true,
        transcriptionActive: undefined,
      },
      "Gus",
    );
    expect(container.querySelector('button[aria-label*="transcription" i]')).toBeNull();
    act(() => {
      room.receiveData("helix.captions", state(true));
      room.receiveData("helix.captions", caption("i1", "Welcome", true));
    });
    expect(chip()).not.toBeNull();
    expect(button("Hide captions")).not.toBeNull();
    expect(overlay()?.textContent).toContain("Ana: Welcome");
    expect(container.querySelector('button[aria-label*="transcription" i]')).toBeNull();
  });
});
