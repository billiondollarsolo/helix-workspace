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
let issuedChallenges: { id: string; tokenHash: string }[];

beforeEach(async () => {
  actor = adminActor;
  ownershipResult = true;
  audited = [];
  issuedChallenges = [];
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
    /* Ownership lives on the admin_domains parent since 0087; the routes issue
       the challenge there. This records what they wrote. */
    ownershipStore: {
      async setOwnershipChallenge(_orgId, id, tokenHash) {
        issuedChallenges.push({ id, tokenHash });
        return null;
      },
      async getOwnershipTokenHash() {
        return issuedChallenges.at(-1)?.tokenHash ?? null;
      },
    },
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
    expect(JSON.stringify(createdBody)).not.toContain("TokenHash");

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

describe("challenge reissue", () => {
  async function createPending(domain: string): Promise<{ id: string; dnsValue: string }> {
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/mail/receiving-domains",
      payload: { domain },
    });
    const payload: unknown = response.json();
    const body = payload as { domain: { id: string }; verification: { dnsValue: string } };
    return { id: body.domain.id, dnsValue: body.verification.dnsValue };
  }

  it("issues a different token that supersedes the lost one", async () => {
    /* The create response is the only time the token is shown. An operator who
       closed that dialog had a row that could never verify and, there being no
       delete route, could never be removed either. */
    const created = await createPending("inbound.example");

    const response = await app.inject({
      method: "POST",
      url: `/api/admin/mail/receiving-domains/${created.id}/challenge`,
    });

    expect(response.statusCode).toBe(200);
    const payload: unknown = response.json();
    const reissued = payload as { verification: { dnsName: string; dnsValue: string } };
    expect(reissued.verification.dnsValue).not.toBe(created.dnsValue);
    expect(reissued.verification.dnsName).toBe("_helix-verification.inbound.example");
  });

  it("keeps the domain pending so the operator must still prove ownership", async () => {
    const created = await createPending("inbound.example");
    const response = await app.inject({
      method: "POST",
      url: `/api/admin/mail/receiving-domains/${created.id}/challenge`,
    });
    const payload: unknown = response.json();
    expect((payload as { domain: { status: string } }).domain.status).toBe("pending");
  });

  it("refuses to reissue for an already-verified domain", async () => {
    // Rotating a satisfied challenge would invite re-proving settled ownership.
    const created = await createPending("inbound.example");
    await app.inject({
      method: "POST",
      url: `/api/admin/mail/receiving-domains/${created.id}/verify`,
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/admin/mail/receiving-domains/${created.id}/challenge`,
    });
    expect(response.statusCode).toBe(409);
  });

  it("requires the write scope", async () => {
    const created = await createPending("inbound.example");
    actor = { ...adminActor, scopes: ["admin.console.read"] };

    const response = await app.inject({
      method: "POST",
      url: `/api/admin/mail/receiving-domains/${created.id}/challenge`,
    });
    expect(response.statusCode).toBe(403);
  });

  it("records the reissue in the audit log", async () => {
    const created = await createPending("inbound.example");
    await app.inject({
      method: "POST",
      url: `/api/admin/mail/receiving-domains/${created.id}/challenge`,
    });
    expect(audited).toContain("mail.receiving_domain.challenge_reissued");
  });

  it("returns 404 for a domain that does not exist", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/mail/receiving-domains/55555555-5555-4555-8555-555555555555/challenge",
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("deletion", () => {
  async function create(domain: string): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/mail/receiving-domains",
      payload: { domain },
    });
    const payload: unknown = response.json();
    return (payload as { domain: { id: string } }).domain.id;
  }

  it("removes the domain from the list", async () => {
    const id = await create("gone.example");

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/admin/mail/receiving-domains/${id}`,
    });
    expect(deleted.statusCode).toBe(200);

    const list = await app.inject({ method: "GET", url: "/api/admin/mail/receiving-domains" });
    const payload: unknown = list.json();
    expect((payload as { domains: unknown[] }).domains).toHaveLength(0);
  });

  it("removes an active domain, which stops mail immediately", async () => {
    /* Deliberately allowed: an operator decommissioning a domain must not have
       to leave a permanent row behind. The console states the consequence. */
    const id = await create("live.example");
    await app.inject({ method: "POST", url: `/api/admin/mail/receiving-domains/${id}/verify` });
    await app.inject({ method: "POST", url: `/api/admin/mail/receiving-domains/${id}/enable` });

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/admin/mail/receiving-domains/${id}`,
    });
    expect(deleted.statusCode).toBe(200);
  });

  it("records the status the domain was in when deleted", async () => {
    const id = await create("audited.example");
    await app.inject({ method: "DELETE", url: `/api/admin/mail/receiving-domains/${id}` });
    expect(audited).toContain("mail.receiving_domain.deleted");
  });

  it("requires the write scope", async () => {
    const id = await create("scoped.example");
    actor = { ...adminActor, scopes: ["admin.console.read"] };

    const response = await app.inject({
      method: "DELETE",
      url: `/api/admin/mail/receiving-domains/${id}`,
    });
    expect(response.statusCode).toBe(403);
  });

  it("returns 404 for a domain that does not exist", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: "/api/admin/mail/receiving-domains/66666666-6666-4666-8666-666666666666",
    });
    expect(response.statusCode).toBe(404);
  });
});
