import fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerDriveScanAdminRoutes } from "./scan-admin.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const objectId = "33333333-3333-4333-8333-333333333333";

describe("Drive scan admin retry override", () => {
  it("requires admin authority and an explicit reason", async () => {
    const app = fastify();
    const retryDeadLetteredVirusScan = vi.fn(async () => true);
    await registerDriveScanAdminRoutes(app, {
      store: { retryDeadLetteredVirusScan },
      actorFromRequest: () => ({ id: actorId, orgId, type: "user", displayName: "User" }),
      auditSink: { append: async () => ({ id: "audit", thisHash: "hash" }) },
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/admin/drive/scans/${objectId}/retry`,
          payload: { reason: "scanner recovered" },
        })
      ).statusCode,
    ).toBe(403);
    expect(retryDeadLetteredVirusScan).not.toHaveBeenCalled();
    await app.close();
  });

  it("reopens only a tenant DLQ job and writes the central audit trail", async () => {
    const app = fastify();
    const retryDeadLetteredVirusScan = vi.fn(async () => true);
    const append = vi.fn(async () => ({ id: "audit-1", thisHash: "hash" }));
    await registerDriveScanAdminRoutes(app, {
      store: { retryDeadLetteredVirusScan },
      actorFromRequest: () => ({
        id: actorId,
        orgId,
        type: "user",
        displayName: "Admin",
        scopes: ["admin.console.write"],
      }),
      auditSink: { append },
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/admin/drive/scans/${objectId}/retry`,
      payload: { reason: "ClamAV signatures refreshed after outage" },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ objectId, status: "scan_pending" });
    expect(retryDeadLetteredVirusScan).toHaveBeenCalledWith({
      orgId,
      objectId,
      actorId,
      reason: "ClamAV signatures refreshed after outage",
    });
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        verb: "admin.drive.scan_retry_overridden",
        objectId,
      }),
    );
    await app.close();
  });
});
