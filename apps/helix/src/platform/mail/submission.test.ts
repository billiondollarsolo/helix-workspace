import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodemailer from "nodemailer";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Actor } from "@helix/sdk-types";
import { AppPasswordManager, InMemoryAppPasswordStore } from "../auth/app-passwords.js";
import type { CreateOutboundMailInput, MailStore } from "./store.js";
import type { MailOutboundRecord } from "./types.js";
import { SmtpSubmissionServer } from "./submission.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const actorId = "11111111-1111-4111-8111-111111111111";
let certificateDirectory: string;
let tlsKey: Buffer;
let tlsCert: Buffer;

beforeAll(() => {
  certificateDirectory = mkdtempSync(join(tmpdir(), "helix-submission-tls-"));
  const keyPath = join(certificateDirectory, "key.pem");
  const certPath = join(certificateDirectory, "cert.pem");
  execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-subj",
    "/CN=localhost",
    "-days",
    "1",
  ], { stdio: "ignore" });
  tlsKey = readFileSync(keyPath);
  tlsCert = readFileSync(certPath);
});

afterAll(() => {
  rmSync(certificateDirectory, { recursive: true, force: true });
});

describe("authenticated SMTP submission", () => {
  it.each([
    ["Apple Mail", "PLAIN"],
    ["Thunderbird", "LOGIN"],
    ["mobile mail", "PLAIN"],
  ] as const)("accepts the %s implicit-TLS profile with AUTH %s", async (_clientName, authMethod) => {
    const { password, appPasswords } = await credentials();
    const createOutbound = vi.fn(async (input: CreateOutboundMailInput) => outbound(input));
    const server = new SmtpSubmissionServer({
      appPasswords,
      store: mailStore(createOutbound),
      tls: { key: tlsKey, cert: tlsCert },
    });
    await server.listen(0, "127.0.0.1");
    const address = server.nodeServer.server.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP address.");
    const client = nodemailer.createTransport({
      host: "127.0.0.1",
      port: address.port,
      secure: true,
      auth: { user: "user@example.test", pass: password },
      authMethod,
      tls: { rejectUnauthorized: false },
    });
    try {
      await expect(
        client.sendMail({
          from: "User <user@example.test>",
          to: "one@outside.test",
          cc: "two@outside.test",
          bcc: "hidden@outside.test",
          subject: "Client interoperability",
          text: "Sent from a standards client",
          attachments: [{ filename: "proof.txt", content: "attached" }],
        }),
      ).resolves.toMatchObject({ accepted: expect.arrayContaining(["one@outside.test"]) });
      expect(createOutbound).toHaveBeenCalledOnce();
      expect(createOutbound.mock.calls[0]?.[0]).toMatchObject({
        orgId,
        actorId,
        envelope: {
          from: { address: "user@example.test", name: "User" },
          to: [{ address: "one@outside.test" }],
          cc: [{ address: "two@outside.test" }],
          bcc: [{ address: "hidden@outside.test" }],
          subject: "Client interoperability",
          text: "Sent from a standards client",
          attachments: [expect.objectContaining({ filename: "proof.txt" })],
        },
      });
    } finally {
      client.close();
      await server.close();
    }
  });

  it("rejects bad, revoked, and sender-spoofing client sessions", async () => {
    const { registration, password, manager, appPasswords } = await credentials();
    const createOutbound = vi.fn(async (input: CreateOutboundMailInput) => outbound(input));
    const server = new SmtpSubmissionServer({
      appPasswords,
      store: mailStore(createOutbound),
      tls: { key: tlsKey, cert: tlsCert },
    });
    await server.listen(0, "127.0.0.1");
    const address = server.nodeServer.server.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP address.");
    const send = (pass: string, from = "user@example.test") =>
      nodemailer
        .createTransport({
          host: "127.0.0.1",
          port: address.port,
          secure: true,
          auth: { user: "user@example.test", pass },
          tls: { rejectUnauthorized: false },
        })
        .sendMail({ from, to: "recipient@outside.test", subject: "Denied", text: "Denied" });
    try {
      await expect(send("wrong-password")).rejects.toMatchObject({ responseCode: 535 });
      await expect(send(password, "forged@example.test")).rejects.toMatchObject({
        responseCode: 553,
      });
      await manager.revoke({ id: registration.appPassword.id, orgId });
      await expect(send(password)).rejects.toMatchObject({ responseCode: 535 });
      expect(createOutbound).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("rejects submission when current external-send authority was removed", async () => {
    const { password, appPasswords } = await credentials(["mail.send"]);
    const createOutbound = vi.fn(async (input: CreateOutboundMailInput) => outbound(input));
    const server = new SmtpSubmissionServer({
      appPasswords,
      store: mailStore(createOutbound),
      tls: { key: tlsKey, cert: tlsCert },
    });
    await server.listen(0, "127.0.0.1");
    const address = server.nodeServer.server.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP address.");
    const client = nodemailer.createTransport({
      host: "127.0.0.1",
      port: address.port,
      secure: true,
      auth: { user: "user@example.test", pass: password },
      tls: { rejectUnauthorized: false },
    });
    try {
      await expect(client.verify()).rejects.toMatchObject({ responseCode: 535 });
      expect(createOutbound).not.toHaveBeenCalled();
    } finally {
      client.close();
      await server.close();
    }
  });
});

async function credentials(scopes: readonly string[] = ["mail.send", "mail.external"]) {
  const appPasswords = new InMemoryAppPasswordStore();
  const actor: Actor = {
    id: actorId,
    orgId,
    type: "user",
    email: "user@example.test",
    displayName: "User",
    scopes,
  };
  appPasswords.addActor(actor);
  const manager = new AppPasswordManager(appPasswords);
  const registration = await manager.create({
    actorId,
    orgId,
    label: "Mail client",
    scopes: ["smtp"],
  });
  return { appPasswords, manager, password: registration.password, registration };
}

function mailStore(createOutbound: (input: CreateOutboundMailInput) => Promise<MailOutboundRecord>) {
  return {
    createOutbound,
    resolveAuthorizedSender: async (_orgId: string, _actorId: string, address: string) =>
      address.toLowerCase() === "user@example.test" ? "user@example.test" : null,
  } as unknown as MailStore;
}

function outbound(input: CreateOutboundMailInput): MailOutboundRecord {
  const now = new Date();
  return {
    id: "outbound-1",
    orgId: input.orgId,
    actorId: input.actorId,
    messageId: "message-1",
    threadId: "thread-1",
    outboxId: "outbox-1",
    status: "queued",
    envelope: input.envelope,
    undoUntil: now,
    sentAt: null,
    cancelledAt: null,
    failedAt: null,
    lastError: null,
    providerMessageId: null,
    deliveryMetadata: {},
    createdAt: now,
    updatedAt: now,
    attemptCount: 0,
    nextAttemptAt: now,
    deadLetteredAt: null,
    handoffKey: "handoff-1",
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
  };
}
