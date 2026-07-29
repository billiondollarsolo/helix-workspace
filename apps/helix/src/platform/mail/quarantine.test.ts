import fastify from "fastify";
import type { Actor } from "@helix/sdk-types";
import { describe, expect, it, vi } from "vitest";
import {
  InMemoryMailQuarantineStore,
  MailQuarantineService,
  quarantineReleaseScannerFromAntivirus,
  serializeMailQuarantine,
} from "./quarantine.js";
import { registerMailQuarantineAdminRoutes } from "./quarantine-routes.js";

const orgA = "11111111-1111-4111-8111-111111111111";
const orgB = "22222222-2222-4222-8222-222222222222";
const adminA: Actor = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  orgId: orgA,
  type: "user",
  scopes: ["mail.admin"],
};

describe("mail quarantine admin flow", () => {
  it("reuses the inbound antivirus scanner and treats unscanned results as not clean", async () => {
    const rescan = quarantineReleaseScannerFromAntivirus({
      scan: vi.fn().mockResolvedValue({
        infected: false,
        signature: null,
        scanned: false,
        disposition: "quarantine",
        evidence: { state: "scan_failed" },
      }),
    });
    await expect(rescan.rescan(Buffer.from("raw"))).resolves.toEqual({
      clean: false,
      evidence: { state: "scan_failed" },
    });
  });

  it("requires a clean re-scan, clears raw bytes, and audits release", async () => {
    const store = new InMemoryMailQuarantineStore();
    const record = await seed(store);
    const deliver = vi.fn().mockResolvedValue(undefined);
    const append = vi.fn().mockResolvedValue({ id: "audit", thisHash: "hash" });
    const service = new MailQuarantineService({
      store,
      scanner: {
        rescan: vi.fn().mockResolvedValue({ clean: true, evidence: { state: "clean" } }),
      },
      deliver,
      auditSink: { append },
    });
    const released = await service.release({
      orgId: orgA,
      actorId: adminA.id,
      id: record.id,
      confirmed: true,
      reason: "False positive confirmed by security.",
    });
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({ id: record.id }),
      record.rawMessage,
    );
    expect(released).toMatchObject({ status: "released", rawMessage: null });
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({ verb: "mail.quarantine.released", orgId: orgA }),
    );
    expect(JSON.stringify(serializeMailQuarantine(record))).not.toContain("raw-message");
  });

  it("keeps a message quarantined when re-scan fails", async () => {
    const store = new InMemoryMailQuarantineStore();
    const record = await seed(store);
    const service = new MailQuarantineService({
      store,
      scanner: {
        rescan: vi.fn().mockRejectedValue(new Error("clamd unavailable")),
      },
      deliver: vi.fn(),
      auditSink: { append: vi.fn() },
    });
    expect(
      await service.release({
        orgId: orgA,
        actorId: adminA.id,
        id: record.id,
        confirmed: true,
        reason: "Try release.",
      }),
    ).toBeNull();
    expect((await store.list(orgA))[0]).toMatchObject({
      status: "quarantined",
      reasons: expect.arrayContaining(["release_rescan_not_clean"]),
    });
  });

  it("returns a clean message to quarantine when delivery fails", async () => {
    const store = new InMemoryMailQuarantineStore();
    const record = await seed(store);
    const service = new MailQuarantineService({
      store,
      scanner: {
        rescan: vi.fn().mockResolvedValue({ clean: true, evidence: { state: "clean" } }),
      },
      deliver: vi.fn().mockRejectedValue(new Error("mailbox disabled")),
      auditSink: { append: vi.fn() },
    });

    await expect(
      service.release({
        orgId: orgA,
        actorId: adminA.id,
        id: record.id,
        confirmed: true,
        reason: "Try release.",
      }),
    ).resolves.toBeNull();
    expect((await store.list(orgA))[0]).toMatchObject({
      status: "quarantined",
      reasons: expect.arrayContaining(["release_delivery_failed"]),
      rawMessage: record.rawMessage,
    });
  });

  it("requires admin scope and cannot release across organizations", async () => {
    const store = new InMemoryMailQuarantineStore();
    const record = await seed(store);
    let actor: Actor = { ...adminA, scopes: ["mail.read"] };
    const service = new MailQuarantineService({
      store,
      scanner: { rescan: vi.fn().mockResolvedValue({ clean: true, evidence: {} }) },
      deliver: vi.fn(),
      auditSink: { append: vi.fn() },
    });
    const app = fastify();
    await registerMailQuarantineAdminRoutes(app, {
      service,
      actorFromRequest: () => actor,
    });
    await app.ready();
    const denied = await app.inject({
      method: "POST",
      url: `/api/admin/mail/quarantine/${record.id}/release`,
      payload: { confirmed: true, reason: "Release reviewed." },
    });
    expect(denied.statusCode).toBe(403);

    actor = { ...adminA, orgId: orgB };
    const crossOrg = await app.inject({
      method: "POST",
      url: `/api/admin/mail/quarantine/${record.id}/release`,
      payload: { confirmed: true, reason: "Release reviewed." },
    });
    expect(crossOrg.statusCode).toBe(409);
    expect((await store.list(orgA))[0]?.status).toBe("quarantined");
    await app.close();
  });

  it("requires explicit delete confirmation and audits deletion", async () => {
    const store = new InMemoryMailQuarantineStore();
    const record = await seed(store);
    const append = vi.fn().mockResolvedValue({ id: "audit", thisHash: "hash" });
    const service = new MailQuarantineService({
      store,
      scanner: { rescan: vi.fn() },
      deliver: vi.fn(),
      auditSink: { append },
    });
    const app = fastify();
    await registerMailQuarantineAdminRoutes(app, {
      service,
      actorFromRequest: () => adminA,
    });
    await app.ready();

    const unconfirmed = await app.inject({
      method: "DELETE",
      url: `/api/admin/mail/quarantine/${record.id}`,
      payload: { confirmed: false, reason: "Reviewed malware." },
    });
    expect(unconfirmed.statusCode).toBe(400);
    expect((await store.list(orgA))[0]?.rawMessage).not.toBeNull();

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/admin/mail/quarantine/${record.id}`,
      payload: { confirmed: true, reason: "Reviewed malware." },
    });
    expect(deleted.statusCode).toBe(200);
    expect(await store.list(orgA)).toHaveLength(0);
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({ verb: "mail.quarantine.deleted", orgId: orgA }),
    );
    await app.close();
  });
});

async function seed(store: InMemoryMailQuarantineStore) {
  return (
    await store.quarantine({
      orgId: orgA,
      dedupKey: "a".repeat(64),
      envelopeFrom: "sender@example.net",
      envelopeTo: ["user@example.com"],
      subject: "Quarantined",
      reasons: ["malware"],
      authEvidence: { spf: "pass" },
      scanEvidence: { state: "infected" },
      rawMessage: Buffer.from("raw-message"),
    })
  ).record;
}
