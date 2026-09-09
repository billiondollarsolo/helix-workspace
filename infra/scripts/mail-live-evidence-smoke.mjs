#!/usr/bin/env node
/* global fetch */
import { Buffer } from "node:buffer";
import { createHash, createHmac, randomUUID } from "node:crypto";
import net from "node:net";
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { URL, pathToFileURL } from "node:url";
import {
  attachReleaseEvidenceBinding,
  releaseEvidenceBindingFromEnvironment,
  validateOptionalReleaseEvidenceBinding,
} from "./release-evidence-binding.mjs";

export const MAIL_LIVE_EVIDENCE_SCHEMA = "helix.mail-live-evidence.v1";
export const MAIL_LIVE_SCENARIOS = [
  "recipient_aware_routing",
  "clean_inbound",
  "spam_inbound",
  "eicar_quarantine",
  "outbound_mailpit",
  "provider_hard_bounce",
  "provider_complaint",
  "suppression",
  "deterministic_retry",
];
export const MAIL_EXTERNAL_TARGETS = ["provider_sandbox", "gmail", "microsoft365"];

// Stable operator-facing code that both the suppression and retry scenarios assert on.
const SUPPRESSION_CODE = "MAIL_RECIPIENT_SUPPRESSED";

const usage = `Usage: infra/scripts/mail-live-evidence-smoke.mjs [--static|--local|--validate <report.json>]

Dedicated opt-in M7 Mail evidence smoke. --static validates the evidence
contract and emits explicit not-run records. --local exercises the running
Helix SMTP/API, Mailpit, SpamAssassin/ClamAV policy, signed provider webhooks,
suppression, and explicit deterministic retry.

Required for --local:
  HELIX_MAIL_LIVE_ORG_A_TOKEN
  HELIX_MAIL_LIVE_ORG_B_TOKEN
  HELIX_MAIL_LIVE_ADMIN_TOKEN
  HELIX_MAIL_LIVE_ORG_A_RECIPIENT
  HELIX_MAIL_LIVE_ORG_B_RECIPIENT
  HELIX_MAIL_LIVE_OUTBOUND_RECIPIENT
  HELIX_MAIL_LIVE_BOUNCE_RECIPIENT
  HELIX_MAIL_LIVE_COMPLAINT_RECIPIENT
  HELIX_MAIL_LIVE_PROVIDER_ORG_ID
  HELIX_MAIL_LIVE_PROVIDER_ID
  HELIX_MAIL_LIVE_PROVIDER_WEBHOOK_SECRET

Optional:
  HELIX_BASE_URL                 Default: http://127.0.0.1:28431
  HELIX_MAIL_LIVE_SMTP_HOST      Default: 127.0.0.1
  HELIX_MAIL_LIVE_SMTP_PORT      Default: 28456
  HELIX_MAIL_LIVE_MAILPIT_URL    Default: http://127.0.0.1:28458
  HELIX_MAIL_LIVE_TIMEOUT_MS     Default: 30000
  HELIX_MAIL_LIVE_OUTPUT         JSON evidence output path

External Gmail, Microsoft 365, and provider-sandbox evidence is never inferred
from this local run. Use the existing deliverability smoke for approved
accounts, then attach its sanitized report to the release evidence bundle.
`;

export function createEvidenceSkeleton(now = new Date()) {
  return {
    schema: MAIL_LIVE_EVIDENCE_SCHEMA,
    runId: randomUUID(),
    mode: "static",
    status: "static_validated",
    startedAt: now.toISOString(),
    completedAt: now.toISOString(),
    local: Object.fromEntries(
      MAIL_LIVE_SCENARIOS.map((scenario) => [
        scenario,
        { status: "not_run", reason: "static validation only" },
      ]),
    ),
    external: Object.fromEntries(
      MAIL_EXTERNAL_TARGETS.map((target) => [
        target,
        {
          status: "not_run",
          reason: "requires an approved external test account and explicit opt-in run",
        },
      ]),
    ),
  };
}

export function validateMailLiveEvidence(evidence) {
  if (evidence?.schema !== MAIL_LIVE_EVIDENCE_SCHEMA) {
    throw new Error("invalid Mail live evidence schema");
  }
  validateOptionalReleaseEvidenceBinding(evidence.releaseBinding);
  for (const scenario of MAIL_LIVE_SCENARIOS) {
    const result = evidence.local?.[scenario];
    validateResult(result, `local.${scenario}`);
    if (result.status === "passed") validateLocalResult(scenario, result);
  }
  for (const target of MAIL_EXTERNAL_TARGETS) {
    const result = evidence.external?.[target];
    validateResult(result, `external.${target}`);
    if (result.status === "passed") validateExternalResult(target, result);
  }
  assertEvidenceContainsNoSecrets(evidence);
  return evidence;
}

export function assertEvidenceContainsNoSecrets(evidence) {
  const forbiddenKeys =
    /(?:authorization|body|credential|password|recipientAddress|secret|subject|token)$/iu;
  const visit = (value, path) => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${path}[${String(index)}]`));
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key, entry] of Object.entries(value)) {
      if (forbiddenKeys.test(key)) {
        throw new Error(`sensitive evidence field is forbidden: ${path}.${key}`);
      }
      visit(entry, `${path}.${key}`);
    }
  };
  visit(evidence, "$");
}

export function anonymizeIdentifier(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 20);
}

export function addressEvidence(address) {
  const value = String(address);
  const separator = value.lastIndexOf("@");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error("mail evidence address must contain a local part and domain");
  }
  return {
    domain: value.slice(separator + 1).toLowerCase(),
    addressHash: anonymizeIdentifier(value.toLowerCase()),
  };
}

async function main(argv = process.argv.slice(2)) {
  argv = argv.filter((argument) => argument !== "--");
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(usage);
    return;
  }
  const validateIndex = argv.indexOf("--validate");
  if (validateIndex >= 0) {
    if (argv.length !== 2 || validateIndex !== 0 || argv[1] === undefined) {
      throw new Error("--validate requires exactly one JSON report path");
    }
    const evidence = JSON.parse(await readFile(argv[1], "utf8"));
    validateMailLiveEvidence(evidence);
    process.stdout.write(
      `${JSON.stringify({ schema: MAIL_LIVE_EVIDENCE_SCHEMA, status: "validated" })}\n`,
    );
    return;
  }
  const unknown = argv.filter((arg) => arg !== "--static" && arg !== "--local");
  if (unknown.length > 0 || (argv.includes("--static") && argv.includes("--local"))) {
    throw new Error(`invalid arguments: ${unknown.join(", ")}`);
  }
  let evidence;
  const releaseBinding = releaseEvidenceBindingFromEnvironment(process.env);
  try {
    evidence = argv.includes("--static")
      ? createEvidenceSkeleton()
      : await runLocalEvidence(process.env);
  } catch (error) {
    evidence = createEvidenceSkeleton();
    evidence.mode = "local";
    evidence.status = "failed";
    evidence.completedAt = new Date().toISOString();
    evidence.failure = { code: "mail_live_smoke_failed" };
    for (const scenario of MAIL_LIVE_SCENARIOS) {
      evidence.local[scenario] = {
        status: "not_run",
        reason: "live run aborted before this scenario was evidenced",
      };
    }
    attachReleaseEvidenceBinding(evidence, releaseBinding);
    validateMailLiveEvidence(evidence);
    await emitEvidence(evidence);
    throw error;
  }
  attachReleaseEvidenceBinding(evidence, releaseBinding);
  validateMailLiveEvidence(evidence);
  await emitEvidence(evidence);
}

async function emitEvidence(evidence) {
  const outputPath = process.env.HELIX_MAIL_LIVE_OUTPUT;
  if (outputPath !== undefined && outputPath.length > 0) {
    await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

async function runLocalEvidence(environment) {
  const started = new Date();
  const config = localConfig(environment);
  const markerPrefix = `helix-mail-live-${started.toISOString().replaceAll(/[-:.]/gu, "")}-${randomUUID().slice(0, 8)}`;
  const evidence = createEvidenceSkeleton(started);
  evidence.mode = "local";
  evidence.status = "running";
  evidence.local = {};

  const cleanMarker = `${markerPrefix}-clean`;
  await sendPlainProbe(config, {
    from: "mail-live-clean@external.example",
    recipients: [config.orgA.recipient, config.orgB.recipient],
    subject: cleanMarker,
    body: cleanMarker,
  });
  const [orgAClean, orgBClean] = await Promise.all([
    waitForSearch(config.baseUrl, config.orgA.token, cleanMarker, config.timeoutMs),
    waitForSearch(config.baseUrl, config.orgB.token, cleanMarker, config.timeoutMs),
  ]);
  const [orgAThread, orgBThread] = await Promise.all([
    getThread(config.baseUrl, config.orgA.token, orgAClean.threadId),
    getThread(config.baseUrl, config.orgB.token, orgBClean.threadId),
  ]);
  assertTenantRecipients(orgAThread, config.orgA.recipient, config.orgB.recipient);
  assertTenantRecipients(orgBThread, config.orgB.recipient, config.orgA.recipient);
  evidence.local.recipient_aware_routing = {
    status: "passed",
    markerHash: anonymizeIdentifier(cleanMarker),
    orgA: {
      ...addressEvidence(config.orgA.recipient),
      messageIdHash: anonymizeIdentifier(orgAClean.messageId),
    },
    orgB: {
      ...addressEvidence(config.orgB.recipient),
      messageIdHash: anonymizeIdentifier(orgBClean.messageId),
    },
    tenantRecipientIsolation: true,
  };
  evidence.local.clean_inbound = {
    status: "passed",
    acceptedAt: new Date().toISOString(),
    messageIdHashes: [
      anonymizeIdentifier(orgAClean.messageId),
      anonymizeIdentifier(orgBClean.messageId),
    ],
  };

  const spamMarker = `${markerPrefix}-spam`;
  await sendPlainProbe(config, {
    from: "mail-live-spam@external.example",
    recipients: [config.orgA.recipient],
    subject: spamMarker,
    body: `${spamMarker}\n\nXJS*C4JDBQADN1.NSBN3*2IDNEN*GTUBE-STANDARD-ANTI-UBE-TEST-EMAIL*C.34X`,
  });
  const spamThread = await waitForFolder(
    config.baseUrl,
    config.orgA.token,
    "spam",
    spamMarker,
    config.timeoutMs,
  );
  evidence.local.spam_inbound = {
    status: "passed",
    messageIdHash: anonymizeIdentifier(spamThread.messageId),
    folder: "spam",
  };

  const eicarMarker = `${markerPrefix}-eicar`;
  await sendSmtp({
    ...config.smtp,
    from: "mail-live-eicar@external.example",
    recipients: [config.orgA.recipient],
    data: eicarMessage("mail-live-eicar@external.example", config.orgA.recipient, eicarMarker),
  });
  const quarantine = await waitForQuarantine(
    config.baseUrl,
    config.adminToken,
    eicarMarker,
    config.timeoutMs,
  );
  evidence.local.eicar_quarantine = {
    status: "passed",
    quarantineIdHash: anonymizeIdentifier(quarantine.id),
    reasons: quarantine.reasons,
    rawMessageExposed: false,
  };

  const outbound = await queueApproveAndWait({
    baseUrl: config.baseUrl,
    token: config.adminToken,
    recipient: config.outboundRecipient,
    idempotencyKey: `${markerPrefix}-mailpit`,
    timeoutMs: config.timeoutMs,
  });
  const mailpit = await waitForMailpit(
    config.mailpitUrl,
    outbound.idempotencyKey,
    config.timeoutMs,
  );
  evidence.local.outbound_mailpit = {
    status: "passed",
    recipient: addressEvidence(config.outboundRecipient),
    outboundIdHash: anonymizeIdentifier(outbound.record.id),
    providerMessageIdHash:
      outbound.record.providerMessageId == null
        ? null
        : anonymizeIdentifier(outbound.record.providerMessageId),
    mailpitMessageIdHash: anonymizeIdentifier(mailpit.ID),
    latencyMs: Date.now() - outbound.startedAt,
  };

  const hardBounceEvent = {
    eventId: `${markerPrefix}-hard-bounce`,
    event: "failed",
    severity: "permanent",
    recipient: config.bounceRecipient,
  };
  const hardBounce = await postProviderEvent(config, hardBounceEvent);
  // The identical event is replayed to prove the webhook deduplicates by event id.
  const duplicateBounce = await postProviderEvent(config, hardBounceEvent);
  if (!hardBounce.suppressed || !duplicateBounce.duplicate) {
    throw new Error("hard-bounce webhook did not suppress and deduplicate");
  }
  evidence.local.provider_hard_bounce = {
    status: "passed",
    recipient: addressEvidence(config.bounceRecipient),
    eventIdHash: anonymizeIdentifier(hardBounce.eventId),
    duplicateIdempotent: true,
  };

  const complaint = await postProviderEvent(config, {
    eventId: `${markerPrefix}-complaint`,
    event: "complained",
    recipient: config.complaintRecipient,
  });
  if (!complaint.suppressed) throw new Error("complaint webhook did not suppress");
  evidence.local.provider_complaint = {
    status: "passed",
    recipient: addressEvidence(config.complaintRecipient),
    eventIdHash: anonymizeIdentifier(complaint.eventId),
  };

  const suppressed = await queueApproveAndWait({
    baseUrl: config.baseUrl,
    token: config.adminToken,
    recipient: config.bounceRecipient,
    idempotencyKey: `${markerPrefix}-suppressed`,
    timeoutMs: config.timeoutMs,
    expectedStatus: "failed",
  });
  if (!String(suppressed.record.lastError).includes(SUPPRESSION_CODE)) {
    throw new Error("suppressed recipient failed without the stable suppression code");
  }
  evidence.local.suppression = {
    status: "passed",
    outboundIdHash: anonymizeIdentifier(suppressed.record.id),
    operatorCode: SUPPRESSION_CODE,
  };

  const retried = await retryAndWait(
    config.baseUrl,
    config.adminToken,
    suppressed.record.id,
    config.timeoutMs,
  );
  if (
    retried.id !== suppressed.record.id ||
    !String(retried.lastError).includes(SUPPRESSION_CODE)
  ) {
    throw new Error("explicit retry did not preserve the outbound identity and terminal policy");
  }
  evidence.local.deterministic_retry = {
    status: "passed",
    outboundIdHash: anonymizeIdentifier(retried.id),
    preservedIdentity: true,
    finalStatus: retried.status,
    operatorCode: SUPPRESSION_CODE,
  };

  evidence.external = createEvidenceSkeleton(started).external;
  evidence.status = "passed";
  evidence.completedAt = new Date().toISOString();
  return evidence;
}

function localConfig(environment) {
  return {
    baseUrl: env(environment, "HELIX_BASE_URL", "http://127.0.0.1:28431"),
    smtp: {
      host: env(environment, "HELIX_MAIL_LIVE_SMTP_HOST", "127.0.0.1"),
      port: positiveInt(environment, "HELIX_MAIL_LIVE_SMTP_PORT", 28456),
    },
    mailpitUrl: env(environment, "HELIX_MAIL_LIVE_MAILPIT_URL", "http://127.0.0.1:28458"),
    timeoutMs: positiveInt(environment, "HELIX_MAIL_LIVE_TIMEOUT_MS", 30_000),
    orgA: {
      token: required(environment, "HELIX_MAIL_LIVE_ORG_A_TOKEN"),
      recipient: required(environment, "HELIX_MAIL_LIVE_ORG_A_RECIPIENT"),
    },
    orgB: {
      token: required(environment, "HELIX_MAIL_LIVE_ORG_B_TOKEN"),
      recipient: required(environment, "HELIX_MAIL_LIVE_ORG_B_RECIPIENT"),
    },
    adminToken: required(environment, "HELIX_MAIL_LIVE_ADMIN_TOKEN"),
    outboundRecipient: required(environment, "HELIX_MAIL_LIVE_OUTBOUND_RECIPIENT"),
    bounceRecipient: required(environment, "HELIX_MAIL_LIVE_BOUNCE_RECIPIENT"),
    complaintRecipient: required(environment, "HELIX_MAIL_LIVE_COMPLAINT_RECIPIENT"),
    providerOrgId: required(environment, "HELIX_MAIL_LIVE_PROVIDER_ORG_ID"),
    providerId: required(environment, "HELIX_MAIL_LIVE_PROVIDER_ID"),
    providerWebhookSecret: required(environment, "HELIX_MAIL_LIVE_PROVIDER_WEBHOOK_SECRET"),
  };
}

async function queueApproveAndWait(input) {
  const startedAt = Date.now();
  const pending = await callTool(input.baseUrl, input.token, "mail.send", {
    to: [input.recipient],
    subject: input.idempotencyKey,
    bodyText: input.idempotencyKey,
    undoWindowMs: 0,
    idempotencyKey: input.idempotencyKey,
  });
  const record = await approvePending(input.baseUrl, input.token, pending.pendingId);
  const final = await waitForOutbound(
    input.baseUrl,
    input.token,
    record.id,
    input.expectedStatus ?? "sent",
    input.timeoutMs,
  );
  return { record: final, startedAt, idempotencyKey: input.idempotencyKey };
}

async function retryAndWait(baseUrl, token, outboundId, timeoutMs) {
  const pending = await callTool(baseUrl, token, "mail.outbound.retry", { outboundId });
  const record = await approvePending(baseUrl, token, pending.pendingId);
  return waitForOutbound(baseUrl, token, record.id, "failed", timeoutMs);
}

function authorizedJsonHeaders(token) {
  return {
    accept: "application/json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

async function callTool(baseUrl, token, toolId, input) {
  const response = await fetch(new URL(`/api/tools/${toolId}`, baseUrl), {
    method: "POST",
    headers: authorizedJsonHeaders(token),
    body: JSON.stringify(input),
  });
  const parsed = await jsonResponse(response, toolId);
  if (response.status === 202 && typeof parsed.pending?.id === "string") {
    return { pendingId: parsed.pending.id };
  }
  if (!response.ok) throw new Error(`${toolId} returned HTTP ${String(response.status)}`);
  return parsed.output ?? parsed;
}

async function approvePending(baseUrl, token, pendingId) {
  const response = await fetch(
    new URL(`/api/tools/pending/${encodeURIComponent(pendingId)}/approve`, baseUrl),
    {
      method: "POST",
      headers: authorizedJsonHeaders(token),
      body: "{}",
    },
  );
  const parsed = await jsonResponse(response, "pending approval");
  if (!response.ok || parsed.status !== "executed" || typeof parsed.output?.id !== "string") {
    throw new Error("pending action did not execute with an outbound id");
  }
  return parsed.output;
}

async function waitForOutbound(baseUrl, token, id, expectedStatus, timeoutMs) {
  return poll(
    timeoutMs,
    async () => {
      const output = await callTool(baseUrl, token, "mail.outbound.get", { id });
      const outbound = output.outbound;
      return outbound?.status === expectedStatus ? outbound : null;
    },
    `outbound ${anonymizeIdentifier(id)} status ${expectedStatus}`,
  );
}

async function waitForSearch(baseUrl, token, query, timeoutMs) {
  return poll(
    timeoutMs,
    async () => {
      const output = await callTool(baseUrl, token, "mail.search", {
        query,
        labels: [],
        limit: 10,
      });
      return output.hits?.[0] ?? null;
    },
    "inbound search result",
  );
}

async function getThread(baseUrl, token, threadId) {
  const output = await callTool(baseUrl, token, "mail.thread.get", { threadId });
  if (output.thread == null) throw new Error("mail thread was not visible to the expected actor");
  return output.thread;
}

async function waitForFolder(baseUrl, token, folder, query, timeoutMs) {
  return poll(
    timeoutMs,
    async () => {
      const output = await callTool(baseUrl, token, "mail.threads.list", {
        folder,
        query,
        limit: 10,
        offset: 0,
      });
      return output.threads?.[0] ?? null;
    },
    `${folder} folder result`,
  );
}

async function waitForQuarantine(baseUrl, token, subject, timeoutMs) {
  return poll(
    timeoutMs,
    async () => {
      const response = await fetch(new URL("/api/admin/mail/quarantine", baseUrl), {
        headers: { accept: "application/json", authorization: `Bearer ${token}` },
      });
      const parsed = await jsonResponse(response, "mail quarantine list");
      if (!response.ok) throw new Error(`quarantine list returned HTTP ${String(response.status)}`);
      return parsed.quarantines?.find((record) => record.subject === subject) ?? null;
    },
    "EICAR quarantine record",
  );
}

async function waitForMailpit(baseUrl, query, timeoutMs) {
  return poll(
    timeoutMs,
    async () => {
      const url = new URL("/api/v1/search", baseUrl);
      url.searchParams.set("query", query);
      const response = await fetch(url);
      const parsed = await jsonResponse(response, "Mailpit search");
      return parsed.messages?.[0] ?? null;
    },
    "Mailpit outbound message",
  );
}

async function postProviderEvent(config, input) {
  const timestamp = Math.floor(Date.now() / 1000);
  const raw = JSON.stringify({
    "event-data": {
      id: input.eventId,
      event: input.event,
      ...(input.severity === undefined ? {} : { severity: input.severity }),
      recipient: input.recipient,
      timestamp,
      message: { headers: { "message-id": `<${input.eventId}@provider.test>` } },
      "delivery-status": { code: input.event === "complained" ? 0 : 550, description: "M7 probe" },
    },
  });
  const digest = createHmac("sha256", config.providerWebhookSecret)
    .update(`${String(timestamp)}.${raw}`)
    .digest("hex");
  const response = await fetch(
    new URL(
      `/webhooks/mail/providers/${encodeURIComponent(config.providerOrgId)}/${encodeURIComponent(config.providerId)}`,
      config.baseUrl,
    ),
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-helix-signature": `t=${String(timestamp)},v1=${digest}`,
      },
      body: raw,
    },
  );
  const parsed = await jsonResponse(response, "provider webhook");
  if (response.status !== 202 || parsed.accepted !== true) {
    throw new Error(`provider webhook returned HTTP ${String(response.status)}`);
  }
  return parsed;
}

function assertTenantRecipients(thread, expectedRecipient, forbiddenRecipient) {
  const addresses = (thread.messages ?? []).flatMap((message) =>
    (message.to ?? []).map((address) => String(address.address).toLowerCase()),
  );
  if (!addresses.includes(expectedRecipient.toLowerCase())) {
    throw new Error("tenant copy did not contain its accepted recipient");
  }
  if (addresses.includes(forbiddenRecipient.toLowerCase())) {
    throw new Error("tenant copy leaked a recipient from another organization");
  }
}

function plainMessage(input) {
  return [
    `From: <${input.from}>`,
    `To: ${input.recipients.map((recipient) => `<${recipient}>`).join(", ")}`,
    `Message-ID: <${randomUUID()}@mail-live.test>`,
    `Subject: ${input.subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    input.body,
  ].join("\r\n");
}

function eicarMessage(from, recipient, subject) {
  const eicar = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
  return [
    `From: <${from}>`,
    `To: <${recipient}>`,
    `Message-ID: <${randomUUID()}@mail-live.test>`,
    `Subject: ${subject}`,
    'Content-Type: multipart/mixed; boundary="helix-m7"',
    "",
    "--helix-m7",
    "Content-Type: text/plain",
    "",
    "M7 antivirus probe.",
    "--helix-m7",
    "Content-Type: application/octet-stream",
    'Content-Disposition: attachment; filename="eicar.com.txt"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(eicar).toString("base64"),
    "--helix-m7--",
    "",
  ].join("\r\n");
}

async function sendPlainProbe(config, { from, recipients, subject, body }) {
  await sendSmtp({
    ...config.smtp,
    from,
    recipients,
    data: plainMessage({ from, recipients, subject, body }),
  });
}

async function sendSmtp(input) {
  const session = await SmtpSession.connect(input.host, input.port);
  try {
    await session.command("EHLO mail-live.local", 250);
    await session.command(`MAIL FROM:<${input.from}>`, 250);
    for (const recipient of input.recipients) {
      await session.command(`RCPT TO:<${recipient}>`, 250);
    }
    await session.command("DATA", 354);
    await session.command(`${dotStuff(input.data)}\r\n.`, 250);
    await session.command("QUIT", 221);
  } finally {
    session.close();
  }
}

class SmtpSession {
  constructor(socket) {
    this.socket = socket;
    this.buffer = "";
  }

  static async connect(host, port) {
    const socket = net.createConnection({ host, port });
    socket.setEncoding("utf8");
    socket.setTimeout(15_000);
    const session = new SmtpSession(socket);
    await session.reply(220);
    return session;
  }

  async command(command, expected) {
    this.socket.write(`${command}\r\n`);
    return this.reply(expected);
  }

  reply(expected) {
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
      const onTimeout = () => onError(new Error("SMTP command timed out"));
      const onData = (chunk) => {
        this.buffer += chunk;
        let newline;
        while ((newline = this.buffer.indexOf("\n")) >= 0) {
          const line = this.buffer.slice(0, newline + 1).trimEnd();
          this.buffer = this.buffer.slice(newline + 1);
          lines.push(line);
          if (/^[0-9]{3} /u.test(line)) {
            cleanup();
            const code = Number(line.slice(0, 3));
            if (code !== expected) {
              reject(new Error(`SMTP expected ${String(expected)}, received ${line}`));
            } else {
              resolve(lines);
            }
            return;
          }
        }
      };
      this.socket.on("data", onData);
      this.socket.on("error", onError);
      this.socket.on("timeout", onTimeout);
    });
  }

  close() {
    this.socket.destroy();
  }
}

async function poll(timeoutMs, probe, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await probe();
      if (result != null) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  const suffix = lastError instanceof Error ? ` Last error: ${lastError.message}` : "";
  throw new Error(`timed out waiting for ${label}.${suffix}`);
}

async function jsonResponse(response, label) {
  const text = await response.text();
  try {
    return text.length === 0 ? {} : JSON.parse(text);
  } catch {
    throw new Error(`${label} returned non-JSON HTTP ${String(response.status)}`);
  }
}

function dotStuff(value) {
  return value.replace(/^\./gmu, "..");
}

function validateResult(result, path) {
  if (
    typeof result !== "object" ||
    result === null ||
    !["passed", "failed", "not_run"].includes(result.status)
  ) {
    throw new Error(`invalid Mail live evidence result: ${path}`);
  }
  if (result.status === "not_run" && typeof result.reason !== "string") {
    throw new Error(`not-run Mail live evidence requires a reason: ${path}`);
  }
}

function validateExternalResult(target, result) {
  if (typeof result.provider !== "string" || result.provider.length === 0) {
    throw new Error(`passed external evidence requires provider: ${target}`);
  }
  if (target === "provider_sandbox") {
    const eventTypes = new Set(
      Array.isArray(result.events)
        ? result.events
            .filter(
              (event) =>
                typeof event === "object" &&
                event !== null &&
                typeof event.type === "string" &&
                event.suppressed === true &&
                /^[a-f0-9]{20}$/u.test(event.eventIdHash),
            )
            .map((event) => event.type)
        : [],
    );
    if (!eventTypes.has("hard_bounce") || !eventTypes.has("complaint")) {
      throw new Error("provider sandbox evidence requires suppressed bounce and complaint events");
    }
    return;
  }
  if (
    typeof result.recipientDomain !== "string" ||
    !/^[a-z0-9.-]+\.[a-z]{2,}$/iu.test(result.recipientDomain) ||
    !/^[a-f0-9]{20}$/u.test(result.messageIdHash) ||
    !Number.isFinite(result.latencyMs) ||
    result.latencyMs < 0 ||
    !["inbox", "spam", "junk", "other"].includes(result.placement) ||
    !["accepted", "delivered"].includes(result.finalStatus)
  ) {
    throw new Error(`invalid ${target} external delivery evidence`);
  }
  for (const mechanism of ["spf", "dkim", "dmarc"]) {
    if (
      !["pass", "fail", "neutral", "none", "temperror", "permerror"].includes(
        result.authentication?.[mechanism],
      )
    ) {
      throw new Error(`invalid ${target} ${mechanism} authentication evidence`);
    }
  }
}

function isEvidenceHash(value) {
  return typeof value === "string" && /^[a-f0-9]{20}$/u.test(value);
}

function isAddressEvidence(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof value.domain === "string" &&
    isEvidenceHash(value.addressHash)
  );
}

function validateLocalResult(scenario, result) {
  switch (scenario) {
    case "recipient_aware_routing":
      if (
        !isEvidenceHash(result.markerHash) ||
        !isAddressEvidence(result.orgA) ||
        !isAddressEvidence(result.orgB) ||
        !isEvidenceHash(result.orgA.messageIdHash) ||
        !isEvidenceHash(result.orgB.messageIdHash) ||
        result.tenantRecipientIsolation !== true
      ) {
        throw new Error("invalid recipient-aware routing evidence");
      }
      return;
    case "clean_inbound":
      if (
        !validTimestamp(result.acceptedAt) ||
        !Array.isArray(result.messageIdHashes) ||
        result.messageIdHashes.length !== 2 ||
        !result.messageIdHashes.every(isEvidenceHash)
      ) {
        throw new Error("invalid clean inbound evidence");
      }
      return;
    case "spam_inbound":
      if (!isEvidenceHash(result.messageIdHash) || result.folder !== "spam") {
        throw new Error("invalid spam inbound evidence");
      }
      return;
    case "eicar_quarantine":
      if (
        !isEvidenceHash(result.quarantineIdHash) ||
        !Array.isArray(result.reasons) ||
        result.reasons.length === 0 ||
        result.rawMessageExposed !== false
      ) {
        throw new Error("invalid EICAR quarantine evidence");
      }
      return;
    case "outbound_mailpit":
      if (
        !isAddressEvidence(result.recipient) ||
        !isEvidenceHash(result.outboundIdHash) ||
        !isEvidenceHash(result.mailpitMessageIdHash) ||
        (result.providerMessageIdHash !== null && !isEvidenceHash(result.providerMessageIdHash)) ||
        !Number.isFinite(result.latencyMs) ||
        result.latencyMs < 0
      ) {
        throw new Error("invalid outbound Mailpit evidence");
      }
      return;
    case "provider_hard_bounce":
      if (
        !isAddressEvidence(result.recipient) ||
        !isEvidenceHash(result.eventIdHash) ||
        result.duplicateIdempotent !== true
      ) {
        throw new Error("invalid provider hard-bounce evidence");
      }
      return;
    case "provider_complaint":
      if (!isAddressEvidence(result.recipient) || !isEvidenceHash(result.eventIdHash)) {
        throw new Error("invalid provider complaint evidence");
      }
      return;
    case "suppression":
      if (
        !isEvidenceHash(result.outboundIdHash) ||
        result.operatorCode !== "MAIL_RECIPIENT_SUPPRESSED"
      ) {
        throw new Error("invalid suppression evidence");
      }
      return;
    case "deterministic_retry":
      if (
        !isEvidenceHash(result.outboundIdHash) ||
        result.preservedIdentity !== true ||
        result.finalStatus !== "failed" ||
        result.operatorCode !== "MAIL_RECIPIENT_SUPPRESSED"
      ) {
        throw new Error("invalid deterministic retry evidence");
      }
      return;
    default:
      throw new Error(`unknown local Mail evidence scenario: ${scenario}`);
  }
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function required(environment, name) {
  const value = environment[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function env(environment, name, fallback) {
  const value = environment[name];
  return value === undefined || value.length === 0 ? fallback : value;
}

function positiveInt(environment, name, fallback) {
  const parsed = Number.parseInt(env(environment, name, String(fallback)), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(
      `mail live evidence smoke failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
