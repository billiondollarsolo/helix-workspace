import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  chromium,
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";

interface LiveConfig {
  readonly apiUrl: string;
  readonly attendeeActorId: string;
  readonly attendeeClientId: string;
  readonly attendeeClientSecret: string;
  readonly evidencePath: string;
  readonly hostActorId: string;
  readonly hostClientId: string;
  readonly hostClientSecret: string;
  readonly webhookSecret: string;
}

interface MintedJoin {
  readonly joinUrl: string;
  readonly recordingAvailable: boolean;
  readonly roomId: string;
  readonly roomName: string;
}

interface LiveRoom {
  readonly id: string;
  readonly orgId: string;
  readonly roomName: string;
  readonly recordingArtifacts?: readonly RecordingArtifact[];
}

interface RecordingArtifact {
  readonly byteSize: number;
  readonly endedAt: string | null;
  readonly metadata?: Record<string, unknown>;
  readonly mimeType: string;
  readonly objectId: string;
  readonly startedAt: string | null;
}

interface HarnessSnapshot {
  readonly events: readonly { readonly name: string; readonly payload: Record<string, unknown> }[];
  readonly joined: boolean;
  readonly localId: string | null;
  readonly participants: readonly {
    readonly displayName: string;
    readonly id: string;
  }[];
  readonly ready: boolean;
}

interface MediaStats {
  readonly candidateTypes: readonly string[];
  readonly connectionStates: readonly string[];
  readonly inbound: Readonly<Record<"audio" | "video", number>>;
  readonly outbound: Readonly<Record<"audio" | "video", number>>;
}

interface HostControlResult {
  readonly mediaCommands: readonly {
    readonly command: string;
    readonly mediaType?: string;
    readonly participantId?: string;
  }[];
}

test("two real browsers exchange TURN-relayed media and produce a verified recording", async () => {
  const config = liveConfig();
  const hostToken = await oauthToken(config, "host");
  const attendeeToken = await oauthToken(config, "attendee");
  const room = await callTool<LiveRoom>(config, hostToken, "meet.create-room", {
    subject: `MEET-17 live gate ${new Date().toISOString()}`,
    participantActorIds: [config.attendeeActorId],
    guestPolicy: "disabled",
    guestDomains: [],
    lobbyEnabled: false,
    metadata: { releaseGate: "MEET-17" },
  });
  const consent = () => ({
    roomId: room.id,
    expiresInSeconds: 300,
    recordingNoticeAccepted: true,
    recordingNoticeVersion: "2026-09-02",
    deviceId: randomUUID(),
    joinGrantId: randomUUID(),
  });
  const [hostJoin, attendeeJoin] = await Promise.all([
    callTool<MintedJoin>(config, hostToken, "meet.mint-token", consent()),
    callTool<MintedJoin>(config, attendeeToken, "meet.mint-token", consent()),
  ]);
  expect(hostJoin.recordingAvailable, "Jibri must be healthy for the live gate").toBe(true);
  expect(attendeeJoin.roomId).toBe(room.id);
  expect(attendeeJoin.roomName).toBe(hostJoin.roomName);

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
      liveContext(hostBrowser, hostJoin.joinUrl),
      liveContext(attendeeBrowser, attendeeJoin.joinUrl),
    ]);
    const [hostPage, attendeePage] = await Promise.all([
      openHarness(hostContext, hostJoin.joinUrl, "Helix MEET-17 host"),
      openHarness(attendeeContext, attendeeJoin.joinUrl, "Helix MEET-17 attendee"),
    ]);

    await expect
      .poll(() => snapshot(hostPage), { timeout: 120_000 })
      .toMatchObject({ joined: true });
    await expect
      .poll(() => snapshot(attendeePage), { timeout: 120_000 })
      .toMatchObject({ joined: true });
    await expect
      .poll(async () => (await snapshot(hostPage)).participants.length)
      .toBeGreaterThan(0);
    await expect
      .poll(async () => (await snapshot(attendeePage)).participants.length)
      .toBeGreaterThan(0);

    const hostMedia = await participant(hostPage, "Helix MEET-17 attendee");
    const attendeeViewOfHost = await participant(attendeePage, "Helix MEET-17 host");
    const joinedAt = new Date().toISOString();
    await Promise.all([
      mediaWebhook(config, {
        event: "conference.started",
        eventId: randomUUID(),
        orgId: room.orgId,
        roomId: room.id,
        roomName: room.roomName,
        occurredAt: joinedAt,
      }),
      mediaWebhook(config, {
        event: "participant.joined",
        eventId: randomUUID(),
        orgId: room.orgId,
        roomId: room.id,
        roomName: room.roomName,
        sessionId: `host-${randomUUID()}`,
        participantId: config.hostActorId,
        occurredAt: joinedAt,
      }),
      mediaWebhook(config, {
        event: "participant.joined",
        eventId: randomUUID(),
        orgId: room.orgId,
        roomId: room.id,
        roomName: room.roomName,
        sessionId: `attendee-${randomUUID()}`,
        participantId: config.attendeeActorId,
        occurredAt: joinedAt,
      }),
    ]);

    const [hostMediaBefore, attendeeMediaBefore] = await Promise.all([
      waitForMedia(hostPage),
      waitForMedia(attendeePage),
    ]);
    assertRelayMedia(hostMediaBefore);
    assertRelayMedia(attendeeMediaBefore);

    await expect(
      callTool(config, attendeeToken, "meet.host-controls.apply", {
        roomId: room.id,
        action: "set_lock",
        locked: true,
      }),
    ).rejects.toThrow(/rejected|forbidden|permission|control/iu);
    await command(attendeePage, "kickParticipant", attendeeViewOfHost.id);
    await attendeePage.waitForTimeout(2_000);
    expect((await snapshot(hostPage)).joined, "crafted attendee kick must not remove host").toBe(
      true,
    );

    await attendeeContext.setOffline(true);
    await expect
      .poll(() => rtcStateSeen(attendeePage, ["disconnected", "failed"]), { timeout: 30_000 })
      .toBe(true);
    await attendeeContext.setOffline(false);
    await expect.poll(() => rtcReconnectSeen(attendeePage), { timeout: 90_000 }).toBe(true);
    const attendeeMediaAfterReconnect = await waitForMediaGrowth(attendeePage, attendeeMediaBefore);
    assertRelayMedia(attendeeMediaAfterReconnect);

    const mute = await callTool<HostControlResult>(config, hostToken, "meet.host-controls.apply", {
      roomId: room.id,
      action: "mute",
      participantSubject: config.attendeeActorId,
      mediaParticipantId: hostMedia.id,
      mediaType: "audio",
    });
    await executeMediaCommands(hostPage, mute.mediaCommands);
    await expect
      .poll(() => eventSeen(attendeePage, "audioMuteStatusChanged", "muted", true), {
        timeout: 30_000,
      })
      .toBe(true);

    await callTool(config, hostToken, "meet.recording.authorize-start", { roomId: room.id });
    await command(hostPage, "startRecording", { mode: "file" });
    await expect
      .poll(() => recordingState(hostPage), { timeout: 120_000, intervals: [1_000, 2_000, 5_000] })
      .toBe(true);
    const recordingStartedAt = new Date().toISOString();
    await mediaWebhook(config, {
      event: "recording.started",
      eventId: randomUUID(),
      orgId: room.orgId,
      roomId: room.id,
      roomName: room.roomName,
      occurredAt: recordingStartedAt,
    });
    await hostPage.waitForTimeout(12_000);
    await command(hostPage, "stopRecording", "file");
    await expect
      .poll(() => recordingState(hostPage), { timeout: 120_000, intervals: [1_000, 2_000, 5_000] })
      .toBe(false);
    const recordingEndedAt = new Date().toISOString();
    await mediaWebhook(config, {
      event: "recording.ended",
      eventId: randomUUID(),
      orgId: room.orgId,
      roomId: room.id,
      roomName: room.roomName,
      occurredAt: recordingEndedAt,
    });

    const artifact = await waitForRecording(config, hostToken, room.id);
    expect(artifact.mimeType).toBe("video/mp4");
    expect(artifact.byteSize).toBeGreaterThan(10_000);
    expect(artifact.startedAt).not.toBeNull();
    expect(artifact.endedAt).not.toBeNull();
    const validation = recordValue(artifact.metadata?.validation);
    const expectedSha = stringValue(validation?.sha256);
    expect(expectedSha).toMatch(/^[a-f0-9]{64}$/u);
    const recordedBytes = await authenticatedBytes(
      `${config.apiUrl}/api/drive/objects/${encodeURIComponent(artifact.objectId)}/content`,
      hostToken,
    );
    expect(recordedBytes.byteLength).toBe(artifact.byteSize);
    expect(createHash("sha256").update(recordedBytes).digest("hex")).toBe(expectedSha);
    expect(recordedBytes.subarray(4, 8).toString("ascii")).toBe("ftyp");

    const evidence = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      browser: hostBrowser.version(),
      peerCount: 2,
      syntheticMedia: ["audio", "video"],
      turnOnly: true,
      hostMedia: hostMediaBefore,
      attendeeMediaBefore,
      attendeeMediaAfterReconnect,
      reconnectObserved: true,
      roleEnforcement: {
        attendeeServerControlRejected: true,
        attendeeMediaKickRejected: true,
        hostMuteApplied: true,
      },
      recording: {
        mimeType: artifact.mimeType,
        byteSize: artifact.byteSize,
        sha256: expectedSha,
        startedAt: artifact.startedAt,
        endedAt: artifact.endedAt,
        webhookValidated: true,
      },
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
    webhookSecret: required("HELIX_MEET_LIVE_WEBHOOK_SECRET"),
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
      scope: "meet.read meet.write drive.read",
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

async function mediaWebhook(config: LiveConfig, payload: Record<string, unknown>): Promise<void> {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1_000);
  const digest = createHmac("sha256", config.webhookSecret)
    .update(`${String(timestamp)}.${body}`)
    .digest("hex");
  const response = await fetch(`${config.apiUrl}/webhook/jitsi`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-helix-signature": `t=${String(timestamp)},v1=${digest}`,
    },
    body,
  });
  if (!response.ok)
    throw new Error(
      `Signed media webhook failed (${String(response.status)}): ${await response.text()}`,
    );
}

function launchSyntheticBrowser(): Promise<Browser> {
  return chromium.launch({
    headless: true,
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  });
}

async function liveContext(browser: Browser, joinUrl: string): Promise<BrowserContext> {
  const origin = new URL(joinUrl).origin;
  if (!origin.startsWith("https://")) throw new Error("Jitsi joinUrl must use HTTPS.");
  const context = await browser.newContext({
    ignoreHTTPSErrors: false,
    recordVideo: { dir: "test-results/meet-live" },
  });
  await context.grantPermissions(["camera", "microphone"], { origin });
  await context.addInitScript(() => {
    const scope = globalThis as typeof globalThis & {
      __helixRtcConnections?: RTCPeerConnection[];
      __helixRtcStates?: string[];
    };
    const Native = scope.RTCPeerConnection;
    const connections: RTCPeerConnection[] = [];
    const states: string[] = [];
    class RelayOnlyPeerConnection extends Native {
      constructor(configuration?: RTCConfiguration) {
        super({ ...configuration, iceTransportPolicy: "relay" });
        connections.push(this);
        const record = () => states.push(this.connectionState);
        this.addEventListener("connectionstatechange", record);
        record();
      }
    }
    scope.__helixRtcConnections = connections;
    scope.__helixRtcStates = states;
    scope.RTCPeerConnection = RelayOnlyPeerConnection;
  });
  return context;
}

async function openHarness(
  context: BrowserContext,
  joinUrl: string,
  displayName: string,
): Promise<Page> {
  const join = new URL(joinUrl);
  const jwt = join.searchParams.get("jwt");
  if (jwt === null) throw new Error("Jitsi joinUrl has no JWT.");
  const roomName = decodeURIComponent(join.pathname.replace(/^\/+|\/+$/gu, ""));
  if (roomName.length === 0) throw new Error("Jitsi joinUrl has no room name.");
  const page = await context.newPage();
  await page.setContent(
    `<main id="meet" style="width:1280px;height:720px"></main><script src="${join.origin}/external_api.js"></script>`,
  );
  await page.waitForFunction(() => "JitsiMeetExternalAPI" in window, undefined, {
    timeout: 60_000,
  });
  await page.evaluate(
    ({ domain, jwtValue, name, room }) => {
      type EventRecord = { name: string; payload: Record<string, unknown> };
      type Api = {
        addListener(name: string, handler: (payload: Record<string, unknown>) => void): void;
        executeCommand(name: string, ...args: unknown[]): void;
        getParticipantsInfo(): readonly { displayName?: string; participantId?: string }[];
      };
      const state = {
        ready: false,
        joined: false,
        localId: null as string | null,
        events: [] as EventRecord[],
      };
      const Ctor = (
        window as typeof window & {
          JitsiMeetExternalAPI: new (domain: string, options: unknown) => Api;
        }
      ).JitsiMeetExternalAPI;
      const api = new Ctor(domain, {
        roomName: room,
        jwt: jwtValue,
        parentNode: document.querySelector("#meet"),
        userInfo: { displayName: name },
        configOverwrite: {
          prejoinPageEnabled: false,
          startWithAudioMuted: false,
          startWithVideoMuted: false,
          disableDeepLinking: true,
          p2p: { enabled: false },
        },
      });
      const listen = (eventName: string) => {
        api.addListener(eventName, (payload) => {
          state.events.push({ name: eventName, payload });
          if (eventName === "videoConferenceJoined") {
            state.joined = true;
            state.localId = typeof payload.id === "string" ? payload.id : null;
          }
          if (eventName === "videoConferenceLeft") state.joined = false;
        });
      };
      for (const eventName of [
        "videoConferenceJoined",
        "videoConferenceLeft",
        "participantJoined",
        "participantLeft",
        "audioMuteStatusChanged",
        "recordingStatusChanged",
      ])
        listen(eventName);
      (window as typeof window & { __helixMeetLive?: unknown }).__helixMeetLive = {
        state,
        command: (commandName: string, ...args: unknown[]) => {
          api.executeCommand(commandName, ...args);
        },
        snapshot: () => ({
          ...state,
          participants: api.getParticipantsInfo().map((participant) => ({
            id: participant.participantId ?? "",
            displayName: participant.displayName ?? "",
          })),
        }),
      };
      state.ready = true;
    },
    { domain: join.host, jwtValue: jwt, name: displayName, room: roomName },
  );
  return page;
}

async function snapshot(page: Page): Promise<HarnessSnapshot> {
  return page.evaluate(() => {
    const live = (window as typeof window & { __helixMeetLive?: { snapshot(): HarnessSnapshot } })
      .__helixMeetLive;
    if (live === undefined) throw new Error("Meet live harness is unavailable.");
    return live.snapshot();
  });
}

async function participant(page: Page, displayName: string) {
  const current = await snapshot(page);
  const found = current.participants.find((candidate) => candidate.displayName === displayName);
  if (found === undefined || found.id.length === 0)
    throw new Error(`Missing Jitsi participant: ${displayName}`);
  return found;
}

async function command(page: Page, name: string, ...args: unknown[]): Promise<void> {
  await page.evaluate(
    ({ commandName, commandArgs }) => {
      const live = (
        window as typeof window & {
          __helixMeetLive?: { command(name: string, ...args: unknown[]): void };
        }
      ).__helixMeetLive;
      if (live === undefined) throw new Error("Meet live harness is unavailable.");
      live.command(commandName, ...commandArgs);
    },
    { commandName: name, commandArgs: args },
  );
}

async function executeMediaCommands(
  page: Page,
  commands: HostControlResult["mediaCommands"],
): Promise<void> {
  for (const mediaCommand of commands) {
    if (mediaCommand.command === "muteRemoteParticipant") {
      await command(page, mediaCommand.command, mediaCommand.participantId, mediaCommand.mediaType);
    }
  }
}

async function eventSeen(page: Page, name: string, key: string, value: unknown): Promise<boolean> {
  return (await snapshot(page)).events.some(
    (event) => event.name === name && event.payload[key] === value,
  );
}

async function recordingState(page: Page): Promise<boolean> {
  const events = (await snapshot(page)).events.filter(
    ({ name }) => name === "recordingStatusChanged",
  );
  return events.at(-1)?.payload.on === true;
}

async function rtcStateSeen(page: Page, expected: readonly string[]): Promise<boolean> {
  return page.frames().reduce<Promise<boolean>>(async (prior, frame) => {
    if (await prior) return true;
    return frame
      .evaluate((values) => {
        const states =
          (globalThis as typeof globalThis & { __helixRtcStates?: string[] }).__helixRtcStates ??
          [];
        return states.some((state) => values.includes(state));
      }, expected)
      .catch(() => false);
  }, Promise.resolve(false));
}

async function rtcReconnectSeen(page: Page): Promise<boolean> {
  return page.frames().reduce<Promise<boolean>>(async (prior, frame) => {
    if (await prior) return true;
    return frame
      .evaluate(() => {
        const states =
          (globalThis as typeof globalThis & { __helixRtcStates?: string[] }).__helixRtcStates ??
          [];
        const interruption = states.findIndex(
          (state) => state === "disconnected" || state === "failed",
        );
        return interruption >= 0 && states.slice(interruption + 1).includes("connected");
      })
      .catch(() => false);
  }, Promise.resolve(false));
}

async function waitForMedia(page: Page): Promise<MediaStats> {
  let latest: MediaStats = emptyStats();
  await expect
    .poll(
      async () => {
        latest = await readMediaStats(page);
        return minimumMediaBytes(latest);
      },
      { timeout: 90_000, intervals: [1_000, 2_000, 5_000] },
    )
    .toBeGreaterThan(1_000);
  return latest;
}

async function waitForMediaGrowth(page: Page, before: MediaStats): Promise<MediaStats> {
  let latest: MediaStats = emptyStats();
  await expect
    .poll(
      async () => {
        latest = await readMediaStats(page);
        return Math.min(
          latest.inbound.audio - before.inbound.audio,
          latest.inbound.video - before.inbound.video,
          latest.outbound.audio - before.outbound.audio,
          latest.outbound.video - before.outbound.video,
        );
      },
      { timeout: 90_000, intervals: [1_000, 2_000, 5_000] },
    )
    .toBeGreaterThan(1_000);
  return latest;
}

async function readMediaStats(page: Page): Promise<MediaStats> {
  const reports = await Promise.all(
    page.frames().map((frame) =>
      frame
        .evaluate(async () => {
          const connections =
            (globalThis as typeof globalThis & { __helixRtcConnections?: RTCPeerConnection[] })
              .__helixRtcConnections ?? [];
          const result = emptyStats();
          for (const peer of connections) {
            const stats = await peer.getStats();
            const selectedPairs = new Set<string>();
            stats.forEach((entry) => {
              const stat = entry as RTCStats & Record<string, unknown>;
              if (stat.type === "transport" && typeof stat.selectedCandidatePairId === "string")
                selectedPairs.add(stat.selectedCandidatePairId);
              if (
                stat.type === "candidate-pair" &&
                stat.state === "succeeded" &&
                stat.nominated === true
              )
                selectedPairs.add(stat.id);
            });
            stats.forEach((entry) => {
              const stat = entry as RTCStats & Record<string, unknown>;
              if (
                (stat.type === "inbound-rtp" || stat.type === "outbound-rtp") &&
                stat.isRemote !== true
              ) {
                const kind = stat.kind ?? stat.mediaType;
                if (
                  (kind === "audio" || kind === "video") &&
                  typeof stat.bytesReceived === "number"
                )
                  result.inbound[kind] += stat.bytesReceived;
                if ((kind === "audio" || kind === "video") && typeof stat.bytesSent === "number")
                  result.outbound[kind] += stat.bytesSent;
              }
              if (stat.type === "local-candidate" && typeof stat.candidateType === "string") {
                const selected = [...selectedPairs].some(
                  (id) => stats.get(id)?.localCandidateId === stat.id,
                );
                if (selected) result.candidateTypes.push(stat.candidateType);
              }
            });
            result.connectionStates.push(peer.connectionState);
          }
          return result;
        })
        .catch(() => emptyStats()),
    ),
  );
  return reports.reduce<MediaStats>(
    (all, report) => ({
      inbound: {
        audio: all.inbound.audio + report.inbound.audio,
        video: all.inbound.video + report.inbound.video,
      },
      outbound: {
        audio: all.outbound.audio + report.outbound.audio,
        video: all.outbound.video + report.outbound.video,
      },
      candidateTypes: [...all.candidateTypes, ...report.candidateTypes],
      connectionStates: [...all.connectionStates, ...report.connectionStates],
    }),
    emptyStats(),
  );
}

function emptyStats(): {
  inbound: Record<"audio" | "video", number>;
  outbound: Record<"audio" | "video", number>;
  candidateTypes: string[];
  connectionStates: string[];
} {
  return {
    inbound: { audio: 0, video: 0 },
    outbound: { audio: 0, video: 0 },
    candidateTypes: [],
    connectionStates: [],
  };
}

function minimumMediaBytes(stats: MediaStats): number {
  return Math.min(
    stats.inbound.audio,
    stats.inbound.video,
    stats.outbound.audio,
    stats.outbound.video,
  );
}

function assertRelayMedia(stats: MediaStats): void {
  expect(
    stats.candidateTypes.length,
    "selected ICE candidate evidence is required",
  ).toBeGreaterThan(0);
  expect([...new Set(stats.candidateTypes)]).toEqual(["relay"]);
  expect(
    minimumMediaBytes(stats),
    "both audio and video must flow in both directions",
  ).toBeGreaterThan(1_000);
}

async function waitForRecording(
  config: LiveConfig,
  token: string,
  roomId: string,
): Promise<RecordingArtifact> {
  let artifact: RecordingArtifact | undefined;
  await expect
    .poll(
      async () => {
        const rooms = await callTool<{ rooms: readonly LiveRoom[] }>(
          config,
          token,
          "meet.room.list",
          { status: "active", limit: 10 },
        );
        artifact = rooms.rooms
          .find((candidate) => candidate.id === roomId)
          ?.recordingArtifacts?.at(-1);
        return artifact?.objectId ?? null;
      },
      { timeout: 240_000, intervals: [2_000, 5_000, 10_000] },
    )
    .not.toBeNull();
  if (artifact === undefined) throw new Error("Jibri recording webhook produced no artifact.");
  return artifact;
}

async function authenticatedBytes(url: string, token: string): Promise<Buffer> {
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Recording download failed (${String(response.status)}).`);
  return Buffer.from(await response.arrayBuffer());
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return recordValue(await response.json().catch(() => ({}))) ?? {};
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function errorText(value: unknown): string {
  const record = recordValue(value);
  const nested = recordValue(record?.error);
  return stringValue(nested?.message) ?? stringValue(record?.error) ?? "request failed";
}
