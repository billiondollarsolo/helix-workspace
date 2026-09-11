import type { Actor } from "@helix/sdk-types";
import fastify from "fastify";
import { expect, it, vi } from "vitest";
import { registerUserAddressRoutes } from "./user-address-routes.js";

const actor: Actor = {
  id: "b7500000-0000-4000-8000-000000000001",
  orgId: "b7500000-0000-4000-8000-000000000002",
  type: "user",
  scopes: ["admin.users", "mail.read"],
};
const aliasId = "b7500000-0000-4000-8000-000000000003";
const view = {
  actorId: actor.id,
  primaryEmail: "member@example.test",
  loginEmail: "member@example.test",
  addresses: [],
  eligibleDomains: [],
};
function fixture(principal = actor) {
  const app = fastify();
  const store = {
    get: vi.fn(async () => view),
    create: vi.fn(async () => view),
    update: vi.fn(async () => view),
    remove: vi.fn(async () => view),
    setPrimary: vi.fn(async () => view),
  };
  const auditSink = { append: vi.fn(async () => ({ id: "audit", thisHash: "hash" })) };
  registerUserAddressRoutes(app, { store, auditSink, actorFromRequest: () => principal });
  return { app, store, auditSink };
}

it("exposes only the authenticated user's sending identities and enforces the mail permission", async () => {
  for (const scopes of [["mail.read"], []]) {
    const { app, store } = fixture({ ...actor, scopes });
    try {
      const response = await app.inject("/api/mail/addresses");
      expect(response.statusCode).toBe(scopes.length ? 200 : 403);
      if (scopes.length) expect(store.get).toHaveBeenCalledWith(actor.orgId, actor.id);
      else expect(store.get).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  }
});

it.each([
  ["POST", "", { address: " alternate@second.test ", sendAsEnabled: false }, "create"],
  ["PATCH", `/${aliasId}`, { receiveEnabled: false }, "update"],
  ["DELETE", `/${aliasId}`, undefined, "remove"],
  ["PUT", "/primary", { address: "primary@second.test" }, "setPrimary"],
] as const)(
  "authorizes, scopes, and audits %s address changes",
  async (method, suffix, payload, action) => {
    const { app, store, auditSink } = fixture();
    try {
      const response = await app.inject({
        method,
        url: `/api/admin/users/${actor.id}/addresses${suffix}`,
        ...(payload === undefined ? {} : { payload }),
      });
      expect(response.statusCode).toBe(method === "POST" ? 201 : 200);
      expect(store[action]).toHaveBeenCalled();
      expect(store[action].mock.calls[0]?.slice(0, 2)).toEqual([actor.orgId, actor.id]);
      expect(auditSink.append).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: actor.orgId,
          actorId: actor.id,
          objectId: actor.id,
          verb: `user.address.${action}`,
        }),
      );
    } finally {
      await app.close();
    }
  },
);

it.each([
  { scopes: [] },
  { scopes: ["admin.console.read"] },
  {
    scopes: ["admin.*"],
    roleBindings: [
      { roleId: "denied", allow: [], deny: ["admin.users"], scope: { type: "org" as const } },
    ],
  },
])("rejects unauthorized or explicitly denied address changes %j", async (permissions) => {
  const { app, store, auditSink } = fixture({ ...actor, ...permissions });
  try {
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/admin/users/${actor.id}/addresses`,
          payload: { address: "alias@example.test" },
        })
      ).statusCode,
    ).toBe(403);
    expect(store.create).not.toHaveBeenCalled();
    expect(auditSink.append).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it.each([
  { address: "alias@example.test", orgId: actor.orgId },
  { address: "alias@example.test", actorId: actor.id },
  { address: "alias@example.test", isPrimary: true },
  { address: "alias@example.test", sendAsEnabled: "yes" },
])("rejects security-sensitive or malformed address input %j", async (payload) => {
  const { app, store } = fixture();
  try {
    expect(
      (await app.inject({ method: "POST", url: `/api/admin/users/${actor.id}/addresses`, payload }))
        .statusCode,
    ).toBe(400);
    expect(store.create).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
