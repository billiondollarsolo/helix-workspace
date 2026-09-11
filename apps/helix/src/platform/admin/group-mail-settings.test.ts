import type { Actor } from "@helix/sdk-types";
import fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { InMemoryGroupsStore, registerAdminGroupsRoutes } from "./groups.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const actor: Actor = {
  id: "11111111-1111-4111-8111-111111111111",
  orgId,
  type: "user",
  scopes: ["admin.groups"],
};
async function fixture(principal = actor) {
  const store = new InMemoryGroupsStore();
  const app = fastify();
  const append = vi.fn(async () => ({ id: "audit", thisHash: "hash" }));
  await registerAdminGroupsRoutes(app, {
    store,
    actorFromRequest: () => principal,
    auditSink: { append },
  });
  return { app, store, append };
}

describe("group Mail settings", () => {
  it("defaults to workspace posting and preserves explicit policy across unrelated edits", async () => {
    const { app, append } = await fixture();
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/admin/groups",
        payload: { name: "Team", kind: "mailing_list", email: "team@example.test" },
      });
      expect(created.statusCode).toBe(201);
      const { group } = created.json<{ group: { id: string; postingPolicy: string } }>();
      expect(group.postingPolicy).toBe("organization");
      const url = `/api/admin/groups/${group.id}`;
      const changed = await app.inject({
        method: "PATCH",
        url,
        payload: { postingPolicy: "anyone" },
      });
      expect(changed.statusCode).toBe(200);
      expect(changed.json<{ group: { postingPolicy: string } }>().group.postingPolicy).toBe(
        "anyone",
      );
      await app.inject({ method: "PATCH", url, payload: { name: "Renamed" } });
      const listed = await app.inject({ method: "GET", url: "/api/admin/groups" });
      expect(listed.json<{ groups: { postingPolicy: string }[] }>().groups[0]?.postingPolicy).toBe(
        "anyone",
      );
      expect(
        (await app.inject({ method: "PATCH", url, payload: { postingPolicy: "external" } }))
          .statusCode,
      ).toBe(400);
      expect(append).toHaveBeenCalledTimes(3);
    } finally {
      await app.close();
    }
  });
  it("lets delegated group administrators fetch only tenant domain choices without mailbox scopes", async () => {
    const { app, store } = await fixture();
    const eligible = vi
      .spyOn(store, "eligibleDomains")
      .mockResolvedValue([{ domain: "example.test", primary: true, aliases: true }]);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/admin/groups/eligible-domains",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        eligibleDomains: [{ domain: "example.test", primary: true, aliases: true }],
      });
      expect(eligible).toHaveBeenCalledWith(orgId);
    } finally {
      await app.close();
    }
    const denied = await fixture({ ...actor, scopes: ["mail.read"] });
    const lookup = vi.spyOn(denied.store, "eligibleDomains");
    try {
      expect(
        (await denied.app.inject({ method: "GET", url: "/api/admin/groups/eligible-domains" }))
          .statusCode,
      ).toBe(403);
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      await denied.app.close();
    }
  });
});
