#!/usr/bin/env node
// Prove that two people can hold a meeting on a Meet install.
//
//   node infra/scripts/meet-media-probe.mjs --join-url <url> --join-url <url> \
//     [--forged-url <url>] [--map <host:port=address:port>]... [--insecure]
//
// Each --join-url is a meeting link minted by Helix (`meet.mint-token`) for the
// same room. The probe opens them in two headless browsers with synthetic
// camera and microphone, waits for both to be in the conference, and passes
// only when each browser is receiving the other's audio and video over an
// encrypted connection to the media bridge. With --forged-url it also checks
// that a link whose pass was not signed by Helix is turned away.
//
// --map and --insecure exist for test stacks that are not in DNS and serve a
// private certificate; a real deployment needs neither. Requires Playwright's
// Chromium (`pnpm --filter @helix/web exec playwright install chromium`).

import { createRequire } from "node:module";
import process from "node:process";
import { parseArgs } from "node:util";

const require = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const { chromium } = require("@playwright/test");

const { values } = parseArgs({
  options: {
    "join-url": { type: "string", multiple: true },
    "forged-url": { type: "string" },
    map: { type: "string", multiple: true },
    insecure: { type: "boolean" },
    "timeout-seconds": { type: "string" },
  },
  strict: true,
});
const joinUrls = values["join-url"] ?? [];
if (joinUrls.length !== 2) {
  console.error(
    "Usage: meet-media-probe.mjs --join-url <url> --join-url <url> [--forged-url <url>]",
  );
  process.exit(2);
}
const timeoutMs = Number(values["timeout-seconds"] ?? "90") * 1000;
const resolverRules = (values.map ?? []).map((rule) => {
  const [from, to] = rule.split("=");
  return `MAP ${from} ${to}`;
});

const browser = await chromium.launch({
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    ...(resolverRules.length === 0 ? [] : [`--host-resolver-rules=${resolverRules.join(", ")}`]),
  ],
});

/** What the page's conference knows about itself, read from the Jitsi app. */
function conferenceState() {
  const conference = globalThis.APP?.conference;
  const room = conference?._room;
  if (room === undefined || room === null) return { joined: false };
  const stats = {};
  for (const [id, value] of Object.entries(room.connectionQuality?._remoteStats ?? {})) {
    stats[id] = value;
  }
  return {
    joined: conference.isJoined?.() === true,
    participants: room.getParticipants?.().length ?? 0,
    remoteTracks: (room.getParticipants?.() ?? []).flatMap((participant) =>
      participant.getTracks().map((track) => track.getType()),
    ),
  };
}

/** Inbound media counters from the browser's own peer connections. */
async function inboundMedia() {
  const connections = globalThis.APP?.conference?._room?.rtc?.peerConnections;
  const totals = { audioBytes: 0, videoBytes: 0, dtls: [], candidateTypes: [] };
  if (connections === undefined) return totals;
  for (const connection of connections.values()) {
    const report = await connection.peerconnection.getStats();
    report.forEach((entry) => {
      if (entry.type === "inbound-rtp" && entry.kind === "audio")
        totals.audioBytes += entry.bytesReceived;
      if (entry.type === "inbound-rtp" && entry.kind === "video")
        totals.videoBytes += entry.bytesReceived;
      if (entry.type === "transport" && entry.dtlsState) totals.dtls.push(entry.dtlsState);
      if (entry.type === "candidate-pair" && entry.nominated) {
        const remote = report.get(entry.remoteCandidateId);
        if (remote) totals.candidateTypes.push(`${remote.candidateType}/${remote.protocol}`);
      }
    });
  }
  return totals;
}

async function join(url, label) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: values.insecure === true,
    permissions: ["camera", "microphone"],
  });
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (error) => problems.push(error.message));
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  // A pre-join screen appears on some configurations; go straight in.
  const prejoin = page.locator('[data-testid="prejoin.joinMeeting"]');
  await prejoin.click({ timeout: 8000 }).catch(() => undefined);
  return { page, label, problems };
}

async function waitFor(description, check) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last.ok) return last;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${description} (last seen: ${JSON.stringify(last?.seen)})`);
}

let failures = 0;
const pass = (message) => console.log(`PASS  ${message}`);
const fail = (message) => {
  console.log(`FAIL  ${message}`);
  failures += 1;
};

try {
  const people = [await join(joinUrls[0], "first"), await join(joinUrls[1], "second")];
  try {
    for (const person of people) {
      await waitFor(`${person.label} person joins the meeting`, async () => {
        const seen = await person.page
          .evaluate(conferenceState)
          .catch((error) => ({ error: String(error) }));
        return { ok: seen.joined === true && seen.participants >= 1, seen };
      });
    }
    pass("two people join the same meeting with passes signed by Helix");
    for (const person of people) {
      const media = await waitFor(
        `${person.label} person receives the other's audio and video`,
        async () => {
          const seen = await person.page
            .evaluate(inboundMedia)
            .catch((error) => ({ error: String(error) }));
          return { ok: seen.audioBytes > 0 && seen.videoBytes > 20000, seen };
        },
      );
      pass(
        `${person.label} person receives audio and video (${String(media.seen.videoBytes)} video bytes, via ${media.seen.candidateTypes.join(" ") || "unknown"})`,
      );
      if (media.seen.dtls.length > 0 && media.seen.dtls.every((state) => state === "connected")) {
        pass(`${person.label} person's media is encrypted (DTLS-SRTP connected)`);
      } else {
        fail(
          `${person.label} person's media is encrypted (DTLS states: ${media.seen.dtls.join(",")})`,
        );
      }
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    for (const person of people) {
      if (person.problems.length > 0)
        console.log(
          `      ${person.label} page errors: ${person.problems.slice(0, 3).join(" | ")}`,
        );
    }
  }

  if (values["forged-url"] !== undefined) {
    const intruder = await join(values["forged-url"], "forged");
    await new Promise((resolve) => setTimeout(resolve, 15000));
    const seen = await intruder.page.evaluate(conferenceState).catch(() => ({ joined: false }));
    if (seen.joined === true) fail("a pass that Helix did not sign is turned away");
    else pass("a pass that Helix did not sign is turned away");
  }
} finally {
  await browser.close();
}
process.exit(failures === 0 ? 0 : 1);
