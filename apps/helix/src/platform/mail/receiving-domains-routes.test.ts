import type { Actor } from "@helix/sdk-types";
import fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerReceivingDomainAdminRoutes } from "./receiving-domains-routes.js";
import { InMemoryReceivingDomainStore } from "./receiving-domains-store.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const actorId = "11111111-1111-4111-8111-111111111111";
const otherActorId = "33333333-3333-4333-8333-333333333333";

const adminActor: Actor = {
  id: actorId,
  orgId,
  type: "user",
  displayName: "Admin",
  scopes: ["admin.console.write"],
};

let app: FastifyInstance;
let actor: Actor;
let ownershipResult: boolean | Error;
let audited: string[];

beforeEach(async () => {
  actor = adminActor;
  ownershipResult = true;
  audited = [];
  app = fastify();
  await registerReceivingDomainAdminRoutes(app, {
    store: new InMemoryReceivingDomainStore({
      actors: [
        { id: actorId, orgId, email: "admin@example.com" },
        {
          id: otherActorId,
          orgId: "44444444-4444-4444-8444-444444444444",
          email: "other@other.example",
        },
      ],
    }),
    actorFromRequest: () => actor,
    ownershipVerifier: {
      async verify() {
        if (ownershipResult instanceof Error) {
          throw ownershipResult;
        }
        return ownershipResult;
      },
    },
    auditSink: {
      async append(record) {
        audited.push(record.verb);
        return { id: "audit-id", thisHash: "audit-hash" };
      },
    },
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe("receiving-domain admin routes", () => {
  it("creates, verifies, enables, lists, and disables with an audit for every operation", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/admin/mail/receiving-domains",
      payload: { domain: "BÜCHER.example", catchAllActorId: actorId },
    });
    expect(created.statusCode).toBe(201);
    const createdBody = created.json<{
      domain: { id: string; domain: string; status: string };
      verification: { dnsName: string; dnsValue: string };
    }>();
    expect(createdBody.domain).toMatchObject({
      domain: "xn--bcher-kva.example",
      status: "pending",
    });
    expect(createdBody.verification.dnsName).toBe("_helix-verification.xn--bcher-kva.example");
    expect(createdBody.verification.dnsValue).toMatch(/^helix-domain-verification=/u);
    expect(JSON.stringify(createdBody)).not.toContain("verificationTokenHash");

    const verified = await app.inject({
      method: "POST",
      url: `/api/admin/mail/receiving-domains/${createdBody.domain.id}/verify`,
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.json<{ domain: { status: string } }>().domain.status).toBe("verified");

    const enabled = await app.inject({
      method: "POST",
      url: `/api/admin/mail/receiving-domains/${createdBody.domain.id}/enable`,
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json<{ domain: { status: string } }>().domain.status).toBe("active");

    const listed = await app.inject({
      method: "GET",
      url: "/api/admin/mail/receiving-domains",
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ domains: readonly unknown[] }>().domains).toHaveLength(1);

    const disabled = await app.inject({
      method: "POST",
      url: `/api/admin/mail/receiving-domains/${createdBody.domain.id}/disable`,
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json<{ domain: { status: string } }>().domain.status).toBe("disabled");
    expect(audited).toEqual([
      "mail.receiving_domain.created",
      "mail.receiving_domain.verified",
      "mail.receiving_domain.enabled",
      "mail.receiving_domain.listed",
      "mail.receiving_domain.disabled",
    ]);
  });

  it("does not mark a domain verified until the DNS proof is observed", async () => {
    ownershipResult = false;
    const created = await app.inject({
      method: "POST",
      url: "/api/admin/mail/receiving-domains",
      payload: { domain: "example.com" },
    });
    const id = created.json<{ domain: { id: string } }>().domain.id;
    const verify = await app.inject({
      method: "POST",
      url: `/api/admin/mail/receiving-domains/${id}/verify`,
    });
    expect(verify.statusCode).toBe(409);

    const list = await app.inject({
      method: "GET",
      url: "/api/admin/mail/receiving-domains",
    });
    expect(list.json<{ domains: readonly { status: string }[] }>().domains[0]?.status).toBe(
      "pending",
    );
    expect(audited).not.toContain("mail.receiving_domain.verified");
  });

  it("requires a current DNS proof before re-enabling a disabled domain", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/admin/mail/receiving-domains",
      payload: { domain: "transferred.example" },
    });
    const id = created.json<{ domain: { id: string } }>().domain.id;
    await app.inject({
      method: "POST",
      url: `/api/admin/mail/receiving-domains/${id}/verify`,
    });
    await app.inject({
      method: "POST",
      url: `/api/admin/mail/receiving-domains/${id}/enable`,
    });
    await app.inject({
      method: "POST",
      url: `/api/admin/mail/receiving-domains/${id}/disable`,
    });

    ownershipResult = false;
    const staleEnable = await app.inject({
      method: "POST",
      url: `/api/admin/mail/receiving-domains/${id}/enable`,
    });

    expect(staleEnable.statusCode).toBe(409);
    expect(staleEnable.json()).toMatchObject({ code: "conflict" });
    const listed = await app.inject({ method: "GET", url: "/api/admin/mail/receiving-domains" });
    expect(listed.json<{ domains: readonly { status: string }[] }>().domains[0]?.status).toBe(
      "disabled",
    );
  });

  it("returns a retryable response when DNS verification is unavailable", async () => {
    ownershipResult = new Error("resolver timeout");
    const created = await app.inject({
      method: "POST",
      url: "/api/admin/mail/receiving-domains",
      payload: { domain: "example.com" },
    });
    const id = created.json<{ domain: { id: string } }>().domain.id;
    const verify = await app.inject({
      method: "POST",
      url: `/api/admin/mail/receiving-domains/${id}/verify`,
    });
    expect(verify.statusCode).toBe(503);
    expect(verify.json()).toMatchObject({ code: "service_unavailable" });
  });

  it("rejects cross-organization catch-all actors and unsafe domains", async () => {
    const crossOrg = await app.inject({
      method: "POST",
      url: "/api/admin/mail/receiving-domains",
      payload: { domain: "example.com", catchAllActorId: otherActorId },
    });
    expect(crossOrg.statusCode).toBe(400);

    const unsafe = await app.inject({
      method: "POST",
      url: "/api/admin/mail/receiving-domains",
      payload: { domain: "example..com" },
    });
    expect(unsafe.statusCode).toBe(400);
  });

  it("enforces read and write scopes", async () => {
    actor = { ...adminActor, scopes: ["admin.console.read"] };
    const deniedWrite = await app.inject({
      method: "POST",
      url: "/api/admin/mail/receiving-domains",
      payload: { domain: "example.com" },
    });
    expect(deniedWrite.statusCode).toBe(403);

    actor = { ...adminActor, scopes: ["mail.read"] };
    const deniedRead = await app.inject({
      method: "GET",
      url: "/api/admin/mail/receiving-domains",
    });
    expect(deniedRead.statusCode).toBe(403);
  });
});
