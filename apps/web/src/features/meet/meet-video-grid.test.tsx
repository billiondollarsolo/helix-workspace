// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "livekit-client";
import { FakeTrack } from "@/test/livekit";
import type { MeetMediaTile, MeetMediaView } from "./livekit-call";
import { MeetVideoGrid, featuredTile } from "./meet-video-grid";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function tile(overrides: Partial<MeetMediaTile> & { participantId: string }): MeetMediaTile {
  return {
    key: `${overrides.participantId}:${overrides.isScreenShare === true ? "screen" : "camera"}`,
    name: overrides.participantId,
    isLocal: false,
    isScreenShare: false,
    videoTrack: null,
    audioMuted: false,
    speaking: false,
    handRaised: false,
    ...overrides,
  };
}

const asTrack = (track: FakeTrack) => track as unknown as Track;

describe("featuredTile", () => {
  const local = tile({ participantId: "me", isLocal: true });
  const ana = tile({ participantId: "ana" });
  const ben = tile({ participantId: "ben" });

  it("features a screen share in any layout", () => {
    const screen = tile({ participantId: "ben", isScreenShare: true });
    expect(featuredTile([local, ana, ben, screen], null, true)).toBe(screen);
  });

  it("features the active speaker in speaker layout and nothing in tile layout", () => {
    expect(featuredTile([local, ana, ben], "ben", false)).toBe(ben);
    expect(featuredTile([local, ana, ben], "me", false)).toBe(ana);
    expect(featuredTile([local, ana, ben], "ben", true)).toBeNull();
  });
});

describe("MeetVideoGrid", () => {
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

  function render(media: MeetMediaView, onStartAudio = vi.fn()) {
    act(() => {
      root.render(
        <MeetVideoGrid
          media={media}
          activeSpeakerId="ana"
          tileView
          label="Meeting: Sync"
          onStartAudio={onStartAudio}
        />,
      );
    });
  }

  it("attaches tracks, labels tiles and detaches on removal", () => {
    const camera = new FakeTrack("camera");
    const audio = new FakeTrack("microphone");
    const media: MeetMediaView = {
      tiles: [
        tile({ participantId: "me", name: "Me", isLocal: true, audioMuted: true }),
        tile({ participantId: "ana", name: "Ana", videoTrack: asTrack(camera), handRaised: true }),
      ],
      audioTracks: [{ key: "ana:microphone", track: asTrack(audio) }],
      audioPlaybackBlocked: false,
    };
    render(media);
    expect(container.querySelector('[aria-label="Meeting: Sync"]')).not.toBeNull();
    expect(container.querySelector('li[aria-label="Me (you)"]')?.textContent).toContain(
      "microphone off",
    );
    const ana = container.querySelector('li[aria-label="Ana"]');
    expect(ana?.textContent).toContain("hand raised");
    expect(ana?.className).toContain("var(--accent)");
    expect(camera.attach).toHaveBeenCalledWith(container.querySelector("video"));
    expect(audio.attach).toHaveBeenCalledWith(container.querySelector("audio"));

    render({ ...media, tiles: media.tiles.slice(0, 1), audioTracks: [] });
    expect(camera.detach).toHaveBeenCalled();
    expect(audio.detach).toHaveBeenCalled();
  });

  it("announces remote joins and leaves after the local participant is in", () => {
    const me = tile({ participantId: "me", name: "Me", isLocal: true });
    const ana = tile({ participantId: "ana", name: "Ana" });
    const status = () => container.querySelector('[role="status"]')?.textContent;
    render({ tiles: [me, ana], audioTracks: [], audioPlaybackBlocked: false });
    expect(status()).toBe("");
    render({
      tiles: [me, ana, tile({ participantId: "ben", name: "Ben" })],
      audioTracks: [],
      audioPlaybackBlocked: false,
    });
    expect(status()).toBe("Ben joined");
    render({ tiles: [me], audioTracks: [], audioPlaybackBlocked: false });
    expect(status()).toBe("Ana left. Ben left");
  });

  it("offers to turn on call audio when autoplay was blocked", () => {
    const onStartAudio = vi.fn();
    render({ tiles: [], audioTracks: [], audioPlaybackBlocked: true }, onStartAudio);
    const button = [...container.querySelectorAll("button")].find((candidate) =>
      candidate.textContent.includes("Turn on call audio"),
    );
    act(() => button?.click());
    expect(onStartAudio).toHaveBeenCalled();
  });
});
