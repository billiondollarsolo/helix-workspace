// Browser harness for live Meet checks against a real LiveKit server. Each
// participant is a page on a stand-in HTTPS origin (so camera, microphone and
// WebRTC are allowed) that loads livekit-client's UMD build, connects with a
// Helix-minted access token and publishes the browser's synthetic camera and
// microphone. Used by scripts/meet-media-probe.mjs and the live media gate.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// The package's `require` export is its UMD build, which sets `LivekitClient`.
const livekitUmdPath = require.resolve("livekit-client");

export const HARNESS_ORIGIN = "https://meet-harness.helix.test";
export const CHAT_TOPIC = "chat";

/** Records every RTCPeerConnection; with relayOnly, forces TURN relay. */
export async function instrumentPeerConnections(context, { relayOnly = false } = {}) {
  await context.addInitScript((forceRelay) => {
    const scope = globalThis;
    const Native = scope.RTCPeerConnection;
    const connections = [];
    const states = [];
    class RecordedPeerConnection extends Native {
      constructor(configuration) {
        super(forceRelay ? { ...configuration, iceTransportPolicy: "relay" } : configuration);
        connections.push(this);
        const record = () => states.push(this.connectionState);
        this.addEventListener("connectionstatechange", record);
        record();
      }
    }
    scope.__helixRtcConnections = connections;
    scope.__helixRtcStates = states;
    scope.RTCPeerConnection = RecordedPeerConnection;
  }, relayOnly);
}

/** Opens a harness page in `context` and joins the room the token names. */
export async function openLiveKitParticipant(context, { serverUrl, token, timeoutMs = 60_000 }) {
  await context.grantPermissions(["camera", "microphone"], { origin: HARNESS_ORIGIN });
  await context.route(`${HARNESS_ORIGIN}/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>Meet harness</title>",
    }),
  );
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (error) => problems.push(error.message));
  await page.goto(`${HARNESS_ORIGIN}/`, { timeout: timeoutMs });
  await page.addScriptTag({ path: livekitUmdPath });
  const joined = await page.evaluate(
    async ({ url, accessToken, topic }) => {
      const { Room, RoomEvent } = globalThis.LivekitClient;
      const room = new Room();
      const harness = { room, chat: [], connectError: null };
      globalThis.__helixMeet = harness;
      room.on(RoomEvent.DataReceived, (payload, participant, _kind, received) => {
        if (received !== topic) return;
        try {
          const message = JSON.parse(new TextDecoder().decode(payload));
          harness.chat.push({ from: participant?.identity ?? null, text: message.text });
        } catch {
          // Malformed chat is ignored, as in the product.
        }
      });
      try {
        await room.connect(url, accessToken);
      } catch (error) {
        harness.connectError = error instanceof Error ? error.message : String(error);
        return false;
      }
      await room.localParticipant.enableCameraAndMicrophone();
      return true;
    },
    { url: serverUrl, accessToken: token, topic: CHAT_TOPIC },
  );
  return { page, problems, joined };
}

/** What the participant's room knows: who is here and which tracks arrived. */
export function roomState(page) {
  return page.evaluate(() => {
    const harness = globalThis.__helixMeet;
    if (harness === undefined) return { connected: false };
    const { room } = harness;
    return {
      connected: room.state === "connected",
      connectError: harness.connectError,
      identity: room.localParticipant.identity,
      remotes: [...room.remoteParticipants.values()].map((participant) => ({
        identity: participant.identity,
        attributes: { ...participant.attributes },
        subscribed: [...participant.trackPublications.values()]
          .filter((publication) => publication.track !== undefined)
          .map((publication) => publication.kind),
      })),
      chat: harness.chat,
    };
  });
}

/** Sends a product-shaped chat message ({ id, text } on the chat topic). */
export function sendChat(page, text) {
  return page.evaluate(
    async ({ message, topic }) => {
      const { room } = globalThis.__helixMeet;
      const payload = JSON.stringify({ id: crypto.randomUUID(), text: message });
      await room.localParticipant.publishData(new TextEncoder().encode(payload), {
        reliable: true,
        topic,
      });
    },
    { message: text, topic: CHAT_TOPIC },
  );
}

/** Raises the hand the way the product does (participant attribute). */
export function raiseHand(page) {
  return page.evaluate(async () => {
    await globalThis.__helixMeet.room.localParticipant.setAttributes({ hand: "raised" });
  });
}

export function disconnect(page) {
  return page.evaluate(async () => {
    await globalThis.__helixMeet?.room.disconnect();
  });
}

/** Media counters from the page's own peer connections. */
export function mediaStats(page) {
  return page.evaluate(async () => {
    const totals = {
      inbound: { audio: 0, video: 0 },
      outbound: { audio: 0, video: 0 },
      dtls: [],
      candidateTypes: [],
      connectionStates: [...(globalThis.__helixRtcStates ?? [])],
    };
    for (const connection of globalThis.__helixRtcConnections ?? []) {
      if (connection.connectionState === "closed") continue;
      const report = await connection.getStats();
      report.forEach((entry) => {
        if (entry.type === "inbound-rtp" && (entry.kind === "audio" || entry.kind === "video"))
          totals.inbound[entry.kind] += entry.bytesReceived ?? 0;
        if (entry.type === "outbound-rtp" && (entry.kind === "audio" || entry.kind === "video"))
          totals.outbound[entry.kind] += entry.bytesSent ?? 0;
        if (entry.type === "transport" && entry.dtlsState) totals.dtls.push(entry.dtlsState);
        if (entry.type === "candidate-pair" && entry.nominated && entry.state === "succeeded") {
          // The local side of the selected pair: "relay" means TURN carried it.
          const local = report.get(entry.localCandidateId);
          if (local) totals.candidateTypes.push(`${local.candidateType}/${local.protocol}`);
        }
      });
    }
    return totals;
  });
}
