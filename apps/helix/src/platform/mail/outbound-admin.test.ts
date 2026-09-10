import type { Actor } from "@helix/sdk-types";
import fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerOutboundMailAdminRoutes } from "./outbound-admin.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const id = "33333333-3333-4333-8333-333333333333";
const admin: Actor = {
  id: "11111111-1111-4111-8111-111111111111",
  orgId,
  type: "user",
  displayName: "Admin",
  scopes: ["admin.console.write"],
};
const journal = {
  enabled: false,
  retentionDays: 2555,
  entryCount: 0,
  lastJournaledAt: null,
  updatedAt: null,
};

describe("outbound dead-letter admin", () => {
  it("write-gates, tenant-scopes, and audits replay", async () => {
    let actor: Actor = { ...admin, scopes: ["admin.console.read"] };
    const replayOutbound = vi.fn().mockResolvedValue({ id });
    const append = vi.fn().mockResolvedValue({ id: "audit", thisHash: "hash" });
    const app = fastify();
    registerOutboundMailAdminRoutes(app, {
      store: {
        listDeadLetteredOutbound: async () => [],
        replayOutbound,
        getJournalSettings: async () => journal,
        setJournalSettings: async () => journal,
      },
      deliveryStore: {
        listEvents: async () => [],
        listSuppressions: async () => [],
        removeSuppression: async () => false,
      },
      actorFromRequest: () => actor,
      auditSink: { append },
    });
    await app.ready();

    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/admin/mail/outbound/${id}/replay`,
          payload: { reason: "provider recovered" },
        })
      ).statusCode,
    ).toBe(403);
    actor = admin;
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/admin/mail/outbound/${id}/replay`,
          payload: { reason: "provider recovered" },
        })
      ).statusCode,
    ).toBe(200);
    expect(replayOutbound).toHaveBeenCalledWith({ orgId, id });
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({ verb: "mail.outbound.replayed", objectId: id }),
    );
    await app.close();
  });

  it("restricts suppression diagnostics and audits a reasoned removal", async () => {
    let actor: Actor = { ...admin, scopes: [] };
    const removeSuppression = vi.fn().mockResolvedValue(true);
    const append = vi.fn().mockResolvedValue({ id: "audit", thisHash: "hash" });
    const app = fastify();
    registerOutboundMailAdminRoutes(app, {
      store: {
        listDeadLetteredOutbound: async () => [],
        replayOutbound: async () => null,
        getJournalSettings: async () => journal,
        setJournalSettings: async () => journal,
      },
      deliveryStore: {
        listEvents: async () => [],
        listSuppressions: async () => [],
        removeSuppression,
      },
      actorFromRequest: () => actor,
      auditSink: { append },
    });
    await app.ready();
    expect(
      (await app.inject({ method: "GET", url: "/api/admin/mail/outbound/suppressions" }))
        .statusCode,
    ).toBe(403);
    actor = admin;
    const response = await app.inject({
      method: "DELETE",
      url: `/api/admin/mail/outbound/suppressions/${id}`,
      payload: { reason: "recipient confirmed recovery" },
    });
    expect(response.statusCode).toBe(200);
    expect(removeSuppression).toHaveBeenCalledWith({
      orgId,
      id,
      actorId: admin.id,
      reason: "recipient confirmed recovery",
    });
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({ verb: "mail.suppression.removed", objectId: id }),
    );
    await app.close();
  });

  it("write-gates and audits compliance journal settings", async () => {
    const setJournalSettings = vi.fn().mockResolvedValue({
      ...journal,
      enabled: true,
      retentionDays: 3650,
      updatedAt: new Date("2026-09-03T00:00:00Z"),
    });
    const append = vi.fn().mockResolvedValue({ id: "audit", thisHash: "hash" });
    const app = fastify();
    registerOutboundMailAdminRoutes(app, {
      store: {
        listDeadLetteredOutbound: async () => [],
        replayOutbound: async () => null,
        getJournalSettings: async () => journal,
        setJournalSettings,
      },
      deliveryStore: {
        listEvents: async () => [],
        listSuppressions: async () => [],
        removeSuppression: async () => false,
      },
      actorFromRequest: () => admin,
      auditSink: { append },
    });
    await app.ready();
    const response = await app.inject({
      method: "PUT",
      url: "/api/admin/mail/journal",
      payload: { enabled: true, retentionDays: 3650 },
    });
    expect(response.statusCode).toBe(200);
    expect(setJournalSettings).toHaveBeenCalledWith({
      orgId,
      actorId: admin.id,
      enabled: true,
      retentionDays: 3650,
    });
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({ verb: "mail.journal.updated", objectId: orgId }),
    );
    await app.close();
  });
});
