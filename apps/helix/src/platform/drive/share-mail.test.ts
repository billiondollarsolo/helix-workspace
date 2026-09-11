import { describe, expect, it } from "vitest";
import type { CreateOutboundMailInput, MailStore } from "../mail/index.js";
import type { MailOutboundRecord } from "../mail/types.js";
import { createMailDriveShareSender } from "./share-mail.js";

describe("Drive share mail", () => {
  it("queues a share email from the owner to each recipient", async () => {
    const mail = new FakeMailStore();
    const sender = createMailDriveShareSender({
      store: mail as unknown as MailStore,
      publicBaseUrl: "https://helix.example.com/",
    });
    await sender.sendShare({
      orgId: "org-1",
      actorId: "actor-ada",
      objectId: "file-1",
      title: "Specs.pdf",
      role: "commenter",
      authorName: "Ada Park",
      authorEmail: "ada@helix.example.com",
      message: "Please review page two.",
      recipients: [{ email: "maya@helix.example.com", displayName: "Maya Chen" }],
    });
    expect(mail.created).toHaveLength(1);
    expect(mail.created[0]).toMatchObject({
      orgId: "org-1",
      actorId: "actor-ada",
      outboxSubject: "mail.send",
    });
    expect(mail.created[0]?.envelope).toMatchObject({
      from: { address: "ada@helix.example.com", name: "Ada Park" },
      to: [{ address: "maya@helix.example.com", name: "Maya Chen" }],
      subject: 'Ada Park shared "Specs.pdf" with you',
    });
    expect(mail.created[0]?.envelope.text).toContain("Please review page two.");
    expect(mail.created[0]?.envelope.text).toContain("https://helix.example.com/drive?file=file-1");
    expect(mail.created[0]?.envelope.html).toContain("comment");
    expect(mail.created[0]?.envelope.html).toContain(
      'href="https://helix.example.com/drive?file=file-1"',
    );
  });

  it("queues access-request and decision mail", async () => {
    const mail = new FakeMailStore();
    const sender = createMailDriveShareSender({
      store: mail as unknown as MailStore,
      publicBaseUrl: "https://helix.example.com",
    });
    await sender.sendAccessRequest({
      orgId: "org-1",
      actorId: "actor-maya",
      objectId: "file-1",
      title: "Specs.pdf",
      message: "Need this for Q3.",
      requesterName: "Maya Chen",
      requesterEmail: "maya@helix.example.com",
      ownerEmail: "ada@helix.example.com",
      ownerName: "Ada Park",
    });
    await sender.sendAccessDecision({
      orgId: "org-1",
      actorId: "actor-ada",
      objectId: "file-1",
      title: "Specs.pdf",
      approved: true,
      ownerName: "Ada Park",
      ownerEmail: "ada@helix.example.com",
      requesterEmail: "maya@helix.example.com",
      requesterName: "Maya Chen",
    });
    expect(mail.created.map((row) => row.envelope.subject)).toEqual([
      'Maya Chen requested access to "Specs.pdf"',
      'Ada Park approved your request to access "Specs.pdf"',
    ]);
    expect(mail.created[0]?.envelope.to[0]?.address).toBe("ada@helix.example.com");
    expect(mail.created[1]?.envelope.to[0]?.address).toBe("maya@helix.example.com");
  });
});

class FakeMailStore {
  readonly created: CreateOutboundMailInput[] = [];

  async createOutbound(input: CreateOutboundMailInput): Promise<MailOutboundRecord> {
    this.created.push(input);
    return {
      id: `outbound-${String(this.created.length)}`,
      orgId: input.orgId,
      actorId: input.actorId,
      messageId: `message-${String(this.created.length)}`,
      threadId: input.threadId ?? `thread-${String(this.created.length)}`,
      outboxId: `outbox-${String(this.created.length)}`,
      status: "queued",
      envelope: input.envelope,
      undoUntil: input.undoUntil,
      sentAt: null,
      cancelledAt: null,
      failedAt: null,
      lastError: null,
      providerMessageId: null,
      deliveryMetadata: {},
      createdAt: new Date("2026-05-20T12:00:00.000Z"),
      updatedAt: new Date("2026-05-20T12:00:00.000Z"),
    };
  }
}
