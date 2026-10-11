/* Camera and microphone for the pre-join screen: the viewer's remembered
   choices, the device list, and a live preview stream. The preview releases
   its tracks on unmount so Jitsi can open the same devices for the call. */

import { useEffect, useState } from "react";
import type { JitsiInitialMedia } from "./jitsi-external-api";

export interface MeetMediaChoice {
  readonly micOn: boolean;
  readonly camOn: boolean;
  readonly audioInputId: string | null;
  readonly videoInputId: string | null;
}

const STORAGE_KEY = "helix-meet-media";
const DEFAULT_CHOICE: MeetMediaChoice = {
  micOn: true,
  camOn: true,
  audioInputId: null,
  videoInputId: null,
};

/** The last choices this viewer made, or mic and camera on with default devices. */
export function readMeetMediaChoice(): MeetMediaChoice {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_CHOICE;
    const value = JSON.parse(raw) as Partial<Record<keyof MeetMediaChoice, unknown>>;
    return {
      micOn: typeof value.micOn === "boolean" ? value.micOn : true,
      camOn: typeof value.camOn === "boolean" ? value.camOn : true,
      audioInputId: typeof value.audioInputId === "string" ? value.audioInputId : null,
      videoInputId: typeof value.videoInputId === "string" ? value.videoInputId : null,
    };
  } catch {
    return DEFAULT_CHOICE;
  }
}

export function saveMeetMediaChoice(choice: MeetMediaChoice): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(choice));
  } catch {
    // Remembering devices is a convenience; the join itself does not need it.
  }
}

/** What the call starts with: muted states plus the labels Jitsi matches devices by. */
export function initialMediaFor(
  choice: MeetMediaChoice,
  devices: readonly MediaDeviceInfo[],
): JitsiInitialMedia {
  const label = (id: string | null) =>
    devices.find((device) => id !== null && device.deviceId === id)?.label || null;
  return {
    audioMuted: !choice.micOn,
    videoMuted: !choice.camOn,
    audioInputLabel: label(choice.audioInputId),
    videoInputLabel: label(choice.videoInputId),
  };
}

export type MeetPreviewProblem = "blocked" | "unavailable" | null;

export interface MeetMediaPreview {
  readonly stream: MediaStream | null;
  readonly devices: readonly MediaDeviceInfo[];
  /** Why the preview could not open the camera or microphone. */
  readonly problem: MeetPreviewProblem;
}

/** Opens the chosen devices for the preview and lists what is available. */
export function useMeetMediaPreview(choice: MeetMediaChoice): MeetMediaPreview {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [devices, setDevices] = useState<readonly MediaDeviceInfo[]>([]);
  const [problem, setProblem] = useState<MeetPreviewProblem>(null);
  const { micOn, camOn, audioInputId, videoInputId } = choice;

  useEffect(() => {
    const media = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
    if (media === undefined || (!micOn && !camOn)) {
      setStream(null);
      setProblem(media === undefined && (micOn || camOn) ? "unavailable" : null);
      return;
    }
    let cancelled = false;
    let opened: MediaStream | null = null;
    media
      .getUserMedia({
        audio: micOn
          ? audioInputId === null
            ? true
            : { deviceId: { exact: audioInputId } }
          : false,
        video: camOn
          ? videoInputId === null
            ? true
            : { deviceId: { exact: videoInputId } }
          : false,
      })
      .then(async (next) => {
        opened = next;
        if (cancelled) {
          stopTracks(next);
          return;
        }
        setStream(next);
        setProblem(null);
        // Labels are only readable once access has been granted.
        const listed = await media.enumerateDevices();
        if (!cancelled) setDevices(listed);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setStream(null);
        setProblem(
          cause instanceof DOMException && cause.name === "NotAllowedError"
            ? "blocked"
            : "unavailable",
        );
      });
    return () => {
      cancelled = true;
      if (opened !== null) stopTracks(opened);
    };
  }, [micOn, camOn, audioInputId, videoInputId]);

  return { stream, devices, problem };
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}
