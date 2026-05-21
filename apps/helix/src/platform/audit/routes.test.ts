import fastify from "fastify";
import { describe, expect, it } from "vitest";
import { actorFromRequest } from "../../api/actor.js";
import {
  decodeAuditLogCursor,
  encodeAuditLogCursor,
  registerAuditLogAdminRoutes,
  type AuditLogRecord,
  type AuditLogStore,
  type ListAuditLogInput,
} from "./routes.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const actorId = "11111111-1111-4111-8111-111111111111";
const objectId = "33333333-3333-4333-8333-333333333333";

describe("admin audit log routes", () => {
  it("returns org-scoped audit records with filters and cursor pagination", async () => {
    const store = new FakeAuditLogStore([
      auditRecord("55555555-5555-4555-8555-555555555555", "2026-05-20T12:05:00.000Z"),
      auditRecord("44444444-4444-4444-8444-444444444444", "2026-05-20T12:04:00.000Z"),
      auditRecord("33333333-3333-4333-8333-333333333333", "2026-05-20T12:03:00.000Z"),
    ]);
    const cursor = encodeAuditLogCursor(
      auditRecord("66666666-6666-4666-8666-666666666666", "2026-05-20T12:06:00.000Z"),
    );
    const app = fastify();
    await registerAuditLogAdminRoutes(app, { store, actorFromRequest });

    const response = await app.inject({
      method: "GET",
      url: `/api/admin/audit-log?limit=2&verb=tool.invoked&objectType=tool&actorId=${actorId}&objectId=${objectId}&cursor=${cursor}`,
      headers: {
        "x-helix-actor-id": actorId,
        "x-helix-org-id": orgId,
        "x-helix-scopes": "admin.audit",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      records: [
        auditRecord("55555555-5555-4555-8555-555555555555", "2026-05-20T12:05:00.000Z"),
        auditRecord("44444444-4444-4444-8444-444444444444", "2026-05-20T12:04:00.000Z"),
      ],
      nextCursor: encodeAuditLogCursor(
        auditRecord("44444444-4444-4444-8444-444444444444", "2026-05-20T12:04:00.000Z"),
      ),
    });
    expect(store.calls).toHaveLength(1);
    expect(store.calls[0]).toMatchObject({
      orgId,
      actorId,
      limit: 3,
      objectId,
      objectType: "tool",
      verb: "tool.invoked",
    });
    expect(store.calls[0]?.cursor).toEqual(decodeAuditLogCursor(cursor));
  });

  it("requires admin audit scope", async () => {
    const app = fastify();
    await registerAuditLogAdminRoutes(app, {
      store: new FakeAuditLogStore([]),
      actorFromRequest,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/audit-log",
      headers: {
        "x-helix-actor-id": actorId,
        "x-helix-org-id": orgId,
        "x-helix-scopes": "admin.config.read",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: "Admin audit log permission denied.",
      requiredScope: "admin.audit",
    });
  });

  it("rejects malformed cursors before touching the store", async () => {
    const store = new FakeAuditLogStore([]);
    const app = fastify();
    await registerAuditLogAdminRoutes(app, { store, actorFromRequest });

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/audit-log?cursor=not-a-cursor",
      headers: {
        "x-helix-actor-id": actorId,
        "x-helix-org-id": orgId,
        "x-helix-scopes": "admin.*",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Invalid audit log cursor." });
    expect(store.calls).toEqual([]);
  });
});

class FakeAuditLogStore implements AuditLogStore {
  readonly calls: ListAuditLogInput[] = [];

  constructor(private readonly records: readonly AuditLogRecord[]) {}

  async listRecords(input: ListAuditLogInput): Promise<readonly AuditLogRecord[]> {
    this.calls.push(input);
    return this.records;
  }
}

function auditRecord(id: string, createdAt: string): AuditLogRecord {
  return {
    id,
    orgId,
    actorId,
    verb: "tool.invoked",
    objectType: "tool",
    objectId,
    traceId: "trace-1",
    payload: { toolId: "mail.send" },
    prevHash: null,
    thisHash: `${id}-hash`,
    createdAt,
  };
}
