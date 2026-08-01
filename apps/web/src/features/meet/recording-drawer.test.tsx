// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("uses modal drawer semantics, traps Escape, and restores page focus", async () => {
    const onClose = vi.fn();
    act(() => root.render(<RecordingDrawer meeting={meeting} onClose={onClose} />));
    await act(async () => Promise.resolve());

    const drawer = container.querySelector<HTMLElement>('[role="dialog"]');
    expect(drawer?.getAttribute("aria-modal")).toBe("true");
    expect(drawer?.getAttribute("aria-labelledby")).toBeTruthy();
    expect(document.body.style.overflow).toBe("hidden");
    expect(document.activeElement).toBe(
      container.querySelector<HTMLButtonElement>('button[aria-label="Close"]'),
    );
    expect(container.querySelector("video")?.getAttribute("aria-label")).toBe("Recording 1 of 1");

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    act(() => root.render(null));
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(opener);
  });
});
