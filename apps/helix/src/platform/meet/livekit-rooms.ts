/* LiveKit's room service (Twirp over HTTP), used to carry out host controls and
   to end calls. Every call authenticates with a short-lived server token for the
   one room it touches. */

import { liveKitRoomName, liveKitServerToken, type LiveKitOptions } from "./livekit.js";

export type LiveKitTrackSource = "camera" | "microphone" | "screen_share" | "screen_share_audio";

export interface LiveKitParticipantPermission {
  readonly canSubscribe: boolean;
  readonly canPublish: boolean;
  readonly canPublishData: boolean;
  readonly canPublishSources: readonly LiveKitTrackSource[];
  readonly canUpdateMetadata: boolean;
}

export interface LiveKitParticipantInfo {
  readonly identity: string;
  readonly tracks: readonly { readonly sid: string; readonly source: string }[];
}

export interface LiveKitRooms {
  listParticipants(orgId: string, roomId: string): Promise<readonly LiveKitParticipantInfo[]>;
  removeParticipant(orgId: string, roomId: string, identity: string): Promise<void>;
  muteTrack(orgId: string, roomId: string, identity: string, trackSid: string): Promise<void>;
  updateParticipant(
    orgId: string,
    roomId: string,
    identity: string,
    update: {
      readonly permission: LiveKitParticipantPermission;
      readonly attributes: Readonly<Record<string, string>>;
    },
  ): Promise<void>;
  deleteRoom(orgId: string, roomId: string): Promise<void>;
  /** Sends a small reliable message to the named participants on `topic`. */
  sendData(
    orgId: string,
    roomId: string,
    message: { readonly topic: string; readonly payload: object; readonly to: readonly string[] },
  ): Promise<void>;
}

/** LiveKit answers with protobuf JSON; enum values arrive as names. */
const SOURCE_NAMES: Readonly<Record<string, string>> = {
  CAMERA: "camera",
  MICROPHONE: "microphone",
  SCREEN_SHARE: "screen_share",
  SCREEN_SHARE_AUDIO: "screen_share_audio",
};
const SOURCE_ENUM: Readonly<Record<LiveKitTrackSource, string>> = {
  camera: "CAMERA",
  microphone: "MICROPHONE",
  screen_share: "SCREEN_SHARE",
  screen_share_audio: "SCREEN_SHARE_AUDIO",
};

export class LiveKitRoomError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
  ) {
    super(`LiveKit ${method} failed with HTTP ${String(status)}.`);
  }
}

export function createLiveKitRooms(
  options: LiveKitOptions,
  fetcher: typeof fetch = fetch,
): LiveKitRooms {
  async function call(method: string, room: string, body: object): Promise<unknown> {
    const response = await fetcher(
      new URL(`/twirp/livekit.RoomService/${method}`, options.internalUrl),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${liveKitServerToken(options, room)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      },
    );
    // A room or participant that already left is the outcome the caller wanted.
    if (response.status === 404) return null;
    if (!response.ok) throw new LiveKitRoomError(method, response.status);
    return (await response.json()) as unknown;
  }

  return {
    async listParticipants(orgId, roomId) {
      const room = liveKitRoomName(orgId, roomId);
      const result = (await call("ListParticipants", room, { room })) as {
        participants?: { identity?: string; tracks?: { sid?: string; source?: string }[] }[];
      } | null;
      return (result?.participants ?? []).flatMap((participant) =>
        typeof participant.identity === "string"
          ? [
              {
                identity: participant.identity,
                tracks: (participant.tracks ?? []).flatMap((track) =>
                  typeof track.sid === "string"
                    ? [{ sid: track.sid, source: SOURCE_NAMES[track.source ?? ""] ?? "unknown" }]
                    : [],
                ),
              },
            ]
          : [],
      );
    },
    async removeParticipant(orgId, roomId, identity) {
      const room = liveKitRoomName(orgId, roomId);
      await call("RemoveParticipant", room, { room, identity });
    },
    async muteTrack(orgId, roomId, identity, trackSid) {
      const room = liveKitRoomName(orgId, roomId);
      await call("MutePublishedTrack", room, { room, identity, track_sid: trackSid, muted: true });
    },
    async updateParticipant(orgId, roomId, identity, update) {
      const room = liveKitRoomName(orgId, roomId);
      await call("UpdateParticipant", room, {
        room,
        identity,
        permission: {
          can_subscribe: update.permission.canSubscribe,
          can_publish: update.permission.canPublish,
          can_publish_data: update.permission.canPublishData,
          can_publish_sources: update.permission.canPublishSources.map(
            (source) => SOURCE_ENUM[source],
          ),
          can_update_metadata: update.permission.canUpdateMetadata,
        },
        attributes: update.attributes,
      });
    },
    async deleteRoom(orgId, roomId) {
      const room = liveKitRoomName(orgId, roomId);
      await call("DeleteRoom", room, { room });
    },
    async sendData(orgId, roomId, message) {
      const room = liveKitRoomName(orgId, roomId);
      await call("SendData", room, {
        room,
        data: Buffer.from(JSON.stringify(message.payload)).toString("base64"),
        kind: "RELIABLE",
        destination_identities: message.to,
        topic: message.topic,
      });
    },
  };
}
