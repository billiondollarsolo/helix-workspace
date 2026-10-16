// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settle } from "@/test/ui";
import { RecordingDrawer } from "./recording-drawer";
import type { MeetMeetingRecord } from "./api";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const meeting: MeetMeetingRecord = {
  id: "meeting-1",
  threadId: "thread-1",
  roomName: "launch",
  subject: "Launch review",
  title: "Launch review",
  jitsiDomain: "meet.helix.test",
  status: "ended",
  code: "launch",
  host: null,
  attendees: [],
  attendeeCount: 0,
  startedAt: "2026-07-28T10:00:00.000Z",
  endedAt: "2026-07-28T10:30:00.000Z",
  scheduledStartAt: null,
  scheduledEndAt: null,
  durationSeconds: 1800,
  recorded: true,
  recordingArtifacts: [
    {
      objectId: "recording-1",
      messageId: "message-1",
      storageKey: "recordings/launch.webm",
      mimeType: "video/webm",
      byteSize: 1_024,
      createdAt: "2026-07-28T10:30:00.000Z",
      startedAt: "2026-07-28T10:00:00.000Z",
      endedAt: "2026-07-28T10:30:00.000Z",
    },
  ],
  summaries: [],
  createdAt: "2026-07-28T10:00:00.000Z",
  updatedAt: "2026-07-28T10:30:00.000Z",
};

describe("RecordingDrawer", () => {
  let container: HTMLDivElement;
  let root: Root;
  let opener: HTMLButtonElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
  });

  afterEach(() => {
    act(() => root.unmount());
    opener.remove();
    container.remove();
    document.body.style.overflow = "";
  });

  it("uses a nonblocking drawer, closes on Escape, and restores page focus", async () => {
    const onClose = vi.fn();
    act(() => root.render(<RecordingDrawer meeting={meeting} onClose={onClose} />));
    await act(async () => Promise.resolve());

    const drawer = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(drawer?.getAttribute("aria-modal")).not.toBe("true");
    expect(drawer?.getAttribute("aria-labelledby")).toBeTruthy();
    expect(document.body.style.overflow).not.toBe("hidden");
    expect(document.activeElement).toBe(
      document.querySelector<HTMLButtonElement>('button[aria-label="Close"]'),
    );
    expect(document.querySelector("video")?.getAttribute("aria-label")).toBe("Recording 1 of 1");
    expect(document.querySelector("track")).toBeNull();

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    act(() => root.render(null));
    await settle();
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(opener);
  });

  it("does not offer export when meeting governance disables it", async () => {
    const restricted: MeetMeetingRecord = {
      ...meeting,
      recordingArtifacts: meeting.recordingArtifacts.map((artifact) => ({
        ...artifact,
        exportAllowed: false,
      })),
    };
    act(() => root.render(<RecordingDrawer meeting={restricted} onClose={() => undefined} />));
    await act(async () => Promise.resolve());

    expect(document.body.textContent).toContain("Download disabled");
    expect(document.querySelector("a[download]")).toBeNull();
  });
});
