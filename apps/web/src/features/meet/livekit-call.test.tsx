// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as LiveKit from "livekit-client";
import { FakeRoom } from "@/test/livekit";
import {
  FINAL_CAPTION_TTL_MS,
  parseCaptionsPayload,
  parseChatPayload,
  qualityScore,
  useLiveKitCall,
  type LiveKitCallControls,
  type LiveKitCallOptions,
  type UseLiveKitCallParams,
} from "./livekit-call";

vi.mock("livekit-client", async (importOriginal) => ({
  ...(await importOriginal<typeof LiveKit>()),
  Room: (await import("@/test/livekit")).FakeRoom,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const options: LiveKitCallOptions = {
  serverUrl: "wss://workspace.example.test",
  token: "livekit-token",
  displayName: "Local User",
  initialRecordingActive: false,
  media: { audioMuted: false, videoMuted: true, audioInputId: "mic-2", videoInputId: null },
};

let latest: LiveKitCallControls | null = null;
function Harness(props: UseLiveKitCallParams) {
  latest = useLiveKitCall(props);
  return null;
}
function controls(): LiveKitCallControls {
  if (latest === null) throw new Error("Harness has not rendered.");
  return latest;
}

async function settle() {
  await act(async () => {
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
  });
}

describe("useLiveKitCall", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    FakeRoom.reset();
    latest = null;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  async function mount(params: Partial<UseLiveKitCallParams> = {}) {
    act(() => {
      root.render(<Harness options={options} {...params} />);
    });
    await settle();
    return FakeRoom.latest();
  }

  it("connects with the server URL and token and publishes the pre-join choices", async () => {
    const onTelemetry = vi.fn();
    const room = await mount({ onTelemetry });
    expect(room.connect).toHaveBeenCalledWith("wss://workspace.example.test", "livekit-token");
    expect(room.options).toMatchObject({
      audioCaptureDefaults: { deviceId: { ideal: "mic-2" }, noiseSuppression: true },
      videoCaptureDefaults: {},
    });
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);
    expect(room.localParticipant.setCameraEnabled).not.toHaveBeenCalled();
    expect(controls().state).toMatchObject({
      isReady: true,
      isJoined: true,
      audioMuted: false,
      videoMuted: true,
      loadError: null,
      capabilities: {
        chat: true,
        raiseHand: true,
        screenShare: true,
        tileView: true,
        noiseSuppression: true,
      },
    });
    expect(onTelemetry).toHaveBeenCalledWith(expect.objectContaining({ event: "join_latency" }));
  });

  it("hides chat, screen share and raised hand when the token does not grant them", async () => {
    const room = await mount();
    act(() => {
      room.localParticipant.permissions = {
        canPublish: true,
        canSubscribe: true,
        canPublishData: false,
        // TrackSource CAMERA = 1, MICROPHONE = 2: no screen share.
        canPublishSources: [1, 2],
        canUpdateMetadata: false,
      };
      room.emit("participantPermissionsChanged", undefined, room.localParticipant);
    });
    expect(controls().state.capabilities).toEqual({
      chat: false,
      raiseHand: false,
      screenShare: false,
      tileView: true,
      noiseSuppression: true,
    });
    act(() => {
      room.localParticipant.permissions = {
        canPublish: true,
        canPublishData: true,
        canPublishSources: [],
        canUpdateMetadata: true,
      };
      room.emit("participantPermissionsChanged", undefined, room.localParticipant);
    });
    expect(controls().state.capabilities).toMatchObject({
      chat: true,
      raiseHand: true,
      screenShare: true,
    });
  });

  it("reports connection failures in the error field", async () => {
    FakeRoom.connectError = new Error("could not establish signal connection");
    await mount();
    expect(controls().state.isJoined).toBe(false);
    expect(controls().state.loadError).toContain("could not establish signal connection");
  });

  it("toggles the microphone, camera and screen share", async () => {
    const room = await mount();
    act(() => {
      controls().commands.toggleAudio();
    });
    await settle();
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(false, undefined);
    expect(controls().state.audioMuted).toBe(true);

    act(() => {
      controls().commands.toggleVideo();
    });
    await settle();
    expect(room.localParticipant.setCameraEnabled).toHaveBeenLastCalledWith(true);
    expect(controls().state.videoMuted).toBe(false);

    act(() => {
      controls().commands.toggleShareScreen();
    });
    await settle();
    expect(room.localParticipant.setScreenShareEnabled).toHaveBeenCalledWith(true, {
      audio: true,
    });
    expect(controls().state.screenSharing).toBe(true);
    expect(controls().media.tiles.some((tile) => tile.isScreenShare && tile.isLocal)).toBe(true);
  });

  it("sends chat on the chat topic and counts unread messages while the panel is closed", async () => {
    const room = await mount();
    act(() => {
      controls().commands.sendChatMessage("  hello all  ");
    });
    const [data, publishOptions] = room.localParticipant.publishData.mock.calls[0] ?? [];
    expect(publishOptions).toEqual({ reliable: true, topic: "chat" });
    expect(JSON.parse(new TextDecoder().decode(data))).toEqual({
      id: expect.any(String),
      text: "hello all",
    });
    expect(controls().state.chatMessages.at(-1)).toMatchObject({
      message: "hello all",
      isLocal: true,
    });

    const remote = room.addRemote("actor-2", "Ana");
    const payload = (text: string, id: string) =>
      new TextEncoder().encode(JSON.stringify({ id, text }));
    act(() => {
      room.emit("dataReceived", payload("hi", "m1"), remote, 0, "chat");
      room.emit("dataReceived", payload("ignored", "m2"), remote, 0, "other-topic");
      room.emit("dataReceived", new TextEncoder().encode("not json"), remote, 0, "chat");
    });
    expect(controls().state.chatMessages.at(-1)).toMatchObject({
      nick: "Ana",
      from: "actor-2",
      message: "hi",
      isLocal: false,
    });
    expect(controls().state.unreadChatCount).toBe(1);

    act(() => {
      controls().commands.setChatPanelOpen(true);
    });
    expect(controls().state.unreadChatCount).toBe(0);
    act(() => {
      room.emit("dataReceived", payload("while open", "m3"), remote, 0, "chat");
    });
    expect(controls().state.unreadChatCount).toBe(0);
  });

  it("follows the transcription state packets and the join response", async () => {
    const room = await mount({ options: { ...options, initialTranscriptionActive: true } });
    expect(controls().state.transcriptionActive).toBe(true);
    act(() => {
      room.receiveData("helix.captions", { v: 1, type: "state", transcribing: false });
    });
    expect(controls().state.transcriptionActive).toBe(false);
    act(() => {
      room.receiveData("helix.captions", { v: 2, type: "state", transcribing: true });
      room.receiveData("helix.captions", { v: 1, type: "state", transcribing: "yes" });
      room.receiveData("helix.captions", "not json");
      room.receiveData("other", { v: 1, type: "state", transcribing: true });
    });
    expect(controls().state.transcriptionActive).toBe(false);
    act(() => {
      room.receiveData("helix.captions", { v: 1, type: "state", transcribing: true });
    });
    expect(controls().state.transcriptionActive).toBe(true);
  });

  it("replaces interim captions with the final, keeps the newest lines and expires finals", async () => {
    vi.useFakeTimers();
    try {
      const room = await mount();
      const caption = (itemId: string, text: string, final: boolean) => ({
        v: 1,
        type: "caption",
        itemId,
        speakerIdentity: "actor-2",
        speakerName: "Ana",
        text,
        final,
      });
      act(() => {
        room.receiveData("helix.captions", { v: 1, type: "state", transcribing: true });
        room.receiveData("helix.captions", caption("i1", "Hello", false));
        room.receiveData("helix.captions", caption("i1", "Hello every", false));
      });
      expect(controls().state.captions).toEqual([
        expect.objectContaining({ itemId: "i1", text: "Hello every", final: false }),
      ]);
      act(() => {
        room.receiveData("helix.captions", caption("i1", "Hello everyone.", true));
      });
      expect(controls().state.captions).toEqual([
        {
          itemId: "i1",
          speakerIdentity: "actor-2",
          speakerName: "Ana",
          text: "Hello everyone.",
          final: true,
        },
      ]);

      act(() => {
        for (const id of ["i2", "i3", "i4"])
          room.receiveData("helix.captions", caption(id, id, true));
      });
      expect(controls().state.captions.map((line) => line.itemId)).toEqual(["i2", "i3", "i4"]);

      act(() => {
        vi.advanceTimersByTime(FINAL_CAPTION_TTL_MS + 1);
      });
      expect(controls().state.captions).toEqual([]);

      act(() => {
        room.receiveData("helix.captions", caption("i5", "still talking", false));
        room.receiveData("helix.captions", { v: 1, type: "state", transcribing: false });
      });
      expect(controls().state).toMatchObject({ transcriptionActive: false, captions: [] });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps only the last 200 chat messages", async () => {
    const room = await mount();
    const remote = room.addRemote("actor-2", "Ana");
    act(() => {
      for (let index = 0; index < 205; index += 1) {
        room.emit(
          "dataReceived",
          new TextEncoder().encode(JSON.stringify({ id: `m${String(index)}`, text: "x" })),
          remote,
          0,
          "chat",
        );
      }
    });
    expect(controls().state.chatMessages).toHaveLength(200);
    expect(controls().state.chatMessages[0]?.id).toBe("m5");
  });

  it("raises and lowers the hand through the participant attribute", async () => {
    const room = await mount();
    act(() => {
      controls().commands.toggleRaiseHand();
    });
    await settle();
    expect(room.localParticipant.setAttributes).toHaveBeenLastCalledWith({ hand: "raised" });
    expect(controls().state.handRaised).toBe(true);
    act(() => {
      controls().commands.toggleRaiseHand();
    });
    await settle();
    expect(room.localParticipant.setAttributes).toHaveBeenLastCalledWith({ hand: "" });
    expect(controls().state.handRaised).toBe(false);
  });

  it("tracks remote participants, speaking, raised hands and the active speaker", async () => {
    const room = await mount();
    let remote = room.addRemote("actor-2", "Ana");
    await settle();
    expect(controls().state.participants).toEqual([
      expect.objectContaining({ id: "actor-2", displayName: "Ana", audioMuted: true }),
    ]);

    act(() => {
      remote = room.remoteParticipants.get("actor-2") ?? remote;
      remote.publish("microphone");
      remote.publish("camera");
      remote.isSpeaking = true;
      remote.attributes = { hand: "raised" };
      room.activeSpeakers = [remote];
      room.emit("activeSpeakersChanged", [remote]);
    });
    expect(controls().state.activeSpeakerId).toBe("actor-2");
    expect(controls().state.participants[0]).toMatchObject({
      audioMuted: false,
      speaking: true,
      handRaised: true,
    });
    const tile = controls().media.tiles.find((candidate) => candidate.participantId === "actor-2");
    expect(tile?.videoTrack).not.toBeNull();
    expect(controls().media.audioTracks.map((audio) => audio.key)).toEqual(["actor-2:microphone"]);

    act(() => {
      room.removeRemote("actor-2");
    });
    expect(controls().state.participants).toEqual([]);
  });

  it("reports local connection quality as bounded telemetry", async () => {
    const onTelemetry = vi.fn();
    const room = await mount({ onTelemetry });
    act(() => {
      room.emit("connectionQualityChanged", "poor", room.localParticipant);
      room.emit("connectionQualityChanged", "excellent", room.localParticipant);
    });
    expect(onTelemetry).toHaveBeenCalledWith({ event: "quality", connectionQuality: 30 });
    // Throttled: the second sample inside the window is dropped.
    expect(onTelemetry).not.toHaveBeenCalledWith({ event: "quality", connectionQuality: 100 });
  });

  it("hangs up through disconnect and reports leaving once", async () => {
    const onLeft = vi.fn();
    const room = await mount({ onLeft });
    act(() => {
      controls().commands.hangup();
    });
    expect(room.disconnect).toHaveBeenCalled();
    expect(onLeft).toHaveBeenCalledTimes(1);
  });

  it("disconnects on unmount without reporting a leave", async () => {
    const onLeft = vi.fn();
    const room = await mount({ onLeft });
    act(() => {
      root.render(<Harness options={null} onLeft={onLeft} />);
    });
    expect(room.disconnect).toHaveBeenCalled();
    expect(onLeft).not.toHaveBeenCalled();
    expect(controls().state.isJoined).toBe(false);
  });

  it("does not connect without options", () => {
    act(() => {
      root.render(<Harness options={null} />);
    });
    expect(FakeRoom.instances).toHaveLength(0);
  });
});

describe("LiveKit helpers", () => {
  it("accepts only bounded chat payloads", () => {
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    expect(parseChatPayload(encode({ id: "a", text: " hi " }))).toEqual({ id: "a", text: "hi" });
    expect(parseChatPayload(encode({ id: "", text: "hi" }))).toBeNull();
    expect(parseChatPayload(encode({ id: "a", text: "   " }))).toBeNull();
    expect(parseChatPayload(encode({ id: "a", text: 5 }))).toBeNull();
    expect(parseChatPayload(encode({ id: "a", text: "x".repeat(5000) }))?.text).toHaveLength(4000);
  });

  it("maps connection quality to a 0-100 score", () => {
    expect(qualityScore("excellent" as LiveKit.ConnectionQuality)).toBe(100);
    expect(qualityScore("lost" as LiveKit.ConnectionQuality)).toBe(0);
    expect(qualityScore("unknown" as LiveKit.ConnectionQuality)).toBeNull();
  });
});

describe("parseCaptionsPayload", () => {
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  const base = {
    v: 1,
    type: "caption",
    itemId: "i1",
    speakerIdentity: "actor-2",
    speakerName: "Ana",
    text: "hi",
    final: true,
  };

  it("drops malformed packets", () => {
    expect(parseCaptionsPayload(new TextEncoder().encode("{"))).toBeNull();
    expect(parseCaptionsPayload(encode(null))).toBeNull();
    expect(parseCaptionsPayload(encode({ ...base, v: 2 }))).toBeNull();
    expect(parseCaptionsPayload(encode({ ...base, itemId: "" }))).toBeNull();
    expect(parseCaptionsPayload(encode({ ...base, text: "   " }))).toBeNull();
    expect(parseCaptionsPayload(encode({ ...base, final: "true" }))).toBeNull();
    expect(parseCaptionsPayload(encode({ ...base, speakerName: 3 }))).toBeNull();
  });

  it("caps long text to its newest words and fills in a missing name", () => {
    const parsed = parseCaptionsPayload(
      encode({ ...base, speakerName: " ", text: `${"a".repeat(600)} end` }),
    );
    expect(parsed?.type).toBe("caption");
    if (parsed?.type !== "caption") return;
    expect(parsed.caption.speakerName).toBe("Speaker");
    expect(parsed.caption.text.length).toBeLessThanOrEqual(500);
    expect(parsed.caption.text.endsWith(" end")).toBe(true);
  });
});
