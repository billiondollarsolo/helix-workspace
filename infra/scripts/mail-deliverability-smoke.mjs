#!/usr/bin/env node
import net from "node:net";
import tls from "node:tls";
import { writeFile } from "node:fs/promises";

const usage = `Usage: infra/scripts/mail-deliverability-smoke.mjs [--static]

Opt-in live outbound mail deliverability proof. The script sends a unique
message through the live Helix mail.send backend, approves the pending action,
then polls an external IMAP mailbox for the marker.

Environment:
  HELIX_BASE_URL                         Default: http://127.0.0.1:28431
  AUTH_TOKEN                             Optional bearer token. If absent, OAuth is used.
  HELIX_SMOKE_CLIENT_ID                  OAuth client id when AUTH_TOKEN is absent
  HELIX_SMOKE_CLIENT_SECRET              OAuth client secret when AUTH_TOKEN is absent
  HELIX_SMOKE_SCOPE                      Default: platform.read mail.read mail.send
  HELIX_DELIVERABILITY_RECIPIENT         Required external recipient address
  HELIX_DELIVERABILITY_IMAP_HOST         Required IMAP host for recipient mailbox
  HELIX_DELIVERABILITY_IMAP_PORT         Default: 993
  HELIX_DELIVERABILITY_IMAP_SECURE       Default: true
  HELIX_DELIVERABILITY_IMAP_USER         Required IMAP username
  HELIX_DELIVERABILITY_IMAP_PASSWORD     Required IMAP password/app password
  HELIX_DELIVERABILITY_IMAP_MAILBOX      Default: INBOX
  HELIX_DELIVERABILITY_TIMEOUT_MS        Default: 30000
  HELIX_DELIVERABILITY_THRESHOLD_MS      Default: 30000
  HELIX_DELIVERABILITY_OUTPUT            Optional JSON evidence output path
`;

const staticOnly = process.argv.includes("--static");
if (process.argv.includes("-h") || process.argv.includes("--help")) {
  process.stdout.write(usage);
  process.exit(0);
}
if (staticOnly) {
  validateStaticEnvironmentNames();
  process.stdout.write("mail deliverability smoke static validation complete\n");
  process.exit(0);
}

const startedAt = Date.now();
const baseUrl = env("HELIX_BASE_URL", "http://127.0.0.1:28431");
const timeoutMs = positiveIntEnv("HELIX_DELIVERABILITY_TIMEOUT_MS", 30_000);
const thresholdMs = positiveIntEnv("HELIX_DELIVERABILITY_THRESHOLD_MS", 30_000);
const recipient = requiredEnv("HELIX_DELIVERABILITY_RECIPIENT");
const imapConfig = {
  host: requiredEnv("HELIX_DELIVERABILITY_IMAP_HOST"),
  port: positiveIntEnv("HELIX_DELIVERABILITY_IMAP_PORT", 993),
  secure: booleanEnv("HELIX_DELIVERABILITY_IMAP_SECURE", true),
  user: requiredEnv("HELIX_DELIVERABILITY_IMAP_USER"),
  password: requiredEnv("HELIX_DELIVERABILITY_IMAP_PASSWORD"),
  mailbox: env("HELIX_DELIVERABILITY_IMAP_MAILBOX", "INBOX"),
};
const marker = `helix-deliverability-${new Date().toISOString().replaceAll(/[-:.]/gu, "")}-${Math.random()
  .toString(36)
  .slice(2, 10)}`;
const subject = `Helix deliverability smoke ${marker}`;
const token = await getAccessToken(baseUrl);

const pendingId = await queueMail(baseUrl, token, {
  to: [recipient],
  subject,
  bodyText: [
    "Helix deliverability smoke.",
    "",
    `Marker: ${marker}`,
    `Queued at: ${new Date(startedAt).toISOString()}`,
  ].join("\n"),
  undoWindowMs: 0,
});
const approvalOutput = await approvePending(baseUrl, token, pendingId);
const outboundId = approvalOutput?.id;
if (typeof outboundId !== "string" || outboundId.length === 0) {
  throw new Error(`pending approve output did not include outbound id: ${JSON.stringify(approvalOutput)}`);
}
const outbound = await waitForOutboundSent(baseUrl, token, outboundId, timeoutMs);

const delivered = await waitForImapMarker(imapConfig, marker, timeoutMs);
const completedAt = Date.now();
const latencyMs = completedAt - startedAt;
const evidence = {
  status: latencyMs <= thresholdMs ? "passed" : "threshold_exceeded",
  baseUrl,
  recipient,
  imapHost: imapConfig.host,
  imapMailbox: imapConfig.mailbox,
  marker,
  subject,
  pendingId,
  outbound,
  delivered,
  latencyMs,
  thresholdMs,
  startedAt: new Date(startedAt).toISOString(),
  completedAt: new Date(completedAt).toISOString(),
};

const outputPath = process.env.HELIX_DELIVERABILITY_OUTPUT;
if (outputPath !== undefined && outputPath.length > 0) {
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
if (evidence.status !== "passed") {
  process.exit(1);
}

async function getAccessToken(apiBaseUrl) {
  const provided = process.env.AUTH_TOKEN;
  if (provided !== undefined && provided.length > 0) {
    return provided;
  }

  const clientId = requiredEnv("HELIX_SMOKE_CLIENT_ID");
  const clientSecret = requiredEnv("HELIX_SMOKE_CLIENT_SECRET");
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: env("HELIX_SMOKE_SCOPE", "platform.read mail.read mail.send"),
  });
  const response = await fetch(new URL("/oauth/token", apiBaseUrl), {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const parsed = await readJsonResponse(response, "OAuth token mint");
  if (typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
    throw new Error("OAuth token response did not include access_token");
  }
  return parsed.access_token;
}

async function queueMail(apiBaseUrl, accessToken, body) {
  const response = await fetch(new URL("/api/tools/mail.send", apiBaseUrl), {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const parsed = await readJsonResponse(response, "mail.send");
  const pendingId = parsed.pending?.id;
  if (response.status !== 202 || typeof pendingId !== "string" || pendingId.length === 0) {
    throw new Error(`mail.send did not return HTTP 202 with pending.id: ${JSON.stringify(parsed)}`);
  }
  return pendingId;
}

async function approvePending(apiBaseUrl, accessToken, pendingId) {
  const response = await fetch(new URL(`/api/tools/pending/${encodeURIComponent(pendingId)}/approve`, apiBaseUrl), {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: "{}",
  });
  const parsed = await readJsonResponse(response, "pending approve");
  if (response.status !== 200 || parsed.status !== "executed") {
    throw new Error(`pending approve did not execute: ${JSON.stringify(parsed)}`);
  }
  return parsed.output;
}

async function waitForOutboundSent(apiBaseUrl, accessToken, outboundId, timeoutMsValue) {
  const deadline = Date.now() + timeoutMsValue;
  let lastSeen = null;
  while (Date.now() < deadline) {
    const outbound = await getOutbound(apiBaseUrl, accessToken, outboundId);
    if (outbound?.status === "sent") {
      return {
        id: outbound.id,
        messageId: outbound.messageId,
        threadId: outbound.threadId,
        status: outbound.status,
        providerMessageId: outbound.providerMessageId ?? null,
        deliveryMetadata: outbound.deliveryMetadata ?? {},
        sentAt: outbound.sentAt ?? null,
      };
    }
    lastSeen = outbound;
    await sleep(1_000);
  }
  throw new Error(`Timed out waiting for outbound ${outboundId} to be sent. Last seen: ${JSON.stringify(lastSeen)}`);
}

async function getOutbound(apiBaseUrl, accessToken, outboundId) {
  const response = await fetch(new URL("/api/tools/mail.outbound.get", apiBaseUrl), {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ id: outboundId }),
  });
  const parsed = await readJsonResponse(response, "mail.outbound.get");
  if (response.status !== 200) {
    throw new Error(`mail.outbound.get returned HTTP ${response.status}: ${JSON.stringify(parsed)}`);
  }
  return parsed.output?.outbound ?? null;
}

async function waitForImapMarker(config, searchText, timeoutMsValue) {
  const deadline = Date.now() + timeoutMsValue;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await searchImapMailbox(config, searchText);
      if (result.found) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(2_000);
  }
  const suffix = lastError instanceof Error ? ` Last IMAP error: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for external mailbox marker ${searchText}.${suffix}`);
}

async function searchImapMailbox(config, searchText) {
  const client = await ImapClient.connect(config);
  try {
    await client.login(config.user, config.password);
    await client.select(config.mailbox);
    const ids = await client.uidSearchText(searchText);
    await client.logout();
    return { found: ids.length > 0, uidCount: ids.length, latestUid: ids.at(-1) ?? null };
  } finally {
    client.close();
  }
}

class ImapClient {
  constructor(socket) {
    this.socket = socket;
    this.buffer = "";
    this.tag = 0;
  }

  static connect(config) {
    return new Promise((resolve, reject) => {
      const socket = config.secure
        ? tls.connect({ host: config.host, port: config.port, servername: config.host })
        : net.createConnection({ host: config.host, port: config.port });
      const client = new ImapClient(socket);
      socket.setTimeout(10_000);
      socket.once("error", reject);
      socket.once("timeout", () => reject(new Error("IMAP connection timed out")));
      client
        .readUntilGreeting()
        .then(() => {
          socket.removeListener("error", reject);
          resolve(client);
        })
        .catch(reject);
    });
  }

  readUntilGreeting() {
    return this.readUntil((line) => line.startsWith("* OK"));
  }

  async login(user, password) {
    await this.command(`LOGIN ${quoteImap(user)} ${quoteImap(password)}`);
  }

  async select(mailbox) {
    await this.command(`SELECT ${quoteMailbox(mailbox)}`);
  }

  async uidSearchText(text) {
    const lines = await this.command(`UID SEARCH TEXT ${quoteImap(text)}`);
    const searchLine = lines.find((line) => line.startsWith("* SEARCH"));
    if (searchLine === undefined) {
      return [];
    }
    return searchLine
      .slice("* SEARCH".length)
      .trim()
      .split(/\s+/u)
      .filter((value) => /^[0-9]+$/u.test(value))
      .map(Number);
  }

  async logout() {
    try {
      await this.command("LOGOUT");
    } catch {}
  }

  close() {
    this.socket.destroy();
  }

  command(commandText) {
    const tag = `A${String(++this.tag).padStart(4, "0")}`;
    this.socket.write(`${tag} ${commandText}\r\n`);
    return this.readUntil((line) => line.startsWith(`${tag} OK`), (line) => line.startsWith(`${tag} NO`) || line.startsWith(`${tag} BAD`));
  }

  readUntil(done, failed = () => false) {
    return new Promise((resolve, reject) => {
      const lines = [];
      const cleanup = () => {
        this.socket.off("data", onData);
        this.socket.off("error", onError);
        this.socket.off("timeout", onTimeout);
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      const onTimeout = () => {
        cleanup();
        reject(new Error("IMAP command timed out"));
      };
      const onData = (chunk) => {
        this.buffer += chunk.toString("utf8");
        let index;
        while ((index = this.buffer.indexOf("\n")) >= 0) {
          const raw = this.buffer.slice(0, index + 1);
          this.buffer = this.buffer.slice(index + 1);
          const line = raw.trimEnd();
          lines.push(line);
          if (failed(line)) {
            cleanup();
            reject(new Error(`IMAP command failed: ${line}`));
            return;
          }
          if (done(line)) {
            cleanup();
            resolve(lines);
            return;
          }
        }
      };
      this.socket.on("data", onData);
      this.socket.on("error", onError);
      this.socket.on("timeout", onTimeout);
    });
  }
}

async function readJsonResponse(response, label) {
  const text = await response.text();
  let parsed;
  try {
    parsed = text.length === 0 ? {} : JSON.parse(text);
  } catch {
    throw new Error(`${label} returned non-JSON HTTP ${response.status}: ${redact(text)}`);
  }
  if (!response.ok && response.status !== 202) {
    throw new Error(`${label} returned HTTP ${response.status}: ${redact(JSON.stringify(parsed))}`);
  }
  return parsed;
}

function quoteImap(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function quoteMailbox(value) {
  return String(value).includes(" ") ? quoteImap(value) : String(value);
}

function requiredEnv(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function env(name, fallback) {
  const value = process.env[name];
  return value === undefined || value.length === 0 ? fallback : value;
}

function positiveIntEnv(name, fallback) {
  const value = env(name, String(fallback));
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function booleanEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    return fallback;
  }
  if (/^(1|true|yes)$/iu.test(value)) return true;
  if (/^(0|false|no)$/iu.test(value)) return false;
  throw new Error(`${name} must be true or false`);
}

function redact(value) {
  let output = value;
  for (const secret of [
    process.env.HELIX_SMOKE_CLIENT_SECRET,
    process.env.HELIX_DELIVERABILITY_IMAP_PASSWORD,
    process.env.AUTH_TOKEN,
  ]) {
    if (secret !== undefined && secret.length > 0) {
      output = output.replaceAll(secret, "[redacted]");
    }
  }
  return output;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validateStaticEnvironmentNames() {
  for (const name of [
    "HELIX_BASE_URL",
    "AUTH_TOKEN",
    "HELIX_SMOKE_CLIENT_ID",
    "HELIX_SMOKE_CLIENT_SECRET",
    "HELIX_SMOKE_SCOPE",
    "HELIX_DELIVERABILITY_RECIPIENT",
    "HELIX_DELIVERABILITY_IMAP_HOST",
    "HELIX_DELIVERABILITY_IMAP_PORT",
    "HELIX_DELIVERABILITY_IMAP_SECURE",
    "HELIX_DELIVERABILITY_IMAP_USER",
    "HELIX_DELIVERABILITY_IMAP_PASSWORD",
    "HELIX_DELIVERABILITY_IMAP_MAILBOX",
    "HELIX_DELIVERABILITY_TIMEOUT_MS",
    "HELIX_DELIVERABILITY_THRESHOLD_MS",
    "HELIX_DELIVERABILITY_OUTPUT",
  ]) {
    if (!/^[A-Z][A-Z0-9_]*$/u.test(name)) {
      throw new Error(`invalid env name in script contract: ${name}`);
    }
  }
}
