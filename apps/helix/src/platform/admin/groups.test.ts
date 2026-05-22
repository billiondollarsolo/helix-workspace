import fastify from "fastify";
import { describe, expect, it } from "vitest";
import { actorFromRequest } from "../../api/actor.js";
import { InMemoryGroupsStore, registerAdminGroupsRoutes } from "./groups.js";
import type { AdminConsoleAuditSink } from "./console-shared.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const actorId = "11111111-1111-4111-8111-111111111111";

function headers(scopes: string): Record<string, string> {
  return {
    "x-helix-actor-id": actorId,
    "x-helix-org-id": orgId,
    "x-helix-scopes": scopes,
  };
}

/** Typed JSON body accessor — fastify's inject `.json()` is untyped `any`. */
function body(response: { json: () => unknown }): Record<string, unknown> {
  return response.json() as Record<string, unknown>;
}

function field(response: { json: () => unknown }, key: string): unknown {
  return body(response)[key];
}

class RecordingAuditSink implements AdminConsoleAuditSink {
  readonly records: { verb: string; objectType: string }[] = [];

  async append(record: {
    readonly orgId: string;
    readonly actorId: string;
    readonly verb: string;
    readonly objectType: string;
  }): Promise<{ readonly id: string; readonly thisHash: string }> {
    this.records.push({ verb: record.verb, objectType: record.objectType });
    return { id: "audit-1", thisHash: "hash-1" };
  }
}

async function buildApp(options?: { auditSink?: AdminConsoleAuditSink }) {
  const store = new InMemoryGroupsStore();
  const app = fastify();
  await registerAdminGroupsRoutes(app, {
    store,
    actorFromRequest,
    ...(options?.auditSink === undefined ? {} : { auditSink: options.auditSink }),
  });
  return { app, store };
}

describe("admin org units", () => {
  it("creates a tree of org units with computed paths and child counts", async () => {
    const { app } = await buildApp();

    const root = await app.inject({
      method: "POST",
      url: "/api/admin/org-units",
      headers: headers("admin.console.write"),
      payload: { name: "Engineering", description: "Eng org" },
    });
    expect(root.statusCode).toBe(201);
    const rootUnit = (field(root, "orgUnit") as { id: string; path: string });
    expect(rootUnit.path).toBe("Engineering");

    const child = await app.inject({
      method: "POST",
      url: "/api/admin/org-units",
      headers: headers("admin.console.write"),
      payload: { name: "Platform", parentId: rootUnit.id },
    });
    expect(child.statusCode).toBe(201);
    expect((field(child, "orgUnit") as { path: string }).path).toBe("Engineering > Platform");

    const list = await app.inject({
      method: "GET",
      url: "/api/admin/org-units",
      headers: headers("admin.console.read"),
    });
    expect(list.statusCode).toBe(200);
    const units = (field(list, "orgUnits") as { name: string; childCount: number }[]);
    expect(units.map((unit) => unit.name)).toEqual(["Engineering", "Platform"]);
    expect(units.find((unit) => unit.name === "Engineering")?.childCount).toBe(1);
  });

  it("rejects duplicate org unit names at the same level with 409", async () => {
    const { app } = await buildApp();
    await app.inject({
      method: "POST",
      url: "/api/admin/org-units",
      headers: headers("admin.console.write"),
      payload: { name: "Design" },
    });
    const dup = await app.inject({
      method: "POST",
      url: "/api/admin/org-units",
      headers: headers("admin.console.write"),
      payload: { name: "design" },
    });
    expect(dup.statusCode).toBe(409);
    expect(body(dup).code).toBe("conflict");
  });

  it("refuses to delete an org unit that still has children", async () => {
    const { app } = await buildApp();
    const root = await app.inject({
      method: "POST",
      url: "/api/admin/org-units",
      headers: headers("admin.console.write"),
      payload: { name: "Sales" },
    });
    const rootId = (field(root, "orgUnit") as { id: string }).id;
    await app.inject({
      method: "POST",
      url: "/api/admin/org-units",
      headers: headers("admin.console.write"),
      payload: { name: "West", parentId: rootId },
    });
    const del = await app.inject({
      method: "DELETE",
      url: `/api/admin/org-units/${rootId}`,
      headers: headers("admin.console.write"),
    });
    expect(del.statusCode).toBe(409);
  });

  it("requires the write scope for mutations", async () => {
    const { app } = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/org-units",
      headers: headers("admin.console.read"),
      payload: { name: "Ops" },
    });
    expect(response.statusCode).toBe(403);
    expect(body(response).requiredScope).toBe("admin.console.write");
  });
});

describe("admin groups and membership", () => {
  it("creates a group, adds members, and counts membership", async () => {
    const audit = new RecordingAuditSink();
    const { app } = await buildApp({ auditSink: audit });

    const created = await app.inject({
      method: "POST",
      url: "/api/admin/groups",
      headers: headers("admin.console.write"),
      payload: { name: "Leads", email: "leads@helix.io", kind: "mailing_list" },
    });
    expect(created.statusCode).toBe(201);
    const groupId = (field(created, "group") as { id: string }).id;

    const memberId = "33333333-3333-4333-8333-333333333333";
    const added = await app.inject({
      method: "POST",
      url: `/api/admin/groups/${groupId}/members`,
      headers: headers("admin.console.write"),
      payload: { actorId: memberId, role: "manager" },
    });
    expect(added.statusCode).toBe(201);
    expect((field(added, "member") as { role: string }).role).toBe("manager");

    const dup = await app.inject({
      method: "POST",
      url: `/api/admin/groups/${groupId}/members`,
      headers: headers("admin.console.write"),
      payload: { actorId: memberId },
    });
    expect(dup.statusCode).toBe(409);

    const groups = await app.inject({
      method: "GET",
      url: "/api/admin/groups",
      headers: headers("admin.console.read"),
    });
    expect((field(groups, "groups") as { memberCount: number }[])[0]?.memberCount).toBe(1);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/admin/groups/${groupId}/members/${memberId}`,
      headers: headers("admin.console.write"),
    });
    expect(removed.statusCode).toBe(200);
    expect(body(removed).status).toBe("removed");

    expect(audit.records.map((record) => record.verb)).toEqual([
      "admin.group.created",
      "admin.group.member_added",
      "admin.group.member_removed",
    ]);
  });

  it("returns 404 for membership operations on an unknown group", async () => {
    const { app } = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/groups/44444444-4444-4444-8444-444444444444/members",
      headers: headers("admin.console.write"),
      payload: { actorId: "55555555-5555-4555-8555-555555555555" },
    });
    expect(response.statusCode).toBe(404);
    expect(body(response).code).toBe("not_found");
  });

  it("honors the legacy admin.* scope for reads", async () => {
    const { app } = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/admin/groups",
      headers: headers("admin.*"),
    });
    expect(response.statusCode).toBe(200);
  });
});

describe("InMemoryGroupsStore", () => {
  it("updates org unit fields and rejects self-parenting", async () => {
    const store = new InMemoryGroupsStore();
    const unit = await store.createOrgUnit({
      orgId,
      parentId: null,
      name: "Marketing",
      description: "",
      createdBy: actorId,
    });
    const updated = await store.updateOrgUnit({
      orgId,
      id: unit.id,
      name: "Growth",
    });
    expect(updated?.name).toBe("Growth");
    await expect(
      store.updateOrgUnit({ orgId, id: unit.id, parentId: unit.id }),
    ).rejects.toThrow(/own parent/u);
  });

  it("isolates records by org", async () => {
    const store = new InMemoryGroupsStore();
    await store.createGroup({
      orgId,
      name: "Alpha",
      email: null,
      kind: "group",
      description: "",
      orgUnitId: null,
      createdBy: actorId,
    });
    const otherOrg = await store.listGroups("99999999-9999-4999-8999-999999999999");
    expect(otherOrg).toEqual([]);
  });
});
