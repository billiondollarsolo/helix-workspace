#!/usr/bin/env node
/* global fetch, AbortSignal, WebSocket, setTimeout, clearTimeout, window, performance, crypto */
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { access, chmod, readFile, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { pathToFileURL, URL } from "node:url";
import {
  CHAT_LIVE_EVIDENCE_SCHEMA,
  CHAT_LIVE_SCENARIOS,
  CHAT_RELEASE_LOAD_MINIMUMS,
  assertNoSensitiveChatEvidence,
  createChatEvidenceSkeleton,
  evidenceHash,
  validateChatLiveEvidence,
} from "./chat-live-evidence-contract.mjs";

export {
  CHAT_LIVE_EVIDENCE_SCHEMA,
  CHAT_LIVE_SCENARIOS,
  CHAT_RELEASE_LOAD_MINIMUMS,
  assertNoSensitiveChatEvidence,
  createChatEvidenceSkeleton,
  evidenceHash,
  validateChatLiveEvidence,
};

const execFileAsync = promisify(execFile);
const requireFromApp = createRequire(new URL("../../apps/helix/package.json", import.meta.url));
const DEFAULT_TIMEOUT_MS = 20_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

if (isMain()) {
  await main();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  let evidence;
  if (options.validate !== undefined) {
    evidence = validateChatLiveEvidence(JSON.parse(await readFile(options.validate, "utf8")), {
      requirePass: options.requirePass,
      requireReleaseLoad: options.requireReleaseLoad,
    });
  } else if (options.config === undefined) {
    evidence = createChatEvidenceSkeleton();
    validateChatLiveEvidence(evidence, {
      requirePass: options.requirePass,
      requireReleaseLoad: options.requireReleaseLoad,
    });
  } else {
    evidence = await runChatLiveEvidence(options.config);
    validateChatLiveEvidence(evidence, {
      requirePass: options.requirePass,
      requireReleaseLoad: options.requireReleaseLoad,
    });
  }

  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  if (options.output !== undefined) {
    await writeFilePrivate(options.output, serialized);
  }
  process.stdout.write(serialized);
}

export async function runChatLiveEvidence(configPath) {
  let config;
  try {
    await protectedFile(configPath, process.cwd(), "runner config");
    config = await validateConfig(
      JSON.parse(await readFile(configPath, "utf8")),
      dirname(configPath),
    );
    const replicaIdentities = await Promise.all(
      config.replicaIdentityCommands.map((command, index) =>
        runProtectedCommand(command, `replica ${index + 1} identity probe`),
      ),
    );
    const normalizedIdentities = replicaIdentities.map((identity) => identity.trim());
    if (
      normalizedIdentities.some(
        (identity) => identity.length === 0 || !/^[a-z0-9._:-]{1,256}$/iu.test(identity),
      ) ||
      new Set(normalizedIdentities).size !== 2
    ) {
      throw new Error("replica identity probes did not return two distinct safe identities");
    }
    config.replicaIdentityHashes = normalizedIdentities.map(evidenceHash);
  } catch (error) {
    return failedSetupEvidence(`invalid protected runner configuration (${errorName(error)})`);
  }

  const evidence = createChatEvidenceSkeleton();
  evidence.mode = "live";
  evidence.profile = config.load.profile;
  evidence.environment = {
    replicaCount: config.replicaUrls.length,
    transport: "wss",
    tlsVerified: true,
    replicaHashes: config.replicaIdentityHashes,
  };

  let browser;
  let sender;
  let receiver;
  let nonMember;
  try {
    const { chromium } = requireFromApp("playwright");
    browser = await chromium.launch({ headless: true });
    [sender, receiver, nonMember] = await Promise.all([
      openBrowserClient(browser, config.actors.sender, config.replicaUrls[0], 1),
      openBrowserClient(browser, config.actors.receiver, config.replicaUrls[1], 1),
      openBrowserClient(browser, config.actors.nonMember, config.replicaUrls[1], 1),
    ]);
    await Promise.all([waitReady(sender), waitReady(receiver), waitReady(nonMember)]);
    const actorIds = [sender.actorId, receiver.actorId, nonMember.actorId];
    if (actorIds.some((actorId) => actorId === undefined) || new Set(actorIds).size !== 3) {
      throw new Error("functional browser states did not resolve to three distinct actors");
    }
  } catch (error) {
    await closeAll([sender, receiver, nonMember, browser]);
    return failedSetupEvidence(`live Chat fixture unavailable (${errorName(error)})`, evidence);
  }

  const runtime = {
    config,
    evidence,
    browser,
    sender,
    receiver,
    nonMember,
    markerPrefix: `helix-chat-evidence-${randomUUID()}`,
  };

  try {
    await executeScenario(evidence, "authenticated_browser_fanout", () =>
      proveAuthenticatedBrowserFanout(runtime),
    );
    await executeScenario(evidence, "non_member_denials", () => proveNonMemberDenials(runtime));
    await executeScenario(evidence, "multi_replica_nats_fanout", () =>
      proveMultiReplicaFanout(runtime),
    );
    for (const dependency of ["app", "redis", "nats"]) {
      await executeScenario(evidence, `${dependency}_restart_reconnect_durability`, () =>
        proveRestart(runtime, dependency),
      );
    }
    await executeScenario(evidence, "clean_drive_attachment", () => proveCleanAttachment(runtime));
    await executeScenario(evidence, "eicar_drive_attachment_denied", () =>
      proveEicarAttachmentDenied(runtime),
    );
    await executeScenario(evidence, "invalid_origin_and_token_leakage", () =>
      proveOriginAndLeakage(runtime),
    );
    await executeScenario(evidence, "pilot_load", () => provePilotLoad(runtime));
  } finally {
    await closeAll([sender, receiver, nonMember, browser]);
  }

  evidence.status = deriveStatus(evidence.scenarios);
  assertNoSensitiveChatEvidence(evidence);
  return evidence;
}

async function proveAuthenticatedBrowserFanout(runtime) {
  const { sender, receiver, config } = runtime;
  await Promise.all([subscribe(sender, config.roomId), subscribe(receiver, config.roomId)]);
  const first = await sendAndObserve({
    sender,
    receiver,
    roomId: config.roomId,
    marker: `${runtime.markerPrefix}-browser-a`,
  });
  const second = await sendAndObserve({
    sender: receiver,
    receiver: sender,
    roomId: config.roomId,
    marker: `${runtime.markerPrefix}-browser-b`,
  });
  return {
    twoAuthenticatedBrowserContexts: sender.context !== receiver.context,
    bidirectionalMessagesObserved: first.observed && second.observed,
    realWebSockets: true,
    roomHash: evidenceHash(config.roomId),
    messagesObserved: 2,
  };
}

async function proveNonMemberDenials(runtime) {
  const { nonMember, config } = runtime;
  const roomList = await callTool(nonMember, "chat.room.list", { limit: 100 });
  requireStatus(roomList, [200], "non-member room listing");
  const rooms = Array.isArray(roomList.body?.rooms) ? roomList.body.rooms : [];
  const roomAbsentFromList = !rooms.some((room) => room?.id === config.roomId);

  const restList = await callTool(nonMember, "chat.message.list", {
    roomId: config.roomId,
    limit: 10,
  });
  const restSearch = await callTool(nonMember, "chat.search", {
    roomId: config.roomId,
    query: runtime.markerPrefix,
    limit: 10,
  });
  const restSend = await callTool(nonMember, "chat.send", {
    roomId: config.roomId,
    body: `${runtime.markerPrefix}-forbidden-rest`,
    bodyFormat: "plain",
    attachmentObjectIds: [],
    metadata: {},
  });
  for (const [label, result] of [
    ["list", restList],
    ["search", restSearch],
    ["send", restSend],
  ]) {
    requireStatus(result, [403, 404], `non-member REST ${label}`);
  }

  await sendFrame(nonMember, 0, { type: "subscribe", roomId: config.roomId });
  const subscribeError = await waitForFrame(
    nonMember,
    (entry) =>
      entry.socketIndex === 0 &&
      entry.frame?.type === "error" &&
      ["not_found", "forbidden"].includes(entry.frame?.code),
    DEFAULT_TIMEOUT_MS,
    "non-member WebSocket subscribe denial",
  );
  await sendFrame(nonMember, 0, {
    type: "send",
    roomId: config.roomId,
    body: `${runtime.markerPrefix}-forbidden-ws`,
    bodyFormat: "plain",
  });
  const sendError = await waitForFrame(
    nonMember,
    (entry) =>
      entry.socketIndex === 0 &&
      entry.frame?.type === "error" &&
      ["not_found", "forbidden"].includes(entry.frame?.code),
    DEFAULT_TIMEOUT_MS,
    "non-member WebSocket send denial",
  );

  return {
    roomAbsentFromList,
    restListDenied: [403, 404].includes(restList.status),
    restSearchDenied: [403, 404].includes(restSearch.status),
    restSendDenied: [403, 404].includes(restSend.status),
    websocketSubscribeDenied: subscribeError !== undefined,
    websocketSendDenied: sendError !== undefined,
  };
}

async function proveMultiReplicaFanout(runtime) {
  const { sender, receiver, config } = runtime;
  if (config.replicaUrls[0].origin === config.replicaUrls[1].origin) {
    throw new Error("replica endpoints are not distinct");
  }
  await Promise.all([subscribe(sender, config.roomId), subscribe(receiver, config.roomId)]);
  const aToB = await sendAndObserve({
    sender,
    receiver,
    roomId: config.roomId,
    marker: `${runtime.markerPrefix}-replica-a-to-b`,
  });
  const bToA = await sendAndObserve({
    sender: receiver,
    receiver: sender,
    roomId: config.roomId,
    marker: `${runtime.markerPrefix}-replica-b-to-a`,
  });
  return {
    distinctReplicaEndpoints: 2,
    replicaAToB: aToB.observed,
    replicaBToA: bToA.observed,
    replicaAHash: config.replicaIdentityHashes[0],
    replicaBHash: config.replicaIdentityHashes[1],
  };
}

async function proveRestart(runtime, dependency) {
  const { sender, receiver, config } = runtime;
  const hook = config.restartHooks[dependency];
  const before = `${runtime.markerPrefix}-${dependency}-before`;
  const after = `${runtime.markerPrefix}-${dependency}-after`;
  await Promise.all([subscribe(sender, config.roomId), subscribe(receiver, config.roomId)]);
  await sendAndObserve({ sender, receiver, roomId: config.roomId, marker: before });
  const reconnectsBefore =
    (await socketSnapshot(sender)).reconnects + (await socketSnapshot(receiver)).reconnects;
  const started = Date.now();
  await runProtectedCommand(hook, `restart ${dependency}`);
  await Promise.all(config.replicaUrls.map((url) => waitForReadyz(url)));
  await Promise.all([forceReconnect(sender), forceReconnect(receiver)]);
  await Promise.all([waitReady(sender), waitReady(receiver)]);
  await Promise.all([subscribe(sender, config.roomId), subscribe(receiver, config.roomId)]);
  await sendAndObserve({ sender, receiver, roomId: config.roomId, marker: after });
  const durable = await callTool(receiver, "chat.search", {
    roomId: config.roomId,
    query: before,
    limit: 10,
  });
  requireStatus(durable, [200], `${dependency} restart durability search`);
  const hits = Array.isArray(durable.body?.hits) ? durable.body.hits : [];
  if (!hits.some((hit) => stringContains(hit?.body, before))) {
    throw new Error(`${dependency} restart lost the pre-restart message`);
  }
  const reconnectsAfter =
    (await socketSnapshot(sender)).reconnects + (await socketSnapshot(receiver)).reconnects;
  return {
    restartHookSucceeded: true,
    reconnectsObserved: reconnectsAfter - reconnectsBefore,
    preRestartMessageDurable: true,
    postRestartFanoutObserved: true,
    recoveryMs: Date.now() - started,
  };
}

async function proveCleanAttachment(runtime) {
  const { sender, receiver, config } = runtime;
  const status = await callTool(sender, "drive.upload.status", {
    objectId: config.drive.cleanObjectId,
  });
  requireStatus(status, [200], "clean Drive upload status");
  if (status.body?.state !== "active" || status.body?.available !== true) {
    throw new Error("clean Drive attachment is not active and available");
  }
  const marker = `${runtime.markerPrefix}-clean-attachment`;
  const message = await sendAndObserve({
    sender,
    receiver,
    roomId: config.roomId,
    marker,
    attachmentObjectIds: [config.drive.cleanObjectId],
  });
  return {
    driveStateActive: true,
    chatMessageObserved: message.observed,
    objectHash: evidenceHash(config.drive.cleanObjectId),
    messageHash: evidenceHash(message.messageId),
  };
}

async function proveEicarAttachmentDenied(runtime) {
  const { sender, receiver, config } = runtime;
  const status = await callTool(sender, "drive.upload.status", {
    objectId: config.drive.eicarObjectId,
  });
  requireStatus(status, [200], "EICAR Drive upload status");
  if (status.body?.state !== "quarantined" || status.body?.available !== false) {
    throw new Error("EICAR Drive attachment is not quarantined");
  }
  const marker = `${runtime.markerPrefix}-eicar-attachment`;
  await sendFrame(sender, 0, {
    type: "send",
    roomId: config.roomId,
    body: marker,
    bodyFormat: "plain",
    clientMessageId: randomUUID(),
    attachmentObjectIds: [config.drive.eicarObjectId],
  });
  await waitForFrame(
    sender,
    (entry) =>
      entry.socketIndex === 0 &&
      entry.frame?.type === "error" &&
      ["not_found", "forbidden"].includes(entry.frame?.code),
    DEFAULT_TIMEOUT_MS,
    "EICAR Chat attachment denial",
  );
  let messageNotObserved = true;
  try {
    await waitForFrame(
      receiver,
      (entry) =>
        entry.socketIndex === 0 &&
        entry.frame?.type === "message.created" &&
        stringContains(entry.frame?.message?.body, marker),
      1_500,
      "unexpected EICAR Chat message",
    );
    messageNotObserved = false;
  } catch {
    // The expected outcome is no fan-out for the quarantined object.
  }
  if (!messageNotObserved) {
    throw new Error("quarantined EICAR attachment produced a Chat message");
  }
  return {
    driveStateQuarantined: true,
    chatSendDenied: true,
    messageNotObserved,
    objectHash: evidenceHash(config.drive.eicarObjectId),
  };
}

async function proveOriginAndLeakage(runtime) {
  const { browser, sender, config } = runtime;
  const wrongOriginContext = await browser.newContext({
    storageState: config.actors.sender,
  });
  const wrongOriginPage = await wrongOriginContext.newPage();
  let invalidOriginCloseCode;
  try {
    await wrongOriginPage.goto("data:text/html,<title>untrusted-origin</title>");
    invalidOriginCloseCode = await wrongOriginPage.evaluate(
      ({ wsUrl, timeoutMs }) =>
        new Promise((resolve, reject) => {
          const socket = new WebSocket(wsUrl);
          const timer = setTimeout(() => reject(new Error("origin denial timed out")), timeoutMs);
          socket.addEventListener("open", () => {
            socket.send(JSON.stringify({ type: "presence.get", roomId: crypto.randomUUID() }));
          });
          socket.addEventListener("close", (event) => {
            clearTimeout(timer);
            resolve(event.code);
          });
          socket.addEventListener("error", () => {
            // A browser may surface the rejected upgrade as an error before close.
          });
        }),
      {
        wsUrl: websocketUrl(config.replicaUrls[0]).href,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      },
    );
  } finally {
    await wrongOriginContext.close();
  }
  if (invalidOriginCloseCode !== 4403) {
    throw new Error("invalid browser Origin was not rejected with the policy close code");
  }

  const leakMarker = `helix-leak-probe-${randomUUID()}`;
  const authFrames = await firstFrameAuthFailure(config.replicaUrls[0], leakMarker);
  if (authFrames.some((frame) => JSON.stringify(frame).includes(leakMarker))) {
    throw new Error("authentication failure response reflected credential material");
  }
  await delay(config.logProbe.delayMs);
  const logs = await runProtectedCommand(config.logProbe.command, "protected Chat log probe");
  if (logs.includes(leakMarker)) {
    throw new Error("application logs contain the first-frame credential marker");
  }
  const logLinesInspected = logs.split(/\r?\n/u).filter(Boolean).length;
  if (logLinesInspected < 1) {
    throw new Error("protected Chat log probe returned no lines");
  }
  const networkUrls = await browserNetworkUrls(sender);
  const browserNetworkUrlsClean = networkUrls.every((url) => {
    const parsed = new URL(url);
    return ![...parsed.searchParams.keys()].some((key) =>
      /(access.?token|authorization|bearer|cookie|session)/iu.test(key),
    );
  });
  if (!browserNetworkUrlsClean) {
    throw new Error("browser request URLs contain credential-shaped query parameters");
  }
  const browserSocketUrlsClean =
    !websocketUrl(config.replicaUrls[0]).search && !websocketUrl(config.replicaUrls[1]).search;
  return {
    invalidOriginDenied: true,
    invalidOriginCloseCode,
    browserSocketUrlsClean,
    browserNetworkUrlsClean,
    authFailureResponseRedacted: true,
    applicationLogsRedacted: true,
    logLinesInspected,
  };
}

async function provePilotLoad(runtime) {
  const { config, browser } = runtime;
  const profile = config.load.profile;
  const storageStates = config.load.userStorageStates.slice(0, profile.users);
  const contexts = [];
  const clients = [];
  const latencies = [];
  const sendTimes = new Map();
  let attempted = 0;
  let observed = 0;
  let errors = 0;
  let burstTrafficObserved = false;
  let steadyTrafficObserved = false;
  let trafficDurationSeconds = 0;
  const memorySamples = [];
  const eventLoopSamples = [];
  const dbPoolSamples = [];
  const redisSamples = [];
  const natsSamples = [];
  let loadStartedAt = 0;
  const socketsPerUser = distribute(profile.sockets, profile.users);

  try {
    for (let index = 0; index < profile.users; index += 1) {
      const client = await openBrowserClient(
        browser,
        storageStates[index],
        config.replicaUrls[index % config.replicaUrls.length],
        socketsPerUser[index],
      );
      contexts.push(client.context);
      clients.push(client);
    }
    await Promise.all(clients.map((client) => waitReady(client, DEFAULT_TIMEOUT_MS * 3)));
    const loadActorIds = clients.map((client) => client.actorId);
    if (
      loadActorIds.some((actorId) => actorId === undefined) ||
      new Set(loadActorIds).size !== profile.users
    ) {
      throw new Error("pilot browser states did not resolve to the configured distinct users");
    }
    await Promise.all(clients.map((client) => subscribeAll(client, config.roomId)));
    await collectOperationalSample(config, {
      memorySamples,
      eventLoopSamples,
      dbPoolSamples,
      redisSamples,
      natsSamples,
    });

    const observer = clients[0];
    loadStartedAt = Date.now();
    const stopAt = loadStartedAt + profile.durationSeconds * 1_000;
    let nextSteadyAt = Date.now();
    let nextBurstAt = Date.now() + profile.burstIntervalSeconds * 1_000;
    let nextSampleAt = Date.now() + config.load.sampleIntervalMs;
    let senderIndex = 0;
    while (Date.now() < stopAt) {
      const now = Date.now();
      const batch =
        now >= nextBurstAt
          ? profile.burstMessages
          : now >= nextSteadyAt
            ? Math.max(1, Math.floor(profile.steadyMessagesPerSecond))
            : 0;
      if (batch > 0) {
        if (now >= nextBurstAt) {
          burstTrafficObserved = true;
          nextBurstAt += profile.burstIntervalSeconds * 1_000;
        } else {
          steadyTrafficObserved = true;
          nextSteadyAt += (1_000 * Math.max(1, batch)) / profile.steadyMessagesPerSecond;
        }
        for (let offset = 0; offset < batch; offset += 1) {
          const client = clients[senderIndex % clients.length];
          const socketIndex =
            Math.floor(senderIndex / clients.length) % socketsPerUser[senderIndex % clients.length];
          senderIndex += 1;
          const clientMessageId = randomUUID();
          sendTimes.set(clientMessageId, Date.now());
          attempted += 1;
          try {
            await sendFrame(client, socketIndex, {
              type: "send",
              roomId: config.roomId,
              body: `${runtime.markerPrefix}-load`,
              bodyFormat: "plain",
              clientMessageId,
            });
          } catch {
            errors += 1;
          }
        }
      }

      const frames = await drainFrames(observer);
      for (const entry of frames) {
        const clientMessageId = entry.frame?.message?.clientMessageId;
        if (
          entry.frame?.type === "message.created" &&
          typeof clientMessageId === "string" &&
          sendTimes.has(clientMessageId)
        ) {
          const sentAt = sendTimes.get(clientMessageId);
          sendTimes.delete(clientMessageId);
          latencies.push(Math.max(0, entry.observedAt - sentAt));
          observed += 1;
        } else if (entry.frame?.type === "error") {
          errors += 1;
        }
      }
      if (Date.now() >= nextSampleAt) {
        await collectOperationalSample(config, {
          memorySamples,
          eventLoopSamples,
          dbPoolSamples,
          redisSamples,
          natsSamples,
        });
        nextSampleAt += config.load.sampleIntervalMs;
      }
      await delay(25);
    }
    trafficDurationSeconds = Math.floor((Date.now() - loadStartedAt) / 1_000);

    const drainDeadline = Date.now() + config.load.deliveryDrainMs;
    while (sendTimes.size > 0 && Date.now() < drainDeadline) {
      for (const entry of await drainFrames(clients[0])) {
        const clientMessageId = entry.frame?.message?.clientMessageId;
        if (entry.frame?.type === "message.created" && sendTimes.has(clientMessageId)) {
          const sentAt = sendTimes.get(clientMessageId);
          sendTimes.delete(clientMessageId);
          latencies.push(Math.max(0, entry.observedAt - sentAt));
          observed += 1;
        }
      }
      await delay(25);
    }
    errors += sendTimes.size;
    await collectOperationalSample(config, {
      memorySamples,
      eventLoopSamples,
      dbPoolSamples,
      redisSamples,
      natsSamples,
    });
  } finally {
    await Promise.allSettled(contexts.map((context) => context.close()));
  }

  const sortedLatencies = latencies.sort((left, right) => left - right);
  const p95LatencyMs = percentile(sortedLatencies, 0.95);
  const p99LatencyMs = percentile(sortedLatencies, 0.99);
  const memoryStartBytes = memorySamples[0] ?? 0;
  const memoryEndBytes = memorySamples.at(-1) ?? 0;
  const memoryPeakBytes = Math.max(...memorySamples, 0);
  const memoryGrowthBytes = Math.max(
    0,
    memoryEndBytes - memoryStartBytes,
    memoryPeakBytes - memoryStartBytes,
  );
  const errorRate = attempted === 0 ? 1 : errors / attempted;
  const eventLoopLagPeakMs = Math.max(...eventLoopSamples, 0);
  const dbPoolPendingPeak = Math.max(...dbPoolSamples, 0);
  const redisBacklogPeak = Math.max(...redisSamples, 0);
  const natsBacklogPeak = Math.max(...natsSamples, 0);
  const thresholds = profile.thresholds;
  const noUnboundedMemoryGrowth = memoryGrowthBytes <= thresholds.maxMemoryGrowthBytes;
  const backlogsWithinLimits =
    dbPoolPendingPeak <= thresholds.maxDbPoolPending &&
    redisBacklogPeak <= thresholds.maxRedisBacklog &&
    natsBacklogPeak <= thresholds.maxNatsBacklog;
  if (
    attempted === 0 ||
    observed !== attempted ||
    errorRate > thresholds.maxErrorRate ||
    p95LatencyMs > thresholds.p95LatencyMs ||
    p99LatencyMs > thresholds.p99LatencyMs ||
    eventLoopLagPeakMs > thresholds.maxEventLoopLagMs ||
    !noUnboundedMemoryGrowth ||
    !backlogsWithinLimits ||
    !steadyTrafficObserved ||
    !burstTrafficObserved
  ) {
    throw new Error("pilot Chat load violated its measured service-level thresholds");
  }

  return {
    actualUsers: profile.users,
    actualSockets: profile.sockets,
    durationSeconds: trafficDurationSeconds,
    messagesAttempted: attempted,
    messagesObserved: observed,
    errors,
    errorRate,
    p95LatencyMs,
    p99LatencyMs,
    memoryStartBytes,
    memoryPeakBytes,
    memoryEndBytes,
    memoryGrowthBytes,
    eventLoopLagPeakMs,
    dbPoolPendingPeak,
    redisBacklogPeak,
    natsBacklogPeak,
    steadyTrafficObserved,
    burstTrafficObserved,
    noUnboundedMemoryGrowth,
    backlogsWithinLimits,
  };
}

async function executeScenario(evidence, name, execute) {
  const startedAt = new Date().toISOString();
  try {
    const scenarioEvidence = await execute();
    evidence.scenarios[name] = {
      status: "passed",
      startedAt,
      completedAt: new Date().toISOString(),
      evidence: scenarioEvidence,
    };
  } catch (error) {
    evidence.scenarios[name] = {
      status: "failed",
      reason: `Live scenario failed (${errorName(error)}); inspect protected operator logs.`,
    };
  }
}

async function openBrowserClient(browser, storageStatePath, origin, socketCount) {
  const context = await browser.newContext({ storageState: storageStatePath });
  const page = await context.newPage();
  const networkUrls = [];
  page.on("request", (request) => {
    if (networkUrls.length < 20_000) networkUrls.push(request.url());
  });
  const response = await page.goto(new URL("/healthz", origin).href, {
    waitUntil: "domcontentloaded",
    timeout: DEFAULT_TIMEOUT_MS,
  });
  if (response === null || response.status() !== 200) {
    await context.close();
    throw new Error("application health endpoint is unavailable");
  }
  await page.evaluate(
    ({ count, wsUrl }) => {
      const state = {
        sockets: [],
        frames: [],
        closes: [],
        reconnects: 0,
        stopped: false,
        subscriptions: new Set(),
      };
      const appendFrame = (entry) => {
        state.frames.push(entry);
        if (state.frames.length > 20_000) state.frames.splice(0, state.frames.length - 20_000);
      };
      const connect = (socketIndex) => {
        const socket = new WebSocket(wsUrl);
        state.sockets[socketIndex] = socket;
        socket.addEventListener("message", (event) => {
          let frame;
          try {
            frame = JSON.parse(String(event.data));
          } catch {
            frame = { type: "invalid_json" };
          }
          appendFrame({ socketIndex, observedAt: Date.now(), frame });
          if (frame.type === "ready") {
            for (const roomId of state.subscriptions) {
              socket.send(JSON.stringify({ type: "subscribe", roomId }));
            }
          }
        });
        socket.addEventListener("close", (event) => {
          state.closes.push({ socketIndex, code: event.code, observedAt: Date.now() });
          if (!state.stopped) {
            state.reconnects += 1;
            setTimeout(() => connect(socketIndex), 200);
          }
        });
      };
      for (let socketIndex = 0; socketIndex < count; socketIndex += 1) connect(socketIndex);
      window.__helixChatEvidence = state;
    },
    { count: socketCount, wsUrl: websocketUrl(origin).href },
  );
  return { context, page, socketCount, networkUrls };
}

async function waitReady(client, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const ready = new Set();
  const actorIds = new Set();
  const deadline = Date.now() + timeoutMs;
  while (ready.size < client.socketCount && Date.now() < deadline) {
    for (const entry of await drainFrames(client)) {
      if (entry.frame?.type === "ready") {
        ready.add(entry.socketIndex);
        if (typeof entry.frame.actorId === "string") actorIds.add(entry.frame.actorId);
      }
      if (entry.frame?.type === "error") {
        throw new Error("browser Chat socket authentication failed");
      }
    }
    if (ready.size < client.socketCount) await delay(25);
  }
  if (ready.size !== client.socketCount) {
    throw new Error("not all authenticated browser Chat sockets became ready");
  }
  if (actorIds.size !== 1) {
    throw new Error("browser Chat sockets did not resolve to one stable actor");
  }
  client.actorId = [...actorIds][0];
}

async function subscribe(client, roomId, socketIndex = 0) {
  await client.page.evaluate(({ roomId: id }) => window.__helixChatEvidence.subscriptions.add(id), {
    roomId,
  });
  await sendFrame(client, socketIndex, { type: "subscribe", roomId });
  await waitForFrame(
    client,
    (entry) =>
      entry.socketIndex === socketIndex &&
      entry.frame?.type === "subscribed" &&
      entry.frame?.roomId === roomId,
    DEFAULT_TIMEOUT_MS,
    "Chat room subscription",
  );
}

async function subscribeAll(client, roomId) {
  await client.page.evaluate(({ roomId: id }) => window.__helixChatEvidence.subscriptions.add(id), {
    roomId,
  });
  for (let socketIndex = 0; socketIndex < client.socketCount; socketIndex += 1) {
    await sendFrame(client, socketIndex, { type: "subscribe", roomId });
  }
  const subscribed = new Set();
  const deadline = Date.now() + DEFAULT_TIMEOUT_MS * 3;
  while (subscribed.size < client.socketCount && Date.now() < deadline) {
    for (const entry of await drainFrames(client)) {
      if (entry.frame?.type === "subscribed" && entry.frame?.roomId === roomId) {
        subscribed.add(entry.socketIndex);
      }
    }
    if (subscribed.size < client.socketCount) await delay(25);
  }
  if (subscribed.size !== client.socketCount) {
    throw new Error("not all pilot Chat sockets subscribed");
  }
}

async function sendAndObserve({ sender, receiver, roomId, marker, attachmentObjectIds = [] }) {
  const clientMessageId = randomUUID();
  await sendFrame(sender, 0, {
    type: "send",
    roomId,
    body: marker,
    bodyFormat: "plain",
    clientMessageId,
    attachmentObjectIds,
  });
  const observed = await waitForFrame(
    receiver,
    (entry) =>
      entry.socketIndex === 0 &&
      entry.frame?.type === "message.created" &&
      entry.frame?.roomId === roomId &&
      entry.frame?.message?.clientMessageId === clientMessageId &&
      entry.frame?.message?.body === marker,
    DEFAULT_TIMEOUT_MS,
    "Chat message fan-out",
  );
  const messageId = observed.frame?.message?.id;
  if (typeof messageId !== "string") {
    throw new Error("Chat fan-out omitted the durable message identifier");
  }
  return { observed: true, messageId };
}

async function sendFrame(client, socketIndex, frame) {
  await client.page.evaluate(
    ({ socketIndex: index, frame: payload }) => {
      const socket = window.__helixChatEvidence.sockets[index];
      if (socket?.readyState !== WebSocket.OPEN) throw new Error("Chat socket is not open");
      socket.send(JSON.stringify(payload));
    },
    { socketIndex, frame },
  );
}

async function waitForFrame(client, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const entry of await drainFrames(client)) {
      if (predicate(entry)) return entry;
    }
    await delay(25);
  }
  throw new Error(`${label} timed out`);
}

async function drainFrames(client) {
  return client.page.evaluate(() => window.__helixChatEvidence.frames.splice(0));
}

async function forceReconnect(client) {
  await client.page.evaluate(() => {
    for (const socket of window.__helixChatEvidence.sockets) {
      socket?.close(1012, "live evidence reconnect");
    }
  });
}

async function socketSnapshot(client) {
  return client.page.evaluate(() => ({
    reconnects: window.__helixChatEvidence.reconnects,
    closes: window.__helixChatEvidence.closes.length,
  }));
}

async function browserNetworkUrls(client) {
  const resourceUrls = await client.page.evaluate(() =>
    performance.getEntriesByType("resource").map((entry) => entry.name),
  );
  return [...client.networkUrls, ...resourceUrls];
}

async function callTool(client, toolId, input) {
  return client.page.evaluate(
    async ({ toolId: id, input: body }) => {
      const response = await fetch(`/api/tools/${encodeURIComponent(id)}`, {
        method: "POST",
        credentials: "include",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      let parsed = null;
      try {
        parsed = await response.json();
      } catch {
        // The status remains authoritative for denial assertions.
      }
      return { status: response.status, body: parsed };
    },
    { toolId, input },
  );
}

async function firstFrameAuthFailure(origin, marker) {
  const url = websocketUrl(origin);
  return new Promise((resolveFrames, reject) => {
    const frames = [];
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("first-frame authentication failure timed out"));
    }, DEFAULT_TIMEOUT_MS);
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "auth", token: marker }));
    });
    socket.addEventListener("message", (event) => {
      try {
        frames.push(JSON.parse(String(event.data)));
      } catch {
        frames.push({ type: "invalid_json" });
      }
    });
    socket.addEventListener("close", (event) => {
      clearTimeout(timer);
      if (event.code !== 4401) {
        reject(new Error("invalid first-frame credential was not rejected"));
        return;
      }
      resolveFrames(frames);
    });
    socket.addEventListener("error", () => {
      // The close code is the authoritative assertion.
    });
  });
}

async function collectOperationalSample(config, samples) {
  const metrics = await Promise.all(
    config.replicaUrls.map(async (origin) => {
      const response = await fetch(new URL("/metrics", origin), {
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error("application metrics endpoint is unavailable");
      return parsePrometheus(await response.text());
    }),
  );
  if (
    metrics.some(
      (sample) =>
        !(sample.helix_process_resident_memory_bytes > 0) ||
        !Number.isFinite(sample.helix_nodejs_eventloop_lag_max_seconds),
    )
  ) {
    throw new Error("application metrics omitted process memory or event-loop lag");
  }
  samples.memorySamples.push(
    sum(metrics.map((sample) => sample.helix_process_resident_memory_bytes ?? 0)),
  );
  samples.eventLoopSamples.push(
    1_000 *
      Math.max(...metrics.map((sample) => sample.helix_nodejs_eventloop_lag_max_seconds ?? 0), 0),
  );
  const probe = JSON.parse(
    await runProtectedCommand(config.metrics.backlogProbeCommand, "Chat backlog metrics probe"),
  );
  for (const field of ["dbPoolPending", "redisBacklog", "natsBacklog"]) {
    if (typeof probe[field] !== "number" || !Number.isFinite(probe[field]) || probe[field] < 0) {
      throw new Error(`backlog probe omitted ${field}`);
    }
  }
  samples.dbPoolSamples.push(probe.dbPoolPending);
  samples.redisSamples.push(probe.redisBacklog);
  samples.natsSamples.push(probe.natsBacklog);
}

function parsePrometheus(text) {
  const values = {};
  for (const line of text.split(/\r?\n/u)) {
    if (line.length === 0 || line.startsWith("#")) continue;
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{[^}]*\})?\s+([-+eE0-9.]+)$/u.exec(line);
    if (match === null) continue;
    const value = Number(match[2]);
    if (Number.isFinite(value)) {
      values[match[1]] = (values[match[1]] ?? 0) + value;
    }
  }
  return values;
}

async function runProtectedCommand(command, label) {
  const [executable, ...args] = command;
  try {
    const { stdout } = await execFileAsync(executable, args, {
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
      env: process.env,
    });
    return stdout;
  } catch (error) {
    throw new Error(`${label} failed (${errorName(error)})`);
  }
}

async function waitForReadyz(origin) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL("/readyz", origin), {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
    } catch {
      // A dependency or application restart is expected to create a gap.
    }
    await delay(250);
  }
  throw new Error("application did not become ready after restart");
}

async function validateConfig(raw, baseDirectory) {
  requireObject(raw, "runner config");
  const replicaUrls = requireArray(raw.replicaUrls, "replicaUrls").map((value, index) =>
    validatedHttpsOrigin(value, `replicaUrls[${index}]`),
  );
  if (replicaUrls.length !== 2 || replicaUrls[0].origin === replicaUrls[1].origin) {
    throw new Error("replicaUrls must contain exactly two distinct HTTPS origins");
  }
  requireUuid(raw.roomId, "roomId");
  requireObject(raw.actors, "actors");
  requireObject(raw.drive, "drive");
  requireArray(raw.replicaIdentityCommands, "replicaIdentityCommands");
  requireObject(raw.restartHooks, "restartHooks");
  requireObject(raw.logProbe, "logProbe");
  requireObject(raw.metrics, "metrics");
  requireObject(raw.load, "load");

  const actors = {};
  for (const name of ["sender", "receiver", "nonMember"]) {
    actors[name] = await protectedFile(raw.actors[name], baseDirectory, `actors.${name}`);
  }
  const restartHooks = {};
  for (const name of ["app", "redis", "nats"]) {
    restartHooks[name] = commandArray(raw.restartHooks[name], `restartHooks.${name}`);
  }
  const replicaIdentityCommands = raw.replicaIdentityCommands.map((command, index) =>
    commandArray(command, `replicaIdentityCommands[${index}]`),
  );
  if (replicaIdentityCommands.length !== 2) {
    throw new Error("replicaIdentityCommands must contain exactly two probes");
  }
  const userStorageStates = requireArray(raw.load.userStorageStates, "load.userStorageStates");
  const protectedUserStorageStates = await Promise.all(
    userStorageStates.map((value, index) =>
      protectedFile(value, baseDirectory, `load.userStorageStates[${index}]`),
    ),
  );
  const profile = profileFromConfig(raw.load);
  if (new Set(protectedUserStorageStates).size < profile.users) {
    throw new Error("load requires one distinct protected browser state file per user");
  }
  if (protectedUserStorageStates.length < profile.users) {
    throw new Error("load.userStorageStates has fewer entries than the configured users");
  }

  return {
    replicaUrls,
    roomId: raw.roomId,
    actors,
    replicaIdentityCommands,
    drive: {
      cleanObjectId: requireUuid(raw.drive.cleanObjectId, "drive.cleanObjectId"),
      eicarObjectId: requireUuid(raw.drive.eicarObjectId, "drive.eicarObjectId"),
    },
    restartHooks,
    logProbe: {
      command: commandArray(raw.logProbe.command, "logProbe.command"),
      delayMs: boundedInteger(raw.logProbe.delayMs ?? 1_000, "logProbe.delayMs", 0, 30_000),
    },
    metrics: {
      backlogProbeCommand: commandArray(
        raw.metrics.backlogProbeCommand,
        "metrics.backlogProbeCommand",
      ),
    },
    load: {
      profile,
      userStorageStates: protectedUserStorageStates,
      sampleIntervalMs: boundedInteger(
        raw.load.sampleIntervalMs ?? 5_000,
        "load.sampleIntervalMs",
        1_000,
        60_000,
      ),
      deliveryDrainMs: boundedInteger(
        raw.load.deliveryDrainMs ?? 30_000,
        "load.deliveryDrainMs",
        1_000,
        120_000,
      ),
    },
  };
}

function profileFromConfig(load) {
  const defaults = createChatEvidenceSkeleton().profile;
  const thresholds = { ...defaults.thresholds, ...(load.thresholds ?? {}) };
  const profile = {
    users: boundedInteger(load.users ?? defaults.users, "load.users", 2, 500),
    sockets: boundedInteger(load.sockets ?? defaults.sockets, "load.sockets", 2, 2_000),
    durationSeconds: boundedInteger(
      load.durationSeconds ?? defaults.durationSeconds,
      "load.durationSeconds",
      10,
      86_400,
    ),
    steadyMessagesPerSecond: boundedNumber(
      load.steadyMessagesPerSecond ?? defaults.steadyMessagesPerSecond,
      "load.steadyMessagesPerSecond",
      0.01,
      1_000,
    ),
    burstMessages: boundedInteger(
      load.burstMessages ?? defaults.burstMessages,
      "load.burstMessages",
      1,
      10_000,
    ),
    burstIntervalSeconds: boundedInteger(
      load.burstIntervalSeconds ?? defaults.burstIntervalSeconds,
      "load.burstIntervalSeconds",
      1,
      3_600,
    ),
    thresholds: {
      p95LatencyMs: boundedNumber(thresholds.p95LatencyMs, "thresholds.p95LatencyMs", 1, 60_000),
      p99LatencyMs: boundedNumber(thresholds.p99LatencyMs, "thresholds.p99LatencyMs", 1, 60_000),
      maxErrorRate: boundedNumber(thresholds.maxErrorRate, "thresholds.maxErrorRate", 0, 1),
      maxMemoryGrowthBytes: boundedNumber(
        thresholds.maxMemoryGrowthBytes,
        "thresholds.maxMemoryGrowthBytes",
        0,
        Number.MAX_SAFE_INTEGER,
      ),
      maxEventLoopLagMs: boundedNumber(
        thresholds.maxEventLoopLagMs,
        "thresholds.maxEventLoopLagMs",
        0,
        60_000,
      ),
      maxDbPoolPending: boundedNumber(
        thresholds.maxDbPoolPending,
        "thresholds.maxDbPoolPending",
        0,
        100_000,
      ),
      maxRedisBacklog: boundedNumber(
        thresholds.maxRedisBacklog,
        "thresholds.maxRedisBacklog",
        0,
        Number.MAX_SAFE_INTEGER,
      ),
      maxNatsBacklog: boundedNumber(
        thresholds.maxNatsBacklog,
        "thresholds.maxNatsBacklog",
        0,
        Number.MAX_SAFE_INTEGER,
      ),
    },
  };
  if (profile.sockets < profile.users) {
    throw new Error("load.sockets must be at least load.users");
  }
  if (profile.thresholds.p99LatencyMs < profile.thresholds.p95LatencyMs) {
    throw new Error("p99 threshold cannot be lower than p95 threshold");
  }
  return profile;
}

function failedSetupEvidence(reason, existing = createChatEvidenceSkeleton()) {
  existing.mode = "live";
  existing.status = "failed";
  for (const name of CHAT_LIVE_SCENARIOS) {
    existing.scenarios[name] = { status: "failed", reason };
  }
  return existing;
}

function deriveStatus(scenarios) {
  const statuses = Object.values(scenarios).map((scenario) => scenario.status);
  if (statuses.every((status) => status === "passed")) return "passed";
  if (statuses.some((status) => status === "failed")) return "failed";
  return "not_run";
}

function parseArgs(args) {
  const options = {
    config: undefined,
    validate: undefined,
    output: undefined,
    requirePass: false,
    requireReleaseLoad: false,
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--require-pass") {
      options.requirePass = true;
      continue;
    }
    if (argument === "--require-release-load") {
      options.requireReleaseLoad = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    index += 1;
    if (argument === "--config") options.config = resolve(value);
    else if (argument === "--validate") options.validate = resolve(value);
    else if (argument === "--output") options.output = resolve(value);
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (options.config !== undefined && options.validate !== undefined) {
    throw new Error("--config and --validate are mutually exclusive");
  }
  return options;
}

function usage() {
  return `Usage: node infra/scripts/chat-live-evidence-smoke.mjs [options]

Without --config or --validate, emits an explicit not_run report.

Options:
  --config <protected-json>  Execute live C6 and Chat V3 scenarios.
  --validate <report-json>   Validate an existing report without running.
  --output <report-json>     Write the report with owner-only permissions.
  --require-pass             Exit nonzero unless every C6/V3 scenario passed.
  --require-release-load     Also require >=50 users, >=100 sockets, >=30 minutes,
                             p95 <=2 seconds, and declared p99/memory/backlog limits.
  --help                     Show this help.
`;
}

async function protectedFile(value, baseDirectory, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a protected file path`);
  }
  const path = resolve(baseDirectory, value);
  const details = await stat(path);
  if (!details.isFile()) throw new Error(`${label} must reference a file`);
  if ((details.mode & 0o077) !== 0) {
    throw new Error(`${label} must not be group/world accessible`);
  }
  await access(path, fsConstants.R_OK);
  return path;
}

function commandArray(value, label) {
  const command = requireArray(value, label);
  if (
    command.length === 0 ||
    command.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    throw new Error(`${label} must be a non-empty argv array`);
  }
  return [...command];
}

function validatedHttpsOrigin(value, label) {
  if (typeof value !== "string") throw new Error(`${label} must be an HTTPS origin`);
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(`${label} must be a credential-free HTTPS origin`);
  }
  return new URL(url.origin);
}

function websocketUrl(origin) {
  const url = new URL("/ws/chat", origin);
  url.protocol = "wss:";
  return url;
}

function requireStatus(result, allowed, label) {
  if (!allowed.includes(result.status)) {
    throw new Error(`${label} returned an unexpected HTTP status`);
  }
}

function requireUuid(value, label) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error(`${label} must be a UUID`);
  }
  return value;
}

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function boundedInteger(value, label, minimum, maximum) {
  const number = boundedNumber(value, label, minimum, maximum);
  if (!Number.isSafeInteger(number)) throw new Error(`${label} must be a safe integer`);
  return number;
}

function boundedNumber(value, label, minimum, maximum) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function percentile(sorted, quantile) {
  if (sorted.length === 0) return Number.POSITIVE_INFINITY;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

function distribute(total, buckets) {
  return Array.from(
    { length: buckets },
    (_, index) => Math.floor(total / buckets) + (index < total % buckets ? 1 : 0),
  );
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function stringContains(value, marker) {
  return typeof value === "string" && value.includes(marker);
}

function errorName(error) {
  return error instanceof Error && /^[A-Za-z][A-Za-z0-9]*$/u.test(error.name)
    ? error.name
    : "Error";
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function writeFilePrivate(path, content) {
  await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

async function closeAll(resources) {
  await Promise.allSettled(
    resources
      .filter((resource) => resource !== undefined)
      .map(async (resource) => {
        if ("page" in resource && resource.page !== undefined) {
          await resource.page
            .evaluate(() => {
              window.__helixChatEvidence.stopped = true;
              for (const socket of window.__helixChatEvidence.sockets) socket?.close();
            })
            .catch(() => undefined);
          await resource.context.close();
        } else if (typeof resource.close === "function") {
          await resource.close();
        }
      }),
  );
}

function isMain() {
  return (
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  );
}
