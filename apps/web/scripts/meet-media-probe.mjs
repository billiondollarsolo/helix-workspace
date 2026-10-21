#!/usr/bin/env node
// Prove that two people can hold a meeting on a Meet install (LiveKit).
//
//   node apps/web/scripts/meet-media-probe.mjs --server-url <wss://host> \
//     --token <token> --token <token> [--forged-token <token>] \
//     [--map <host:port=address:port>]... [--insecure] [--timeout-seconds <n>]
//
// --server-url is the `serverUrl` from the join response and each --token a
// LiveKit access token minted by Helix (`meet.mint-token`) for the same room.
// The probe joins with both in two headless browsers with synthetic camera and
// microphone and passes only when each browser receives the other's audio and
// video over an encrypted (DTLS-SRTP) connection. With --forged-token it also
// checks that a token Helix did not sign is turned away.
//
// --map and --insecure exist for test stacks that are not in DNS and serve a
// private certificate; a real deployment needs neither. Requires Playwright's
// Chromium (`pnpm --filter @helix/web exec playwright install chromium`).

import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";
import {
  instrumentPeerConnections,
  mediaStats,
  openLiveKitParticipant,
  roomState,
} from "./meet-livekit-harness.mjs";

const { values } = parseArgs({
  options: {
    "server-url": { type: "string" },
    token: { type: "string", multiple: true },
    "forged-token": { type: "string" },
    map: { type: "string", multiple: true },
    insecure: { type: "boolean" },
    "timeout-seconds": { type: "string" },
  },
  strict: true,
});
const serverUrl = values["server-url"];
const tokens = values.token ?? [];
if (serverUrl === undefined || tokens.length !== 2) {
  console.error(
    "Usage: meet-media-probe.mjs --server-url <wss://host> --token <token> --token <token> [--forged-token <token>]",
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

async function join(token, label) {
  const context = await browser.newContext({ ignoreHTTPSErrors: values.insecure === true });
  await instrumentPeerConnections(context);
  const person = await openLiveKitParticipant(context, { serverUrl, token, timeoutMs });
  return { ...person, label };
}

async function waitFor(description, check) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last.ok) return last;
    await sleep(1000);
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
  const people = [await join(tokens[0], "first"), await join(tokens[1], "second")];
  try {
    for (const person of people) {
      await waitFor(`${person.label} person joins the meeting`, async () => {
        const seen = await roomState(person.page).catch((error) => ({ error: String(error) }));
        return { ok: seen.connected === true && (seen.remotes?.length ?? 0) >= 1, seen };
      });
    }
    pass("two people join the same meeting with tokens signed by Helix");
    for (const person of people) {
      const media = await waitFor(
        `${person.label} person receives the other's audio and video`,
        async () => {
          const seen = await mediaStats(person.page).catch((error) => ({ error: String(error) }));
          return { ok: seen.inbound?.audio > 0 && seen.inbound?.video > 20000, seen };
        },
      );
      pass(
        `${person.label} person receives audio and video (${String(media.seen.inbound.video)} video bytes, via ${media.seen.candidateTypes.join(" ") || "unknown"})`,
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

  if (values["forged-token"] !== undefined) {
    const intruder = await join(values["forged-token"], "forged");
    const seen = await roomState(intruder.page).catch(() => ({ connected: false }));
    if (intruder.joined || seen.connected === true)
      fail("a token that Helix did not sign is turned away");
    else pass("a token that Helix did not sign is turned away");
  }
} finally {
  await browser.close();
}
process.exit(failures === 0 ? 0 : 1);
