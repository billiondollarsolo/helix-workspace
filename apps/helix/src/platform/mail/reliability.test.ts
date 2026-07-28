import { describe, expect, it, vi } from "vitest";
import type { MailDraftRecord } from "./types.js";
import {
  MailAttachmentAccessRevokedError,
  createDispatchAuthorizedAttachmentResolver,
  mailOutboundDisplayStatus,
  reconcileLocalDraftRecovery,
} from "./reliability.js";

const serverDraft: MailDraftRecord = {
  id: "draft-1",
  orgId: "org-1",
  actorId: "actor-1",
  threadId: null,
  envelope: { subject: "Server" },
  version: 3,
  createdAt: new Date("2026-07-28T12:00:00.000Z"),
  updatedAt: new Date("2026-07-28T12:05:00.000Z"),
};

describe("draft recovery reconciliation", () => {
  it("keeps a newer authoritative server draft", () => {
    expect(
      reconcileLocalDraftRecovery(serverDraft, {
        draftId: serverDraft.id,
        envelope: { subject: "Stale local" },
        basedOnServerVersion: 2,
        updatedAt: new Date("2026-07-28T12:06:00.000Z"),
      }),
    ).toMatchObject({ kind: "use_server", reason: "server_newer" });
  });

  it("requires an explicit merge for local crash recovery newer than its server base", () => {
    expect(
      reconcileLocalDraftRecovery(serverDraft, {
        draftId: serverDraft.id,
        envelope: { subject: "Recovered local edits" },
        basedOnServerVersion: 3,
        updatedAt: new Date("2026-07-28T12:06:00.000Z"),
      }),
    ).toMatchObject({ kind: "requires_explicit_merge" });
  });
});

describe("outbound user-visible status", () => {
  it.each([
    ["queued", "queued"],
    ["sending", "sending"],
    ["sent", "sent"],
    ["failed", "failed"],
    ["cancelled", "cancelled"],
  ] as const)("maps %s to %s", (status, expected) => {
    expect(
      mailOutboundDisplayStatus({
        status,
        deliveryMetadata: {},
      }),
    ).toBe(expected);
  });

  it("surfaces delayed and soft-bounce provider events as delayed", () => {
    for (const latestEvent of ["delayed", "soft_bounce"]) {
      expect(
        mailOutboundDisplayStatus({
          status: "sent",
          deliveryMetadata: { latestEvent },
        }),
      ).toBe("delayed");
    }
  });
});

describe("dispatch-time attachment authorization", () => {
  it("reads the object with the original org and actor at dispatch time", async () => {
    const readFile = vi.fn().mockResolvedValue({ content: Buffer.from("attachment") });
    const resolve = createDispatchAuthorizedAttachmentResolver({ readFile });
    await expect(resolve("object-1", { orgId: "org-1", actorId: "actor-1" })).resolves.toEqual(
      Buffer.from("attachment"),
    );
    expect(readFile).toHaveBeenCalledWith({
      orgId: "org-1",
      actorId: "actor-1",
      objectId: "object-1",
    });
  });

  it("fails non-retryably when attachment access was revoked", async () => {
    const resolve = createDispatchAuthorizedAttachmentResolver({
      readFile: vi.fn().mockResolvedValue(null),
    });
    const error = await resolve("object-1", {
      orgId: "org-1",
      actorId: "actor-1",
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MailAttachmentAccessRevokedError);
    expect(error).toMatchObject({ retryable: false });
  });
});
