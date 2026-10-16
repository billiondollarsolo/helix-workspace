// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as TanStackRouter from "@tanstack/react-router";
import * as authModule from "@/lib/auth";
import {
  flush,
  meetingsPayload,
  mockTools,
  renderWithClient,
  setReactInputValue,
  waitForText,
} from "@/test/meet";
import { parseMeetCode } from "./meet-code";
import { MeetShell } from "./meet-shell";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof TanStackRouter>();
  return {
    ...actual,
    useRouter: () => ({ invalidate: () => Promise.resolve() }),
  };
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* Calendar events for today: one with video conferencing, one without. */
function todayEvents() {
  const start = new Date();
  start.setHours(15, 0, 0, 0);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  return {
    events: [
      {
        id: "event-1",
        calendarId: "cal-1",
        title: "Harbor design review",
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
        allDay: false,
        status: "confirmed",
        attendees: [],
        metadata: {
          conference: {
            provider: "meet",
            roomId: "room-9",
            joinCode: "hrbr-dsgn-rvw0",
            joinUrl: "/meet?code=hrbr-dsgn-rvw0",
          },
        },
      },
      {
        id: "event-2",
        calendarId: "cal-1",
        title: "Lunch",
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
        allDay: false,
        status: "confirmed",
        attendees: [],
        metadata: {},
      },
    ],
  };
}

const tokenRecord = {
  roomId: "room-new",
  roomName: "instant-room",
  jitsiDomain: "meet.localhost",
  token: "jwt",
  joinUrl: "https://meet.localhost/instant-room?jwt=jwt",
  expiresAt: "2026-05-21T11:00:00.000Z",
  recordingAvailable: true,
  canStartRecording: true,
  recordingNoticeVersion: "2026-10-15",
  recordingActive: false,
  canModerate: false,
  controls: {
    roomId: "room-new",
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

/* A fake camera and microphone for the pre-join preview. */
function stubMediaDevices() {
  const stop = vi.fn();
  const getUserMedia = vi.fn<(constraints: MediaStreamConstraints) => Promise<MediaStream>>(() =>
    Promise.resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream),
  );
  const enumerateDevices = vi.fn(() =>
    Promise.resolve([
      { deviceId: "mic-1", kind: "audioinput", label: "Desk mic", groupId: "g" },
      { deviceId: "mic-2", kind: "audioinput", label: "Headset mic", groupId: "g" },
      { deviceId: "cam-1", kind: "videoinput", label: "Built-in camera", groupId: "g" },
    ] as MediaDeviceInfo[]),
  );
  vi.stubGlobal("navigator", {
    ...navigator,
    mediaDevices: { getUserMedia, enumerateDevices },
    clipboard: { writeText: vi.fn(() => Promise.resolve()) },
  });
  return { getUserMedia, stop };
}

function buttonNamed(container: HTMLElement, name: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find(
    (button) => button.getAttribute("aria-label") === name || button.textContent.trim() === name,
  );
}

async function openMenu(trigger: HTMLButtonElement | undefined) {
  act(() => {
    trigger?.focus();
    trigger?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await flush();
}

function menuItem(text: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) =>
    item.textContent.includes(text),
  );
}

describe("MeetShell hub", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
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

  function renderShell(props: Partial<React.ComponentProps<typeof MeetShell>> = {}) {
    const onCodeChange = vi.fn();
    const onScheduleInCalendar = vi.fn();
    renderWithClient(
      <MeetShell
        onCodeChange={onCodeChange}
        onScheduleInCalendar={onScheduleInCalendar}
        {...props}
      />,
      root,
    );
    return { onCodeChange, onScheduleInCalendar };
  }

  it("lists today's calendar meetings with video and running rooms, plus recent ones", async () => {
    mockTools({
      "meet.meetings.list": () => meetingsPayload,
      "calendar.event.list": todayEvents,
    });
    const { onCodeChange } = renderShell();
    await waitForText(container, "Harbor design review");
    expect(container.textContent).toContain("Atlas weekly sync");
    expect(container.textContent).not.toContain("Lunch");
    expect(container.textContent).toContain("Eng standup");
    expect(container.querySelector("h1")?.textContent).toBe("Meet face to face, wherever you are");

    act(() => {
      buttonNamed(container, "Join Harbor design review")?.click();
    });
    expect(onCodeChange).toHaveBeenCalledWith("hrbr-dsgn-rvw0");
  });

  it("shows Meet as unavailable with the server's setup guidance", async () => {
    const message =
      "Meet needs a Jitsi meeting server. Set MEET_JITSI_JWT_SECRET and MEET_JITSI_WEBHOOK_SHARED_SECRET, then restart Helix.";
    mockTools({
      "meet.status": () => ({ available: false, reason: "not_configured", message }),
      "meet.meetings.list": () => meetingsPayload,
      "calendar.event.list": todayEvents,
    });
    renderShell({ code: "atl-asly-snc" });
    await waitForText(container, "Meet is unavailable");
    expect(container.querySelector('[role="status"]')?.textContent).toContain(message);
    expect(container.querySelector("h2")?.textContent).toBe("Meet is unavailable");
    expect(buttonNamed(container, "New meeting")).toBeUndefined();
    expect(container.textContent).not.toContain("Atlas weekly sync");
  });

  it("opens the hub when Meet reports it is available", async () => {
    mockTools({
      "meet.status": () => ({ available: true }),
      "meet.meetings.list": () => meetingsPayload,
      "calendar.event.list": todayEvents,
    });
    renderShell();
    await waitForText(container, "Atlas weekly sync");
    expect(container.textContent).not.toContain("Meet is unavailable");
  });

  it("shows an actionable error when meetings can't be loaded", async () => {
    vi.spyOn(authModule, "authenticatedFetch").mockResolvedValue(
      Response.json({ error: "boom" }, { status: 500 }),
    );
    renderShell();
    await waitForText(container, "Meetings unavailable");
    expect(buttonNamed(container, "Retry")).toBeDefined();
  });

  it("joins by a pasted link or code and rejects anything else", async () => {
    mockTools({ "meet.meetings.list": () => meetingsPayload, "calendar.event.list": todayEvents });
    const { onCodeChange } = renderShell();
    await flush();
    const input = container.querySelector<HTMLInputElement>(
      'input[placeholder="Enter a code or link"]',
    );
    if (input === null) throw new Error("code input not found");
    act(() => {
      setReactInputValue(input, "not a code");
    });
    act(() => {
      buttonNamed(container, "Join")?.click();
    });
    expect(container.textContent).toContain("Enter a meeting code like abcd-efgh-ijkl");
    expect(onCodeChange).not.toHaveBeenCalled();

    act(() => {
      setReactInputValue(input, "https://helix.example/meet?code=ABCD-efgh-ijkl");
    });
    act(() => {
      buttonNamed(container, "Join")?.click();
    });
    expect(onCodeChange).toHaveBeenCalledWith("abcd-efgh-ijkl");
  });

  it("hands Schedule in Calendar off to the calendar editor", async () => {
    mockTools({ "meet.meetings.list": () => meetingsPayload, "calendar.event.list": todayEvents });
    const { onScheduleInCalendar } = renderShell();
    await flush();
    await openMenu(buttonNamed(container, "New meeting"));
    act(() => {
      menuItem("Schedule in Calendar")?.click();
    });
    expect(onScheduleInCalendar).toHaveBeenCalled();
  });

  it("creates a meeting for later and offers its link to copy", async () => {
    stubMediaDevices();
    mockTools({
      "meet.meetings.list": () => meetingsPayload,
      "calendar.event.list": todayEvents,
      "meet.create-room": () => ({ id: "room-later", joinCode: "ltr0-ltr1-ltr2" }),
    });
    renderShell();
    await flush();
    await openMenu(buttonNamed(container, "New meeting"));
    act(() => {
      menuItem("Create a meeting for later")?.click();
    });
    await waitForText(document.body, "Your meeting is ready");
    expect(document.body.textContent).toContain("/meet?code=ltr0-ltr1-ltr2");
    const copy = document.querySelector<HTMLButtonElement>('[aria-label="Copy meeting link"]');
    await act(async () => {
      copy?.click();
      await Promise.resolve();
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining("/meet?code=ltr0-ltr1-ltr2"),
    );
  });
});

describe("Meet pre-join", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
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

  it("opens a meeting's pre-join screen straight from the code in the URL", async () => {
    const media = stubMediaDevices();
    const fetchSpy = mockTools({
      "meet.meetings.list": () => meetingsPayload,
      "calendar.event.list": todayEvents,
      "meet.join-by-code": () => ({ ...tokenRecord, roomId: "room-9", code: "hrbr-dsgn-rvw0" }),
    });
    renderWithClient(
      <MeetShell
        code="hrbr-dsgn-rvw0"
        onCodeChange={() => undefined}
        onScheduleInCalendar={() => undefined}
      />,
      root,
    );
    await waitForText(container, "Harbor design review");
    expect(container.querySelector("h1")?.textContent).toBe("Ready to join?");
    expect(container.textContent).toContain("hrbr-dsgn-rvw0");
    expect(media.getUserMedia).toHaveBeenCalledWith({ audio: true, video: true });

    act(() => {
      buttonNamed(container, "Join now")?.click();
    });
    await flush();
    // The recording notice must be accepted first.
    expect(container.textContent).toContain("Accept the recording notice to join.");
    expect(fetchSpy).not.toHaveBeenCalledWith("/api/tools/meet.join-by-code", expect.anything());

    const consent = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    act(() => {
      consent?.click();
    });
    act(() => {
      buttonNamed(container, "Join now")?.click();
    });
    await waitForText(container, "Leave");
    const joinCall = fetchSpy.mock.calls.find((call) => call[0] === "/api/tools/meet.join-by-code");
    if (joinCall === undefined) throw new Error("Expected a join-by-code request.");
    expect(JSON.parse(joinCall[1]?.body as string)).toMatchObject({
      code: "hrbr-dsgn-rvw0",
      recordingNoticeAccepted: true,
      recordingNoticeVersion: "2026-10-15",
    });
    // The preview releases the camera and microphone for the call.
    expect(media.stop).toHaveBeenCalled();
  });

  it("starts an instant meeting with the camera and microphone chosen before joining", async () => {
    const media = stubMediaDevices();
    const fetchSpy = mockTools({
      "meet.meetings.list": () => meetingsPayload,
      "calendar.event.list": todayEvents,
      "meet.create-room": () => ({
        id: "room-new",
        roomName: "instant-room",
        subject: "Instant meeting",
        joinCode: "inst-ant0-room",
        startedAt: "2026-05-21T10:00:00.000Z",
      }),
      "meet.mint-token": () => tokenRecord,
    });
    const onCodeChange = vi.fn();
    renderWithClient(
      <MeetShell onCodeChange={onCodeChange} onScheduleInCalendar={() => undefined} />,
      root,
    );
    await flush();
    await openMenu(buttonNamed(container, "New meeting"));
    act(() => {
      menuItem("Start an instant meeting")?.click();
    });
    await waitForText(container, "Ready to join?");
    await waitForText(container, "Headset mic");

    act(() => {
      buttonNamed(container, "Turn off camera")?.click();
    });
    await flush();
    expect(container.textContent).toContain("Camera is off");
    expect(media.getUserMedia).toHaveBeenLastCalledWith({ audio: true, video: false });

    const microphone = container.querySelector<HTMLSelectElement>("select");
    act(() => {
      if (microphone !== null) {
        microphone.value = "mic-2";
        microphone.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    await flush();
    expect(media.getUserMedia).toHaveBeenLastCalledWith({
      audio: { deviceId: { exact: "mic-2" } },
      video: false,
    });
    expect(JSON.parse(localStorage.getItem("helix-meet-media") ?? "{}")).toMatchObject({
      camOn: false,
      audioInputId: "mic-2",
    });

    act(() => {
      container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click();
    });
    act(() => {
      buttonNamed(container, "Join now")?.click();
    });
    await waitForText(container, "Leave");
    expect(onCodeChange).toHaveBeenCalledWith("inst-ant0-room");
    expect(fetchSpy).toHaveBeenCalledWith("/api/tools/meet.create-room", expect.anything());
    const mintCall = fetchSpy.mock.calls.find((call) => call[0] === "/api/tools/meet.mint-token");
    if (mintCall === undefined) throw new Error("Expected Meet token request.");
    expect(JSON.parse(mintCall[1]?.body as string)).toMatchObject({
      roomId: "room-new",
      recordingNoticeAccepted: true,
    });
    // The call view received the camera choice: its camera control starts off.
    expect(buttonNamed(container, "Turn on camera")).toBeDefined();
  });

  it("goes back to the hub from the pre-join screen", async () => {
    stubMediaDevices();
    mockTools({ "meet.meetings.list": () => meetingsPayload, "calendar.event.list": todayEvents });
    const onCodeChange = vi.fn();
    renderWithClient(
      <MeetShell
        code="hrbr-dsgn-rvw0"
        onCodeChange={onCodeChange}
        onScheduleInCalendar={() => undefined}
      />,
      root,
    );
    await flush();
    act(() => {
      buttonNamed(container, "Back to Meet")?.click();
    });
    expect(onCodeChange).toHaveBeenCalledWith(undefined);
  });
});

describe("parseMeetCode", () => {
  it("reads bare codes and Helix links, and nothing else", () => {
    expect(parseMeetCode(" ABCD-efgh-1234 ")).toBe("abcd-efgh-1234");
    expect(parseMeetCode("https://helix.example/meet?code=abcd-efgh-1234")).toBe("abcd-efgh-1234");
    expect(parseMeetCode("/meet?code=abcd-efgh-1234")).toBe("abcd-efgh-1234");
    expect(parseMeetCode("https://elsewhere.example/abcd-efgh-1234")).toBeNull();
    expect(parseMeetCode("abc-defg-hij")).toBeNull();
    expect(parseMeetCode("")).toBeNull();
  });
});
