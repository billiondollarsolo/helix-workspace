/**
 * Real SMTP send -> receive integration test (P1-1).
 *
 * The PRD's mail "E2E" task (308) was previously satisfied only by store-backed
 * integration tests with in-memory fakes — it never exercised a real SMTP
 * exchange. This spec closes that gap.
 *
 * WHAT IT DOES
 *  1. Opens a raw TCP socket to the Mailpit SMTP listener (docker-compose
 *     `mailpit` service, SMTP on port 1025) and performs a complete real SMTP
 *     conversation: EHLO / MAIL FROM / RCPT TO / DATA / message / QUIT.
 *  2. Polls Mailpit's HTTP API (port 8025) until the message is received,
 *     proving a genuine send -> receive round-trip against a real SMTP server.
 *
 * It deliberately uses only Node's built-in `net` module so it needs no extra
 * dependency in `apps/web` — the SMTP protocol is spoken directly.
 *
 * WHERE IT RUNS
 *  - Skipped by default (no Mailpit reachable in a bare checkout).
 *  - In CI it is enabled by `HELIX_E2E_BACKEND=live`, where the `e2e` job
 *    (.github/workflows/e2e.yml) has brought Mailpit up via docker-compose.
 *  - Mailpit endpoints are overridable with `HELIX_E2E_MAILPIT_SMTP_HOST/PORT`
 *    and `HELIX_E2E_MAILPIT_API_BASE_URL`.
 */
import net from "node:net";
import { expect, test } from "@playwright/test";
import { isLiveBackend } from "./support/backend-mode";

const mailpitSmtpHost = process.env.HELIX_E2E_MAILPIT_SMTP_HOST ?? "127.0.0.1";
const mailpitSmtpPort = Number(process.env.HELIX_E2E_MAILPIT_SMTP_PORT ?? "28457");
const mailpitApiBaseUrl =
  process.env.HELIX_E2E_MAILPIT_API_BASE_URL ?? "http://127.0.0.1:28458";

interface MailpitMessageSummary {
  readonly ID: string;
  readonly Subject: string;
}

interface MailpitSearchResponse {
  readonly messages: readonly MailpitMessageSummary[];
}

test.describe("mail SMTP send -> receive", () => {
  test.skip(
    !isLiveBackend(),
    "Requires the docker-compose Mailpit service; enabled in CI with HELIX_E2E_BACKEND=live.",
  );

  test("delivers a message over real SMTP and reads it back from Mailpit", async () => {
    const marker = `helix-e2e-smtp-${Date.now()}`;
    const subject = `Helix E2E SMTP probe ${marker}`;
    const from = "helix-e2e@helix.local";
    const to = "inbox@helix.local";

    await sendSmtpMessage({
      host: mailpitSmtpHost,
      port: mailpitSmtpPort,
      from,
      to,
      subject,
      body: `This is a real SMTP send->receive integration probe. marker=${marker}`,
    });

    await expect
      .poll(async () => (await searchMailpit(marker)).messages.length, {
        message: "Mailpit should receive the SMTP message",
        timeout: 20_000,
        intervals: [500, 1000, 2000],
      })
      .toBeGreaterThan(0);

    const search = await searchMailpit(marker);
    expect(search.messages[0]?.Subject).toBe(subject);
  });
});

interface SmtpMessage {
  readonly host: string;
  readonly port: number;
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly body: string;
}

/**
 * Performs a full SMTP conversation over a raw TCP socket. Resolves once the
 * server has acknowledged the message (250 after the DATA terminator) and the
 * connection has been closed with QUIT.
 */
async function sendSmtpMessage(message: SmtpMessage): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host: message.host, port: message.port });
    socket.setEncoding("utf8");
    socket.setTimeout(15_000);

    const data = [
      `From: <${message.from}>`,
      `To: <${message.to}>`,
      `Subject: ${message.subject}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      message.body,
      ".",
    ].join("\r\n");

    const steps: readonly { readonly send: string; readonly expect: string }[] = [
      { send: "EHLO helix-e2e.local", expect: "250" },
      { send: `MAIL FROM:<${message.from}>`, expect: "250" },
      { send: `RCPT TO:<${message.to}>`, expect: "250" },
      { send: "DATA", expect: "354" },
      { send: data, expect: "250" },
      { send: "QUIT", expect: "221" },
    ];

    let stepIndex = -1; // -1 = awaiting the server greeting
    let buffer = "";

    const fail = (error: Error) => {
      socket.destroy();
      reject(error);
    };

    socket.on("timeout", () => fail(new Error("SMTP socket timed out")));
    socket.on("error", fail);

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      // SMTP replies end with "<code><SP>...\r\n"; wait for a complete line.
      if (!buffer.endsWith("\r\n")) {
        return;
      }
      const reply = buffer;
      buffer = "";
      const code = reply.slice(0, 3);

      const expected = stepIndex < 0 ? "220" : steps[stepIndex]?.expect;
      if (expected !== undefined && !code.startsWith(expected)) {
        fail(new Error(`Unexpected SMTP reply (wanted ${expected}): ${reply.trim()}`));
        return;
      }

      stepIndex += 1;
      const next = steps[stepIndex];
      if (next === undefined) {
        socket.end();
        resolve();
        return;
      }
      socket.write(`${next.send}\r\n`);
    });
  });
}

async function searchMailpit(query: string): Promise<MailpitSearchResponse> {
  const url = new URL("/api/v1/search", mailpitApiBaseUrl);
  url.searchParams.set("query", query);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Mailpit search failed with ${String(response.status)}`);
  }
  const payload = (await response.json()) as Partial<MailpitSearchResponse>;
  return { messages: payload.messages ?? [] };
}
