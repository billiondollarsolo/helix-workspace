import { randomUUID } from "node:crypto";
import type { Actor } from "@helix/sdk";
import fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
  crownJewelActionFor,
  crownJewelRequestFingerprint,
  installCrownJewelGate,
  type ApprovalDecision,
  type ConsumeDecision,
  type CrownJewelAction,
  type CrownJewelApproval,
  type CrownJewelApprovalStore,
} from "./crown-jewel.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const requesterId = "11111111-1111-4111-8111-111111111111";
const approverId = "33333333-3333-4333-8333-333333333333";
const unprivilegedId = "44444444-4444-4444-8444-444444444444";

describe("crown-jewel gate", () => {
  it("classifies irreversible routes in one policy table", () => {
    expect(action("POST", "/api/admin/tenants/acme/delete")).toBe("tenant.delete");
    expect(action("POST", "/api/admin/domains/domain-id/primary")).toBe("domain.takeover");
    expect(action("DELETE", "/api/admin/identity/idp-configs/idp-id")).toBe(
      "identity.idp.takeover",
    );
    expect(action("POST", "/api/admin/mail/domains/domain-id/dkim")).toBe("key.rotate");
    expect(action("POST", "/api/admin/mail/domains/domain-id/dkim/key-id/activate")).toBe(
      "key.rotate",
    );
    expect(action("POST", "/api/admin/vault/holds/hold-id/release")).toBe("retention.hold.release");
    expect(action("POST", "/api/admin/security/break-glass/grants")).toBe("iam.break_glass.grant");
    expect(action("POST", "/api/admin/users/user-id/mfa/reset")).toBe("identity.mfa.reset");
    expect(action("POST", "/api/admin/plugins/plugin.example/install")).toBe("plugin.trust");
    expect(action("POST", "/api/tools/agent.credentials.create")).toBe("credential.issue");
    expect(action("POST", "/api/tools/agent.credentials.rotate")).toBe("key.rotate");
    expect(action("GET", "/api/admin/domains")).toBeNull();
    // Restore already has a durable two-approver workflow; never double-gate it.
    expect(action("POST", "/api/admin/restores")).toBeNull();
  });

  it("canonicalizes body keys and query ordering in the approval fingerprint", () => {
    const left = crownJewelRequestFingerprint({
      method: "POST",
      url: "/api/admin/tenants/acme/delete?b=2&a=1",
      body: { z: 1, a: { y: true, x: false } },
    });
    const right = crownJewelRequestFingerprint({
      method: "POST",
      url: "/api/admin/tenants/acme/delete?a=1&b=2",
      body: { a: { x: false, y: true }, z: 1 },
    });
    expect(left).toBe(right);
  });

  it("requires fresh MFA, rejects self-approval, and consumes another admin's approval once", async () => {
    const harness = await createHarness();
    const stale = await mutate(harness.app, requesterId, false);
    expect(stale.statusCode).toBe(403);
    expect(harness.store.evidence.at(-1)).toMatchObject({ reason: "recent_mfa_required" });

    const requested = await mutate(harness.app, requesterId, true);
    expect(requested.statusCode).toBe(202);
    const approvalId = (requested.json() as { approval: { id: string } }).approval.id;
    expect(harness.executions).toBe(0);

    const staleApprover = await harness.app.inject({
      method: "POST",
      url: `/api/admin/crown-jewel-approvals/${approvalId}/approve`,
      headers: headers(approverId, false),
    });
    expect(staleApprover.statusCode).toBe(403);
    expect(harness.store.evidence.at(-1)).toMatchObject({
      reason: "approver_recent_mfa_required",
    });

    const selfApproval = await harness.app.inject({
      method: "POST",
      url: `/api/admin/crown-jewel-approvals/${approvalId}/approve`,
      headers: headers(requesterId, true),
    });
    expect(selfApproval.statusCode).toBe(409);
    expect(harness.store.evidence.at(-1)).toMatchObject({ reason: "self_approval" });

    const unprivileged = await harness.app.inject({
      method: "POST",
      url: `/api/admin/crown-jewel-approvals/${approvalId}/approve`,
      headers: headers(unprivilegedId, true),
    });
    expect(unprivileged.statusCode).toBe(403);
    expect(harness.store.evidence.at(-1)).toMatchObject({ reason: "approver_permission_denied" });

    const approved = await harness.app.inject({
      method: "POST",
      url: `/api/admin/crown-jewel-approvals/${approvalId}/approve`,
      headers: headers(approverId, true),
    });
    expect(approved.statusCode).toBe(200);

    const changedRequest = await mutate(harness.app, requesterId, true, approvalId, {
      reason: "different",
    });
    expect(changedRequest.statusCode).toBe(409);
    expect(changedRequest.json()).toMatchObject({ code: "crown_jewel_approval_mismatch" });

    const executed = await mutate(harness.app, requesterId, true, approvalId);
    expect(executed.statusCode).toBe(200);
    expect(harness.executions).toBe(1);
    expect(harness.store.evidence.map((entry) => entry.kind)).toContain("consumed");

    const replay = await mutate(harness.app, requesterId, true, approvalId);
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toMatchObject({ code: "crown_jewel_approval_already_consumed" });
    expect(harness.executions).toBe(1);
  });

  it("expires approvals and fails closed when durable evidence cannot be written", async () => {
    const harness = await createHarness();
    const requested = await mutate(harness.app, requesterId, true);
    const approvalId = (requested.json() as { approval: { id: string } }).approval.id;
    harness.clock.advance(61_000);
    const expired = await harness.app.inject({
      method: "POST",
      url: `/api/admin/crown-jewel-approvals/${approvalId}/approve`,
      headers: headers(approverId, true),
    });
    expect(expired.statusCode).toBe(409);

    harness.store.failWrites = true;
    const failed = await mutate(harness.app, requesterId, true);
    expect(failed.statusCode).toBe(500);
    expect(harness.executions).toBe(0);
  });
});

async function createHarness() {
  const app = fastify({ logger: false });
  const store = new MemoryApprovalStore();
  const clock = new TestClock();
  let executions = 0;
  installCrownJewelGate(app, {
    store,
    actorFromRequest: (request) => actor(String(request.headers["x-test-actor"])),
    mfa: { isMfaVerified: (request) => request.headers["x-test-mfa"] === "true" },
    approvalTtlMs: 60_000,
    now: () => clock.now(),
  });
  app.post("/api/admin/tenants/:slug/delete", () => {
    executions += 1;
    return { deleted: true };
  });
  await app.ready();
  return {
    app,
    store,
    clock,
    get executions() {
      return executions;
    },
  };
}

function mutate(
  app: ReturnType<typeof fastify>,
  actorId: string,
  mfa: boolean,
  approvalId?: string,
  payload: object = { reason: "requested" },
) {
  return app.inject({
    method: "POST",
    url: "/api/admin/tenants/acme/delete",
    headers: {
      ...headers(actorId, mfa),
      ...(approvalId === undefined ? {} : { "x-helix-crown-jewel-approval": approvalId }),
    },
    payload,
  });
}

function headers(actorId: string, mfa: boolean) {
  return { "x-test-actor": actorId, "x-test-mfa": String(mfa) };
}

function actor(id: string): Actor {
  return {
    id,
    orgId,
    type: "user",
    scopes: id === requesterId ? ["admin.tenants.delete"] : [],
    ...(id === approverId
      ? {
          roleBindings: [
            {
              roleId: "55555555-5555-4555-8555-555555555555",
              allow: ["admin.tenants.delete"],
              deny: [],
              scope: { type: "org" as const },
            },
          ],
        }
      : {}),
  };
}

function action(method: string, url: string): string | null {
  return crownJewelActionFor(method, url)?.id ?? null;
}

class TestClock {
  private milliseconds = Date.parse("2026-09-03T12:00:00.000Z");
  now() {
    return new Date(this.milliseconds);
  }
  advance(milliseconds: number) {
    this.milliseconds += milliseconds;
  }
}

class MemoryApprovalStore implements CrownJewelApprovalStore {
  readonly records = new Map<string, CrownJewelApproval>();
  readonly evidence: Record<string, unknown>[] = [];
  failWrites = false;

  async request(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly action: CrownJewelAction;
    readonly fingerprint: string;
    readonly expiresAt: Date;
  }) {
    this.assertWritable();
    const record: CrownJewelApproval = {
      id: randomUUID(),
      orgId: input.orgId,
      requesterActorId: input.actorId,
      actionId: input.action.id,
      permission: input.action.permission,
      fingerprint: input.fingerprint,
      status: "pending_confirmation",
      approvedByActorId: null,
      expiresAt: input.expiresAt,
      consumedAt: null,
    };
    this.records.set(record.id, record);
    this.evidence.push({ kind: "requested", approvalId: record.id });
    return record;
  }

  async get(targetOrgId: string, id: string) {
    const record = this.records.get(id);
    return record?.orgId === targetOrgId ? record : null;
  }

  async approve(input: {
    readonly orgId: string;
    readonly id: string;
    readonly actorId: string;
    readonly now: Date;
  }): Promise<ApprovalDecision> {
    this.assertWritable();
    const record = await this.get(input.orgId, input.id);
    if (record === null) return { kind: "not_found" };
    if (record.requesterActorId === input.actorId) {
      this.evidence.push({ kind: "rejected", reason: "self_approval" });
      return { kind: "self_approval" };
    }
    if (record.expiresAt <= input.now) return { kind: "expired" };
    if (record.status !== "pending_confirmation") return { kind: "not_pending" };
    const approval: CrownJewelApproval = {
      ...record,
      status: "confirmed",
      approvedByActorId: input.actorId,
    };
    this.records.set(record.id, approval);
    this.evidence.push({ kind: "approved", approvalId: record.id });
    return { kind: "approved", approval };
  }

  async consume(input: {
    readonly orgId: string;
    readonly id: string;
    readonly actorId: string;
    readonly fingerprint: string;
    readonly now: Date;
  }): Promise<ConsumeDecision> {
    this.assertWritable();
    const record = await this.get(input.orgId, input.id);
    if (record === null) return { kind: "not_found" };
    if (record.requesterActorId !== input.actorId || record.fingerprint !== input.fingerprint)
      return { kind: "mismatch" };
    if (record.expiresAt <= input.now) return { kind: "expired" };
    if (record.consumedAt !== null) return { kind: "already_consumed" };
    if (record.status !== "confirmed") return { kind: "pending" };
    const approval = { ...record, consumedAt: input.now };
    this.records.set(record.id, approval);
    this.evidence.push({ kind: "consumed", approvalId: record.id });
    return { kind: "consumed", approval };
  }

  async reject(input: { readonly reason: string }) {
    this.assertWritable();
    this.evidence.push({ kind: "rejected", reason: input.reason });
  }

  private assertWritable() {
    if (this.failWrites) throw new Error("durable evidence unavailable");
  }
}
