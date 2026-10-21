import { describe, expect, it } from "vitest";
import { createLiveKitRooms, LiveKitRoomError } from "./livekit-rooms.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const roomId = "33333333-3333-4333-8333-333333333333";
const options = {
  apiKey: "helix",
  apiSecret: "livekit-test-secret-with-at-least-32-characters",
  publicUrl: "wss://workspace.example.test",
  internalUrl: "http://livekit:7880",
};

function fakeFetch(responses: Record<string, Response>) {
  const requests: { url: string; body: Record<string, unknown>; room: unknown }[] = [];
  const fetcher = (async (url: URL, init: RequestInit) => {
    const token = String((init.headers as Record<string, string>).authorization).split(".")[1];
    const claims = JSON.parse(Buffer.from(token ?? "", "base64url").toString()) as {
      video: { room: string };
    };
    requests.push({
      url: url.pathname,
      body: JSON.parse(init.body as string) as Record<string, unknown>,
      room: claims.video.room,
    });
    return responses[url.pathname.split("/").at(-1) ?? ""] ?? Response.json({});
  }) as unknown as typeof fetch;
  return { fetcher, requests };
}

describe("LiveKit room service", () => {
  it("lists participants and their track sources", async () => {
    const { fetcher, requests } = fakeFetch({
      ListParticipants: Response.json({
        participants: [
          {
            identity: "user-1",
            tracks: [
              { sid: "TR_1", source: "MICROPHONE" },
              { sid: "TR_2", source: "SCREEN_SHARE" },
            ],
          },
          { identity: "user-2" },
        ],
      }),
    });
    const rooms = createLiveKitRooms(options, fetcher);
    await expect(rooms.listParticipants(orgId, roomId)).resolves.toEqual([
      {
        identity: "user-1",
        tracks: [
          { sid: "TR_1", source: "microphone" },
          { sid: "TR_2", source: "screen_share" },
        ],
      },
      { identity: "user-2", tracks: [] },
    ]);
    expect(requests).toEqual([
      {
        url: "/twirp/livekit.RoomService/ListParticipants",
        body: { room: `${orgId}.${roomId}` },
        room: `${orgId}.${roomId}`,
      },
    ]);
  });

  it("sends permission updates in LiveKit's field names", async () => {
    const { fetcher, requests } = fakeFetch({});
    await createLiveKitRooms(options, fetcher).updateParticipant(orgId, roomId, "user-1", {
      permission: {
        canSubscribe: true,
        canPublish: true,
        canPublishData: false,
        canPublishSources: ["camera", "screen_share"],
        canUpdateMetadata: true,
      },
      attributes: { helixRole: "" },
    });
    expect(requests[0]?.body).toEqual({
      room: `${orgId}.${roomId}`,
      identity: "user-1",
      permission: {
        can_subscribe: true,
        can_publish: true,
        can_publish_data: false,
        can_publish_sources: ["CAMERA", "SCREEN_SHARE"],
        can_update_metadata: true,
      },
      attributes: { helixRole: "" },
    });
  });

  it("treats a participant or room that already left as done, and reports other failures", async () => {
    const gone = fakeFetch({ RemoveParticipant: new Response(null, { status: 404 }) });
    await expect(
      createLiveKitRooms(options, gone.fetcher).removeParticipant(orgId, roomId, "user-1"),
    ).resolves.toBeUndefined();
    const broken = fakeFetch({ DeleteRoom: new Response(null, { status: 500 }) });
    await expect(
      createLiveKitRooms(options, broken.fetcher).deleteRoom(orgId, roomId),
    ).rejects.toBeInstanceOf(LiveKitRoomError);
  });
});
