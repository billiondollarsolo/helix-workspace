import { createHash, randomUUID } from "node:crypto";
import type { Actor, JsonValue } from "@helix/sdk";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type postgres from "postgres";
import { z } from "zod";
import { actorHasScope } from "../../api/scopes.js";
import { canonicalJson } from "../audit/hash.js";
import type { MfaVerificationResolver } from "./mfa.js";

export interface CrownJewelAction {
  readonly id: string;
  readonly permission: string;
  readonly consoleWriteAlsoAllowed?: boolean;
}

const policies: readonly {
  readonly method: string;
  readonly path: RegExp;
  readonly action: CrownJewelAction;
}[] = [
  policy(
    "POST",
    /^\/api\/admin\/tenants\/[^/]+\/delete$/u,
    "tenant.delete",
    "admin.tenants.delete",
  ),
  policy(
    "POST",
    /^\/api\/admin\/domains\/[^/]+\/(?:primary|quarantine)$/u,
    "domain.takeover",
    "admin.domains",
    true,
  ),
  policy("DELETE", /^\/api\/admin\/domains\/[^/]+$/u, "domain.release", "admin.domains", true),
  policy(
    "POST",
    /^\/api\/admin\/domains\/primary-transitions\/[^/]+\/rollback$/u,
    "domain.takeover",
    "admin.domains",
    true,
  ),
  policy(
    "PATCH",
    /^\/api\/admin\/domains\/[^/]+\/capabilities$/u,
    "domain.takeover",
    "admin.domains",
    true,
  ),
  policy(
    "POST",
    /^\/api\/admin\/identity\/idp-configs$/u,
    "identity.idp.takeover",
    "admin.security",
    true,
  ),
  policy(
    "PATCH",
    /^\/api\/admin\/identity\/idp-configs\/[^/]+$/u,
    "identity.idp.takeover",
    "admin.security",
    true,
  ),
  policy(
    "DELETE",
    /^\/api\/admin\/identity\/idp-configs\/[^/]+$/u,
    "identity.idp.takeover",
    "admin.security",
    true,
  ),
  policy(
    "POST",
    /^\/api\/admin\/identity\/idp-configs\/[^/]+\/primary$/u,
    "identity.idp.takeover",
    "admin.security",
    true,
  ),
  policy(
    "POST",
    /^\/api\/admin\/mail\/domains\/[^/]+\/dkim(?:\/[^/]+\/(?:activate|retire))?$/u,
    "key.rotate",
    "mail.admin",
    true,
  ),
  policy(
    "POST",
    /^\/api\/tools\/webhook\.inbound\.rotate-secret$/u,
    "key.rotate",
    "admin.webhooks",
  ),
  policy(
    "POST",
    /^\/api\/admin\/(?:mail|drive|governance|vault)\/(?:retention-)?holds\/[^/]+\/(?:release|remove)$/u,
    "retention.hold.release",
    "admin.retention",
  ),
  policy(
    "DELETE",
    /^\/api\/admin\/(?:mail|drive|governance|vault)\/(?:retention-)?holds\/[^/]+$/u,
    "retention.hold.release",
    "admin.retention",
  ),
  policy(
    "POST",
    /^\/api\/admin\/(?:iam|security)\/break-glass(?:\/grants)?$/u,
    "iam.break_glass.grant",
    "admin.security",
  ),
  policy(
    "POST",
    /^\/api\/admin\/users\/[^/]+\/mfa\/reset$/u,
    "identity.mfa.reset",
    "admin.security",
  ),
  policy(
    "POST",
    /^\/api\/admin\/iam\/(?:role-)?bindings$/u,
    "iam.privileged_grant",
    "admin.security",
  ),
  policy(
    "POST",
    /^\/api\/admin\/plugins\/[^/]+\/(?:install|enable)$/u,
    "plugin.trust",
    "admin.plugins",
  ),
  policy("POST", /^\/api\/tools\/agent\.credentials\.create$/u, "credential.issue", "admin.agents"),
  policy("POST", /^\/api\/tools\/agent\.credentials\.rotate$/u, "key.rotate", "admin.agents"),
  policy("POST", /^\/api\/tools\/app\.passwords\.create$/u, "credential.issue", "admin.users"),
];

function policy(
  method: string,
  path: RegExp,
  id: string,
  permission: string,
  consoleWriteAlsoAllowed = false,
) {
  return {
    method,
    path,
    action: { id, permission, ...(consoleWriteAlsoAllowed ? { consoleWriteAlsoAllowed } : {}) },
  };
}

export function crownJewelActionFor(method: string, requestUrl: string): CrownJewelAction | null {
  const path = requestUrl.split("?")[0] ?? requestUrl;
  return (
    policies.find((candidate) => candidate.method === method && candidate.path.test(path))
      ?.action ?? null
  );
}

export function crownJewelRequestFingerprint(
  request: Pick<FastifyRequest, "method" | "url" | "body">,
): string {
  const url = new URL(request.url, "http://helix.invalid");
  url.searchParams.sort();
  const body = JSON.parse(JSON.stringify(request.body ?? null)) as JsonValue;
  return createHash("sha256")
    .update(canonicalJson({ method: request.method, path: `${url.pathname}${url.search}`, body }))
    .digest("hex");
}

export interface CrownJewelApproval {
  readonly id: string;
  readonly orgId: string;
  readonly requesterActorId: string;
  readonly actionId: string;
  readonly permission: string;
  readonly fingerprint: string;
  readonly status: "pending_confirmation" | "confirmed" | "cancelled" | "expired";
  readonly approvedByActorId: string | null;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
}

export type ApprovalDecision =
  | { readonly kind: "approved"; readonly approval: CrownJewelApproval }
  | { readonly kind: "not_found" | "self_approval" | "expired" | "not_pending" };

export type ConsumeDecision =
  | { readonly kind: "consumed"; readonly approval: CrownJewelApproval }
  | { readonly kind: "not_found" | "pending" | "expired" | "already_consumed" | "mismatch" };

export interface CrownJewelApprovalStore {
  request(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly action: CrownJewelAction;
    readonly fingerprint: string;
    readonly expiresAt: Date;
    readonly traceId?: string | undefined;
  }): Promise<CrownJewelApproval>;
  get(orgId: string, id: string): Promise<CrownJewelApproval | null>;
  approve(input: {
    readonly orgId: string;
    readonly id: string;
    readonly actorId: string;
    readonly now: Date;
    readonly traceId?: string | undefined;
  }): Promise<ApprovalDecision>;
  consume(input: {
    readonly orgId: string;
    readonly id: string;
    readonly actorId: string;
    readonly fingerprint: string;
    readonly now: Date;
    readonly traceId?: string | undefined;
  }): Promise<ConsumeDecision>;
  reject(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly actionId: string;
    readonly reason: string;
    readonly approvalId?: string | undefined;
    readonly traceId?: string | undefined;
  }): Promise<void>;
}

interface ApprovalRow {
  readonly id: string;
  readonly org_id: string;
  readonly actor_id: string;
  readonly tool_id: string;
  readonly input: { readonly fingerprint?: unknown; readonly permission?: unknown };
  readonly status: CrownJewelApproval["status"];
  readonly approved_by_actor_id: string | null;
  readonly expires_at: Date;
  readonly consumed_at: Date | null;
}

export class PostgresCrownJewelApprovalStore implements CrownJewelApprovalStore {
  constructor(private readonly sql: postgres.Sql) {}

  async request(
    input: Parameters<CrownJewelApprovalStore["request"]>[0],
  ): Promise<CrownJewelApproval> {
    const id = randomUUID();
    return this.sql.begin(async (tx) => {
      await setOrg(tx, input.orgId);
      const rows = await tx<ApprovalRow[]>`
        insert into pending_actions (
          id, org_id, actor_id, tool_id, input, approval_kind, status,
          expires_at, created_at, trace_id
        ) values (
          ${id}, ${input.orgId}, ${input.actorId}, ${`crown_jewel:${input.action.id}`},
          ${tx.json({ fingerprint: input.fingerprint, permission: input.action.permission })},
          'distinct_actor', 'pending_confirmation', ${input.expiresAt}, now(), ${input.traceId ?? null}
        )
        returning id, org_id, actor_id, tool_id, input, status, approved_by_actor_id, expires_at, consumed_at
      `;
      await appendEvidence(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "crown_jewel.approval.requested",
        approvalId: id,
        traceId: input.traceId,
        metadata: {
          actionId: input.action.id,
          fingerprint: input.fingerprint,
          expiresAt: input.expiresAt.toISOString(),
        },
      });
      return rowToApproval(requiredRow(rows));
    });
  }

  async get(orgId: string, id: string): Promise<CrownJewelApproval | null> {
    const rows = await this.sql<ApprovalRow[]>`
      select id, org_id, actor_id, tool_id, input, status, approved_by_actor_id, expires_at, consumed_at
      from pending_actions
      where org_id = ${orgId} and id = ${id} and approval_kind = 'distinct_actor'
      limit 1
    `;
    return rows[0] === undefined ? null : rowToApproval(rows[0]);
  }

  async approve(
    input: Parameters<CrownJewelApprovalStore["approve"]>[0],
  ): Promise<ApprovalDecision> {
    return this.sql.begin(async (tx) => {
      await setOrg(tx, input.orgId);
      const rows = await tx<ApprovalRow[]>`
        select id, org_id, actor_id, tool_id, input, status, approved_by_actor_id, expires_at, consumed_at
        from pending_actions
        where org_id = ${input.orgId} and id = ${input.id} and approval_kind = 'distinct_actor'
        for update
      `;
      const row = rows[0];
      if (row === undefined) return { kind: "not_found" };
      if (row.actor_id === input.actorId) {
        await appendEvidence(tx, rejectionEvidence(input, row, "self_approval"));
        return { kind: "self_approval" };
      }
      if (row.expires_at <= input.now) {
        await tx`update pending_actions set status = 'expired', decided_at = ${input.now} where id = ${row.id} and status = 'pending_confirmation'`;
        await appendEvidence(tx, rejectionEvidence(input, row, "expired"));
        return { kind: "expired" };
      }
      if (row.status !== "pending_confirmation") return { kind: "not_pending" };
      const updated = await tx<ApprovalRow[]>`
        update pending_actions
        set status = 'confirmed', approved_by_actor_id = ${input.actorId},
            approved_at = ${input.now}, decided_at = ${input.now}
        where id = ${row.id}
        returning id, org_id, actor_id, tool_id, input, status, approved_by_actor_id, expires_at, consumed_at
      `;
      await appendEvidence(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "crown_jewel.approval.approved",
        approvalId: row.id,
        traceId: input.traceId,
        metadata: { actionId: actionId(row), requesterActorId: row.actor_id },
      });
      return { kind: "approved", approval: rowToApproval(requiredRow(updated)) };
    });
  }

  async consume(
    input: Parameters<CrownJewelApprovalStore["consume"]>[0],
  ): Promise<ConsumeDecision> {
    return this.sql.begin(async (tx) => {
      await setOrg(tx, input.orgId);
      const rows = await tx<ApprovalRow[]>`
        select id, org_id, actor_id, tool_id, input, status, approved_by_actor_id, expires_at, consumed_at
        from pending_actions
        where org_id = ${input.orgId} and id = ${input.id} and approval_kind = 'distinct_actor'
        for update
      `;
      const row = rows[0];
      if (row === undefined) return { kind: "not_found" };
      if (row.actor_id !== input.actorId || row.input.fingerprint !== input.fingerprint)
        return { kind: "mismatch" };
      if (row.expires_at <= input.now) {
        await tx`update pending_actions set status = 'expired', decided_at = coalesce(decided_at, ${input.now}) where id = ${row.id} and consumed_at is null`;
        await appendEvidence(tx, rejectionEvidence(input, row, "expired"));
        return { kind: "expired" };
      }
      if (row.consumed_at !== null) return { kind: "already_consumed" };
      if (row.status !== "confirmed" || row.approved_by_actor_id === null)
        return { kind: "pending" };
      const updated = await tx<ApprovalRow[]>`
        update pending_actions set consumed_at = ${input.now}
        where id = ${row.id} and consumed_at is null
        returning id, org_id, actor_id, tool_id, input, status, approved_by_actor_id, expires_at, consumed_at
      `;
      await appendEvidence(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "crown_jewel.approval.consumed",
        approvalId: row.id,
        traceId: input.traceId,
        metadata: {
          actionId: actionId(row),
          approverActorId: row.approved_by_actor_id,
          fingerprint: input.fingerprint,
        },
      });
      return { kind: "consumed", approval: rowToApproval(requiredRow(updated)) };
    });
  }

  async reject(input: Parameters<CrownJewelApprovalStore["reject"]>[0]): Promise<void> {
    await this.sql.begin(async (tx) => {
      await setOrg(tx, input.orgId);
      await appendEvidence(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "crown_jewel.approval.rejected",
        approvalId: input.approvalId,
        traceId: input.traceId,
        metadata: { actionId: input.actionId, reason: input.reason },
      });
    });
  }
}

const approvedRequests = new WeakSet<FastifyRequest>();
export function requestHasCrownJewelApproval(request: FastifyRequest): boolean {
  return approvedRequests.has(request);
}

export interface CrownJewelGateOptions {
  readonly store: CrownJewelApprovalStore;
  readonly actorFromRequest: (request: FastifyRequest) => Promise<Actor> | Actor;
  readonly mfa: MfaVerificationResolver;
  readonly approvalTtlMs?: number;
  readonly now?: () => Date;
  readonly traceId?: (request: FastifyRequest) => string | undefined;
}

export function installCrownJewelGate(app: FastifyInstance, options: CrownJewelGateOptions): void {
  const now = options.now ?? (() => new Date());
  const traceId = options.traceId ?? (() => undefined);
  const ttlMs = options.approvalTtlMs ?? 10 * 60 * 1000;

  app.addHook("preHandler", async (request, reply) => {
    const action = crownJewelActionFor(request.method, request.url);
    if (action === null) return;
    const actor = await options.actorFromRequest(request);
    if (!canAuthorize(action, actor)) return;
    if (!(await options.mfa.isMfaVerified(request))) {
      await options.store.reject({
        orgId: actor.orgId,
        actorId: actor.id,
        actionId: action.id,
        reason: "recent_mfa_required",
        traceId: traceId(request),
      });
      return reply.code(403).send({
        code: "crown_jewel_step_up_required",
        error: "Recent MFA verification is required.",
      });
    }
    const approvalId = approvalIdHeader(request);
    const fingerprint = crownJewelRequestFingerprint(request);
    if (approvalId === null) {
      const createdAt = now();
      const approval = await options.store.request({
        orgId: actor.orgId,
        actorId: actor.id,
        action,
        fingerprint,
        expiresAt: new Date(createdAt.getTime() + ttlMs),
        traceId: traceId(request),
      });
      return reply
        .code(202)
        .send({ code: "crown_jewel_approval_required", approval: approvalView(approval) });
    }
    const result = await options.store.consume({
      orgId: actor.orgId,
      id: approvalId,
      actorId: actor.id,
      fingerprint,
      now: now(),
      traceId: traceId(request),
    });
    if (result.kind !== "consumed") {
      await options.store.reject({
        orgId: actor.orgId,
        actorId: actor.id,
        actionId: action.id,
        reason: result.kind,
        approvalId,
        traceId: traceId(request),
      });
      return reply.code(409).send({
        code: `crown_jewel_approval_${result.kind}`,
        error: "A matching, unexpired second-party approval is required.",
      });
    }
    approvedRequests.add(request);
  });

  app.post("/api/admin/crown-jewel-approvals/:id/approve", async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success)
      return reply.code(400).send({ code: "invalid_approval_id", error: "Invalid approval id." });
    const actor = await options.actorFromRequest(request);
    if (!(await options.mfa.isMfaVerified(request))) {
      await options.store.reject({
        orgId: actor.orgId,
        actorId: actor.id,
        actionId: "unknown",
        reason: "approver_recent_mfa_required",
        approvalId: params.data.id,
        traceId: traceId(request),
      });
      return reply.code(403).send({
        code: "crown_jewel_step_up_required",
        error: "Recent MFA verification is required.",
      });
    }
    const pending = await options.store.get(actor.orgId, params.data.id);
    if (pending === null)
      return reply.code(404).send({ code: "approval_not_found", error: "Approval was not found." });
    const action =
      policies.find((candidate) => candidate.action.id === pending.actionId)?.action ??
      ({ id: pending.actionId, permission: pending.permission } satisfies CrownJewelAction);
    if (!canAuthorize(action, actor)) {
      await options.store.reject({
        orgId: actor.orgId,
        actorId: actor.id,
        actionId: pending.actionId,
        reason: "approver_permission_denied",
        approvalId: pending.id,
        traceId: traceId(request),
      });
      return reply
        .code(403)
        .send({ code: "forbidden", error: "Approver lacks the action permission." });
    }
    const result = await options.store.approve({
      orgId: actor.orgId,
      id: pending.id,
      actorId: actor.id,
      now: now(),
      traceId: traceId(request),
    });
    const status = result.kind === "approved" ? 200 : result.kind === "not_found" ? 404 : 409;
    return reply
      .code(status)
      .send(
        result.kind === "approved"
          ? { approval: approvalView(result.approval) }
          : { code: `crown_jewel_approval_${result.kind}`, error: "Approval was rejected." },
      );
  });
}

function canAuthorize(action: CrownJewelAction, actor: Actor): boolean {
  return (
    actorHasScope(actor, action.permission) ||
    (action.consoleWriteAlsoAllowed === true && actorHasScope(actor, "admin.console.write"))
  );
}

function approvalIdHeader(request: FastifyRequest): string | null {
  const raw = request.headers["x-helix-crown-jewel-approval"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && z.string().uuid().safeParse(value).success ? value : null;
}

function approvalView(approval: CrownJewelApproval) {
  return {
    id: approval.id,
    actionId: approval.actionId,
    requesterActorId: approval.requesterActorId,
    approvedByActorId: approval.approvedByActorId,
    status: approval.status,
    expiresAt: approval.expiresAt.toISOString(),
    consumedAt: approval.consumedAt?.toISOString() ?? null,
  };
}

function rowToApproval(row: ApprovalRow): CrownJewelApproval {
  const permission = typeof row.input.permission === "string" ? row.input.permission : "";
  const fingerprint = typeof row.input.fingerprint === "string" ? row.input.fingerprint : "";
  return {
    id: row.id,
    orgId: row.org_id,
    requesterActorId: row.actor_id,
    actionId: actionId(row),
    permission,
    fingerprint,
    status: row.status,
    approvedByActorId: row.approved_by_actor_id,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
  };
}

function actionId(row: ApprovalRow): string {
  return row.tool_id.startsWith("crown_jewel:")
    ? row.tool_id.slice("crown_jewel:".length)
    : "unknown";
}

function requiredRow(rows: readonly ApprovalRow[]): ApprovalRow {
  const row = rows[0];
  if (row === undefined) throw new Error("Crown-jewel approval write returned no row.");
  return row;
}

type Transaction = postgres.TransactionSql<Record<string, never>>;
async function setOrg(tx: Transaction, orgId: string): Promise<void> {
  await tx`select set_config('helix.org_id', ${orgId}, true)`;
}

async function appendEvidence(
  tx: Transaction,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly verb: string;
    readonly approvalId?: string | undefined;
    readonly traceId?: string | undefined;
    readonly metadata: Record<string, unknown>;
  },
): Promise<void> {
  await tx`
    insert into activity (org_id, actor_id, verb, object_type, object_id, trace_id, payload, prev_hash, this_hash)
    values (${input.orgId}, ${input.actorId}, ${input.verb}, 'crown_jewel_approval', ${input.approvalId ?? null}, ${input.traceId ?? null}, ${tx.json(input.metadata as postgres.JSONValue)}, null, '')
  `;
}

function rejectionEvidence(
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly traceId?: string | undefined;
  },
  row: ApprovalRow,
  reason: string,
) {
  return {
    orgId: input.orgId,
    actorId: input.actorId,
    verb: "crown_jewel.approval.rejected",
    approvalId: row.id,
    traceId: input.traceId,
    metadata: { actionId: actionId(row), reason, requesterActorId: row.actor_id },
  };
}
