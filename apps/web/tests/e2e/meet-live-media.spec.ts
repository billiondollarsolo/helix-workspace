import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { chromium, expect, test, type Browser, type BrowserContext } from "@playwright/test";
import {
  instrumentPeerConnections,
  mediaStats,
  openLiveKitParticipant,
  raiseHand,
  roomState,
  sendChat,
  type HarnessMediaStats,
} from "../../scripts/meet-livekit-harness.mjs";

/* Opt-in release gate against a real Helix + LiveKit deployment: two browsers
   with synthetic camera and microphone join one room with Helix-minted
   LiveKit tokens, exchange TURN-relayed audio and video, chat on the product
   data topic, see a raised hand, and recover from a dropped network. The
   recording leg returns with LiveKit Egress (Phase 11, LK-5). */

interface LiveConfig {
  readonly apiUrl: string;
  readonly attendeeActorId: string;
  readonly attendeeClientId: string;
  readonly attendeeClientSecret: string;
  readonly evidencePath: string;
  readonly hostActorId: string;
  readonly hostClientId: string;
  readonly hostClientSecret: string;
}

interface MintedJoin {
  readonly provider?: string;
  readonly serverUrl: string;
  readonly token: string;
  readonly roomId: string;
  readonly roomName: string;
}

interface LiveRoom {
  readonly id: string;
  readonly roomName: string;
}

test("two real browsers meet over TURN-relayed LiveKit media", async () => {
  const config = liveConfig();
  const hostToken = await oauthToken(config, "host");
  const attendeeToken = await oauthToken(config, "attendee");
  const room = await callTool<LiveRoom>(config, hostToken, "meet.create-room", {
    subject: `LiveKit live gate ${new Date().toISOString()}`,
    participantActorIds: [config.attendeeActorId],
    guestPolicy: "disabled",
    guestDomains: [],
    lobbyEnabled: false,
    metadata: { releaseGate: "LK-3" },
  });
  const consent = () => ({
    roomId: room.id,
    expiresInSeconds: 300,
    recordingNoticeAccepted: true,
    recordingNoticeVersion: "2026-10-15",
    deviceId: randomUUID(),
    joinGrantId: randomUUID(),
  });
  const [hostJoin, attendeeJoin] = await Promise.all([
    callTool<MintedJoin>(config, hostToken, "meet.mint-token", consent()),
    callTool<MintedJoin>(config, attendeeToken, "meet.mint-token", consent()),
  ]);
  for (const join of [hostJoin, attendeeJoin]) {
    expect(join.provider).toBe("livekit");
    expect(join.serverUrl).toMatch(/^wss:\/\/[^/]+$/u);
    expect(join.roomId).toBe(room.id);
  }

  let hostBrowser: Browser | undefined;
  let attendeeBrowser: Browser | undefined;
  let hostContext: BrowserContext | undefined;
  let attendeeContext: BrowserContext | undefined;
  try {
    [hostBrowser, attendeeBrowser] = await Promise.all([
      launchSyntheticBrowser(),
      launchSyntheticBrowser(),
    ]);
    [hostContext, attendeeContext] = await Promise.all([
      liveContext(hostBrowser),
      liveContext(attendeeBrowser),
    ]);
    const [host, attendee] = await Promise.all([
      openLiveKitParticipant(hostContext, { serverUrl: hostJoin.serverUrl, token: hostJoin.token }),
      openLiveKitParticipant(attendeeContext, {
        serverUrl: attendeeJoin.serverUrl,
        token: attendeeJoin.token,
      }),
    ]);
    expect(host.joined, host.problems.join(" | ")).toBe(true);
    expect(attendee.joined, attendee.problems.join(" | ")).toBe(true);

    for (const [page, other] of [
      [host.page, config.attendeeActorId],
      [attendee.page, config.hostActorId],
    ] as const) {
      await expect
        .poll(
          async () =>
            (await roomState(page)).remotes?.find((remote) => remote.identity === other)
              ?.subscribed ?? [],
          { timeout: 120_000 },
        )
        .toEqual(expect.arrayContaining(["audio", "video"]));
    }

    const [hostMedia, attendeeMediaBefore] = await Promise.all([
      waitForMedia(host.page),
      waitForMedia(attendee.page),
    ]);
    assertRelayMedia(hostMedia);
    assertRelayMedia(attendeeMediaBefore);

    await sendChat(host.page, "LiveKit live gate chat");
    await expect
      .poll(async () => (await roomState(attendee.page)).chat ?? [])
      .toEqual(
        expect.arrayContaining([{ from: config.hostActorId, text: "LiveKit live gate chat" }]),
      );

    await raiseHand(attendee.page);
    await expect
      .poll(
        async () =>
          (await roomState(host.page)).remotes?.find(
            (remote) => remote.identity === config.attendeeActorId,
          )?.attributes.hand,
      )
      .toBe("raised");

    await expect(
      callTool(config, attendeeToken, "meet.host-controls.apply", {
        roomId: room.id,
        action: "set_lock",
        locked: true,
      }),
    ).rejects.toThrow(/rejected|forbidden|permission|control/iu);

    await attendeeContext.setOffline(true);
    await expect
      .poll(
        async () =>
          (await mediaStats(attendee.page)).connectionStates.some(
            (state) => state === "disconnected" || state === "failed",
          ),
        { timeout: 30_000 },
      )
      .toBe(true);
    await attendeeContext.setOffline(false);
    await expect
      .poll(async () => (await roomState(attendee.page)).connected, { timeout: 90_000 })
      .toBe(true);
    const attendeeMediaAfterReconnect = await waitForMediaGrowth(
      attendee.page,
      attendeeMediaBefore,
    );
    assertRelayMedia(attendeeMediaAfterReconnect);

    const evidence = {
      schemaVersion: 2,
      provider: "livekit",
      generatedAt: new Date().toISOString(),
      browser: hostBrowser.version(),
      peerCount: 2,
      syntheticMedia: ["audio", "video"],
      turnOnly: true,
      hostMedia,
      attendeeMediaBefore,
      attendeeMediaAfterReconnect,
      reconnectObserved: true,
      chatDelivered: true,
      raisedHandDelivered: true,
      roleEnforcement: { attendeeServerControlRejected: true },
      recording: "not covered until LiveKit Egress (LK-5)",
    };
    await mkdir(dirname(config.evidencePath), { recursive: true });
    await writeFile(config.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  } finally {
    await Promise.allSettled([hostContext?.close(), attendeeContext?.close()]);
    await Promise.allSettled([hostBrowser?.close(), attendeeBrowser?.close()]);
    await callTool(config, hostToken, "meet.end-room", { roomId: room.id }).catch(() => undefined);
  }
});

function liveConfig(): LiveConfig {
  const required = (name: string): string => {
    const value = process.env[name]?.trim();
    if (value === undefined || value.length === 0)
      throw new Error(`${name} is required; live media gates never skip.`);
    return value;
  };
  const apiUrl = required("HELIX_MEET_LIVE_API_URL").replace(/\/$/u, "");
  if (!apiUrl.startsWith("https://")) throw new Error("HELIX_MEET_LIVE_API_URL must use HTTPS.");
  return {
    apiUrl,
    hostClientId: required("HELIX_MEET_LIVE_HOST_CLIENT_ID"),
    hostClientSecret: required("HELIX_MEET_LIVE_HOST_CLIENT_SECRET"),
    hostActorId: requiredUuid("HELIX_MEET_LIVE_HOST_ACTOR_ID"),
    attendeeClientId: required("HELIX_MEET_LIVE_ATTENDEE_CLIENT_ID"),
    attendeeClientSecret: required("HELIX_MEET_LIVE_ATTENDEE_CLIENT_SECRET"),
    attendeeActorId: requiredUuid("HELIX_MEET_LIVE_ATTENDEE_ACTOR_ID"),
    evidencePath: resolve(
      process.env.HELIX_MEET_LIVE_EVIDENCE_PATH ?? "test-results/meet-live/evidence.json",
    ),
  };

  function requiredUuid(name: string): string {
    const value = required(name);
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
    ) {
      throw new Error(`${name} must be a UUID.`);
    }
    return value;
  }
}

async function oauthToken(config: LiveConfig, participant: "host" | "attendee"): Promise<string> {
  const id = participant === "host" ? config.hostClientId : config.attendeeClientId;
  const secret = participant === "host" ? config.hostClientSecret : config.attendeeClientSecret;
  const response = await fetch(`${config.apiUrl}/oauth/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: "meet.read meet.write",
    }),
  });
  const output = await json(response);
  if (!response.ok || typeof output.access_token !== "string")
    throw new Error(`OAuth ${participant} setup failed (${String(response.status)}).`);
  return output.access_token;
}

async function callTool<Output = unknown>(
  config: LiveConfig,
  token: string,
  toolId: string,
  input: unknown,
): Promise<Output> {
  const invoke = await fetch(`${config.apiUrl}/api/tools/${encodeURIComponent(toolId)}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const invoked = await json(invoke);
  if (!invoke.ok)
    throw new Error(`${toolId} rejected (${String(invoke.status)}): ${errorText(invoked)}`);
  const pending = recordValue(invoked.pending);
  if (invoke.status !== 202 || typeof pending?.id !== "string") return invoked as Output;
  const approve = await fetch(
    `${config.apiUrl}/api/tools/pending/${encodeURIComponent(pending.id)}/approve`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    },
  );
  const approved = await json(approve);
  if (!approve.ok)
    throw new Error(
      `${toolId} approval failed (${String(approve.status)}): ${errorText(approved)}`,
    );
  return (recordValue(approved)?.output ?? approved) as Output;
}

function launchSyntheticBrowser(): Promise<Browser> {
  return chromium.launch({
    headless: true,
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  });
}

async function liveContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({
    ignoreHTTPSErrors: false,
    recordVideo: { dir: "test-results/meet-live" },
  });
  // TURN only, so the gate proves the relay path, not a lucky direct route.
  await instrumentPeerConnections(context, { relayOnly: true });
  return context;
}

async function waitForMedia(page: Parameters<typeof mediaStats>[0]): Promise<HarnessMediaStats> {
  await expect
    .poll(async () => minimumInbound(await mediaStats(page)), { timeout: 120_000 })
    .toBeGreaterThan(0);
  return mediaStats(page);
}

async function waitForMediaGrowth(
  page: Parameters<typeof mediaStats>[0],
  before: HarnessMediaStats,
): Promise<HarnessMediaStats> {
  await expect
    .poll(
      async () => {
        const now = await mediaStats(page);
        return now.inbound.audio > before.inbound.audio && now.inbound.video > before.inbound.video;
      },
      { timeout: 120_000 },
    )
    .toBe(true);
  return mediaStats(page);
}

function minimumInbound(stats: HarnessMediaStats): number {
  return Math.min(stats.inbound.audio, stats.inbound.video);
}

function minimumMediaBytes(stats: HarnessMediaStats): number {
  return Math.min(minimumInbound(stats), stats.outbound.audio, stats.outbound.video);
}

function assertRelayMedia(stats: HarnessMediaStats): void {
  expect(
    minimumMediaBytes(stats),
    "both audio and video must flow in both directions",
  ).toBeGreaterThan(1_000);
  expect(stats.dtls.length, "media must run over DTLS-SRTP").toBeGreaterThan(0);
  expect(stats.dtls.every((state) => state === "connected")).toBe(true);
  expect(stats.candidateTypes.length).toBeGreaterThan(0);
  expect(
    stats.candidateTypes.every((type) => type.startsWith("relay/")),
    `media must be TURN-relayed (saw ${stats.candidateTypes.join(", ")})`,
  ).toBe(true);
}

async function json(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json().catch(() => ({}));
  return recordValue(value) ?? {};
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function errorText(value: unknown): string {
  const record = recordValue(value);
  const error = record?.error;
  if (typeof error === "string") return error;
  const nested = recordValue(error);
  return typeof nested?.message === "string" ? nested.message : "unknown error";
}
