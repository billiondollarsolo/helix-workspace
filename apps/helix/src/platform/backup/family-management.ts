import { createHash } from "node:crypto";
import type { Actor } from "@helix/sdk-types";
import type postgres from "postgres";
import { z } from "zod";
import { actorHasScope } from "../../api/scopes.js";
import { parseActorRoleBindings } from "../permissions/roles.js";
import { canonicalJson } from "../audit/hash.js";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../api/api-error.js";
import type { FamilyPairing, FamilyApplicationRow } from "../auth/family-pairing.js";
import { withTenantIoSagaPostgresContext } from "../tenancy/postgres-roles.js";
import {
  familyBackupBinding,
  familyBackupJob,
  familyBackupPolicy,
  familyBackupRequest,
  familyBackupStatus,
  type FamilyBackupRequest,
  type FamilyBackupStatus,
} from "./family-protocol.js";

export const recoveryEnrollment = z
  .object({
    id: z.string().uuid(),
    applicationId: z.string().uuid().nullable(),
    managementKey: z.string().regex(/^[a-f0-9]{64}$/u),
    restoreKey: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
  })
  .strict();
type Target = {
  org_id: string;
  id: string;
  application_id: string | null;
  public_origin: string;
  binding: FamilyBackupStatus["binding"];
  credential_envelope: string | null;
  policy: FamilyBackupStatus["policy"];
  policy_pending: boolean;
  status: string;
  observed_status: FamilyBackupStatus | null;
  observed_at: Date | null;
  last_error: string | null;
};
type Job = {
  org_id: string;
  id: string;
  target_id: string;
  requested_by_actor_id: string;
  request: FamilyBackupRequest;
  status: string;
  result: unknown;
  required_approvals: number;
  approved_by_actor_id: string | null;
};
export function canManageFamilyBackups(actor: Actor, restore = false) {
  return (
    actor.type === "user" &&
    actorHasScope(actor, restore ? "admin.backups.restore" : "admin.config.write")
  );
}
export class FamilyBackupManagement {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  constructor(
    readonly family: FamilyPairing,
    readonly orgId: string,
    private readonly onError: (error: unknown) => void,
  ) {}
  authorize(actor: Actor, restore = false) {
    if (actor.orgId !== this.orgId || !canManageFamilyBackups(actor, restore))
      throw new ForbiddenError(
        "An installation recovery administrator must review this operation.",
      );
  }
  private async transaction<T>(
    actor: Actor | undefined,
    fn: (tx: postgres.TransactionSql) => Promise<T>,
  ) {
    return withTenantIoSagaPostgresContext(
      this.family.sql,
      {
        orgId: actor?.orgId ?? this.orgId,
        ...(actor ? { actorId: actor.id } : { serviceContext: true }),
      },
      fn,
    );
  }
  private credentials(row: Target) {
    if (!row.credential_envelope) throw new ConflictError("Recovery capability was detached.");
    return JSON.parse(
      this.family.cipher.open(row.org_id, "family-backup", row.credential_envelope),
    ) as { managementKey: string; restoreKey?: string };
  }
  private async request(
    row: Pick<Target, "public_origin">,
    key: string,
    path: string,
    method = "GET",
    body?: unknown,
  ) {
    const response = await this.family.fetch(
      new URL(`/v1/family-operations${path}`, row.public_origin),
      {
        method,
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          ...(typeof body === "object" && body !== null && "kind" in body && body.kind === "restore"
            ? { "x-helix-recovery-authority-until": new Date(Date.now() + 30000).toISOString() }
            : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    if (!response.ok)
      throw new ConflictError(
        `Recovery worker refused the operation (HTTP ${String(response.status)}). Check its capability and local operator status.`,
      );
    return response.json() as Promise<unknown>;
  }
  private bindingMatches(row: Target, status: FamilyBackupStatus) {
    if (JSON.stringify(familyBackupBinding.parse(row.binding)) !== JSON.stringify(status.binding))
      throw new ConflictError("Recovery worker belongs to a different installation or connection.");
  }
  async list(actor: Actor) {
    if (!canManageFamilyBackups(actor) && !canManageFamilyBackups(actor, true))
      throw new ForbiddenError("Recovery administration is required.");
    if (actor.orgId !== this.orgId)
      throw new ForbiddenError("Installation recovery is restricted to its owning organization.");
    return this.transaction(actor, async (tx) => {
      const rows = await tx<
        Target[]
      >`select * from family_backup_targets where org_id=${actor.orgId} order by id`;
      return rows.map((row) => ({
        id: row.id,
        applicationId: row.application_id,
        origin: row.public_origin,
        binding: row.binding,
        status: row.status,
        policy: row.policy,
        pending: row.policy_pending,
        observedAt: row.observed_at?.toISOString() ?? null,
        observation: row.observed_status,
        error: row.last_error,
        restoreEnabled: row.credential_envelope ? !!this.credentials(row).restoreKey : false,
      }));
    });
  }
  async enroll(actor: Actor, input: z.infer<typeof recoveryEnrollment>) {
    this.authorize(actor);
    if (input.restoreKey === input.managementKey)
      throw new BadRequestError(
        "Backup and restore capabilities must use independent credentials.",
      );
    const origin = await this.transaction(actor, async (tx) => {
      if (input.applicationId === null) return this.family.publicOrigin;
      const [app] = await tx<
        FamilyApplicationRow[]
      >`select * from family_applications where org_id=${actor.orgId} and id=${input.applicationId} and status='active'`;
      if (!app) throw new NotFoundError("Choose an active application.");
      return app.public_origin;
    });
    const observed = familyBackupStatus.parse(
      await this.request({ public_origin: origin }, input.managementKey, "/status"),
    );
    const required =
      observed.binding.application === "bot"
        ? ["database", "files", "configuration"]
        : ["database", "objects", "configuration"];
    if (
      !required.every((value) =>
        observed.requiredCoverage.includes(
          value as "database" | "files" | "objects" | "configuration",
        ),
      )
    )
      throw new BadRequestError(
        "Full application backup coverage must include its database, private files or objects, and configuration.",
      );
    if (observed.binding.orgId !== actor.orgId)
      throw new ForbiddenError("Recovery worker belongs to another organization.");
    if (input.restoreKey) {
      const restoreStatus = familyBackupStatus.parse(
        await this.request({ public_origin: origin }, input.restoreKey, "/status"),
      );
      if (JSON.stringify(restoreStatus.binding) !== JSON.stringify(observed.binding))
        throw new ForbiddenError("Restore capability belongs to another installation.");
    }
    await this.transaction(actor, async (tx) => {
      const [sameId] = await tx<
        Target[]
      >`select * from family_backup_targets where org_id=${actor.orgId} and id=${input.id} for update`;
      if (sameId && sameId.application_id !== input.applicationId)
        throw new ConflictError("Target ID was already used for another application.");
      if (input.applicationId === null) {
        if (
          observed.binding.application !== "workspace" ||
          observed.binding.tenantId !== actor.orgId ||
          observed.binding.connectionId !== null
        )
          throw new ForbiddenError("Choose this Workspace installation's recovery worker.");
      } else {
        const [app] = await tx<
          FamilyApplicationRow[]
        >`select * from family_applications where org_id=${actor.orgId} and id=${input.applicationId} and status='active' for update`;
        if (
          !app ||
          observed.binding.application !== "bot" ||
          observed.binding.installationId !== app.installation_id ||
          observed.binding.tenantId !== app.tenant_id ||
          observed.binding.connectionId !== app.connection_id
        )
          throw new ForbiddenError("Recovery worker does not match the paired application.");
      }
      const [previous] = await tx<
        Target[]
      >`select * from family_backup_targets where org_id=${actor.orgId} and application_id is not distinct from ${input.applicationId} for update`;
      if (previous && previous.id !== input.id)
        throw new ConflictError(
          "Recovery target already exists. Use its existing ID to rotate its capability.",
        );
      if (previous?.policy_pending && previous.policy.revision > observed.policy.revision)
        throw new ConflictError(
          "Deliver the pending policy before rotating recovery capabilities.",
        );
      const credentials = this.family.cipher.seal(
        actor.orgId,
        "family-backup",
        JSON.stringify({
          managementKey: input.managementKey,
          ...(input.restoreKey ? { restoreKey: input.restoreKey } : {}),
        }),
      );
      await tx`insert into family_backup_targets(org_id,id,application_id,public_origin,binding,credential_envelope,policy,policy_pending,observed_status,observed_at,created_by_actor_id)
        values(${actor.orgId},${input.id},${input.applicationId},${origin},${tx.json(observed.binding)},${credentials},${tx.json(observed.policy)},true,${tx.json(observed)},now(),${actor.id})
        on conflict(org_id,id) do update set public_origin=excluded.public_origin,credential_envelope=excluded.credential_envelope,status='active',binding=excluded.binding,policy=excluded.policy,policy_pending=true,observed_status=excluded.observed_status,observed_at=now(),last_error=null,updated_at=now()
        where family_backup_targets.application_id is not distinct from excluded.application_id`;
      await this.family.record(
        tx,
        actor.orgId,
        actor.id,
        input.id,
        "family.backup.enrolled",
        { origin },
        "family_backup_target",
      );
    });
    return { enrolled: true };
  }
  async policy(actor: Actor, id: string, value: unknown) {
    this.authorize(actor);
    const policy = familyBackupPolicy.parse(value);
    await this.transaction(actor, async (tx) => {
      const [row] = await tx<
        Target[]
      >`select * from family_backup_targets where org_id=${actor.orgId} and id=${id} and status='active' for update`;
      if (!row) throw new NotFoundError("Recovery target not found.");
      if (
        policy.revision === row.policy.revision &&
        canonicalJson(policy) === canonicalJson(row.policy)
      )
        return;
      if (policy.revision !== row.policy.revision + 1)
        throw new ConflictError("Policy changed. Reload the current recovery policy.");
      if (
        row.observed_status?.scheduler !== "worker" ||
        policy.retentionDays < row.observed_status.minimumRetentionDays ||
        !row.observed_status.destinations.includes(policy.destinationRef)
      )
        throw new BadRequestError(
          "Choose an operator-approved destination, retention and scheduler.",
        );
      await tx`update family_backup_targets set policy=${tx.json(policy)},policy_pending=true,updated_at=now() where org_id=${actor.orgId} and id=${id}`;
      await this.family.record(
        tx,
        actor.orgId,
        actor.id,
        id,
        "family.backup.policy_changed",
        { policy: canonicalJson(policy) },
        "family_backup_target",
      );
    });
    return { queued: true };
  }
  async createJob(actor: Actor, targetId: string, request: FamilyBackupRequest, approvals: 0 | 1) {
    this.authorize(actor, request.kind === "restore");
    return this.transaction(actor, async (tx) => {
      const [target] = await tx<
        Target[]
      >`select * from family_backup_targets where org_id=${actor.orgId} and id=${targetId} and status='active' for update`;
      if (!target) throw new NotFoundError("Recovery target not found.");
      if (
        request.kind === "restore" &&
        target.binding.application === "workspace" &&
        !request.targetObjectBucket
      )
        throw new BadRequestError("Workspace restore requires a new object bucket.");
      if (request.kind === "restore" && !this.credentials(target).restoreKey)
        throw new ForbiddenError("An independent restore capability has not been approved.");
      if (!target.observed_status?.capabilities.includes(request.kind))
        throw new BadRequestError("This target does not support the requested recovery operation.");
      const [prior] = await tx<
        Job[]
      >`select * from family_backup_jobs where org_id=${actor.orgId} and id=${request.id}`;
      if (prior) {
        if (
          prior.target_id !== targetId ||
          JSON.stringify(familyBackupRequest.parse(prior.request)) !== JSON.stringify(request)
        )
          throw new ConflictError("Operation ID was already used.");
        return prior;
      }
      const required = request.kind === "restore" ? approvals : 0;
      const [saved] = await tx<
        Job[]
      >`insert into family_backup_jobs(org_id,id,target_id,requested_by_actor_id,required_approvals,request,status)
        values(${actor.orgId},${request.id},${targetId},${actor.id},${required},${tx.json(request)},${required ? "pending_approval" : "queued"}) returning *`;
      await this.family.record(
        tx,
        actor.orgId,
        actor.id,
        request.id,
        `family.backup.${request.kind}_requested`,
        { targetId, request: JSON.stringify(request) },
        "family_backup_job",
      );
      return saved;
    });
  }
  async approve(actor: Actor, id: string) {
    this.authorize(actor, true);
    await this.transaction(actor, async (tx) => {
      const [row] = await tx<
        Job[]
      >`select * from family_backup_jobs where org_id=${actor.orgId} and id=${id} and status='pending_approval' for update`;
      if (!row || row.requested_by_actor_id === actor.id)
        throw new ConflictError(
          "A different recovery administrator must approve the pending restore.",
        );
      await tx`update family_backup_jobs set approved_by_actor_id=${actor.id},status='queued',updated_at=now() where org_id=${actor.orgId} and id=${id}`;
      await this.family.record(
        tx,
        actor.orgId,
        actor.id,
        id,
        "family.backup.restore_approved",
        {},
        "family_backup_job",
      );
    });
    return { approved: true };
  }
  async jobs(actor: Actor) {
    if (
      actor.orgId !== this.orgId ||
      (!canManageFamilyBackups(actor) && !canManageFamilyBackups(actor, true))
    )
      throw new ForbiddenError("Recovery administration is required.");
    return this.transaction(actor, async (tx) => {
      const rows = await tx<
        (Job & { last_error: string | null })[]
      >`select * from family_backup_jobs where org_id=${actor.orgId} order by created_at desc limit 100`;
      return rows.map((job) => ({
        id: job.id,
        targetId: job.target_id,
        status: job.status,
        request: job.request,
        result: job.result,
        error: job.last_error,
        canApprove:
          job.status === "pending_approval" &&
          job.requested_by_actor_id !== actor.id &&
          canManageFamilyBackups(actor, true),
      }));
    });
  }
  async detach(actor: Actor, id: string) {
    this.authorize(actor);
    await this.transaction(actor, async (tx) => {
      await tx`update family_backup_targets set status='detach_pending',updated_at=now() where org_id=${actor.orgId} and id=${id} and status='active'`;
      await this.family.record(
        tx,
        actor.orgId,
        actor.id,
        id,
        "family.backup.detach_requested",
        {},
        "family_backup_target",
      );
    });
    return { queued: true };
  }
  runOnce() {
    if (this.running) return this.running;
    this.running = this.reconcile().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  private async reconcile() {
    const rows = await this.transaction(
      undefined,
      (tx) =>
        tx<
          Target[]
        >`select * from family_backup_targets where org_id=${this.orgId} and status<>'detached' order by updated_at,id limit 100`,
    );
    for (const row of rows)
      try {
        if (row.application_id) {
          const active = await this.transaction(
            undefined,
            (tx) =>
              tx`select 1 from family_applications where org_id=${this.orgId} and id=${row.application_id} and status='active'`,
          );
          if (!active.length) row.status = "detach_pending";
        }
        const credentials = this.credentials(row);
        if (row.status === "detach_pending") {
          await this.request(row, credentials.managementKey, "/detach", "POST", {});
          await this.transaction(
            undefined,
            (tx) =>
              tx`update family_backup_targets set status='detached',credential_envelope=null,last_error=null,updated_at=now() where org_id=${this.orgId} and id=${row.id} and credential_envelope=${row.credential_envelope}`,
          );
          continue;
        }
        const observed = familyBackupStatus.parse(
          await this.request(row, credentials.managementKey, "/status"),
        );
        this.bindingMatches(row, observed);
        if (observed.policy.revision > row.policy.revision)
          throw new ConflictError(
            "Worker has a newer policy. Review source recovery with the operator; automatic rollback catch-up is disabled.",
          );
        const stillActive = async () =>
          this.transaction(undefined, async (tx) => {
            const current =
              await tx`select 1 from family_backup_targets t where t.org_id=${this.orgId} and t.id=${row.id} and t.status='active' and t.credential_envelope=${row.credential_envelope} and (t.application_id is null or exists(select 1 from family_applications a where a.org_id=t.org_id and a.id=t.application_id and a.status='active'))`;
            if (!current.length)
              throw new ConflictError(
                "Recovery authority changed; reconciliation will retry current state.",
              );
          });
        await stillActive();
        if (row.policy_pending) {
          await this.request(row, credentials.managementKey, "/policy", "PUT", row.policy);
          await this.transaction(
            undefined,
            (tx) =>
              tx`update family_backup_targets set policy_pending=false where org_id=${this.orgId} and id=${row.id} and policy=${tx.json(row.policy)}`,
          );
        }
        const jobs = await this.transaction(
          undefined,
          (tx) =>
            tx<
              Job[]
            >`select * from family_backup_jobs where org_id=${this.orgId} and target_id=${row.id} and status in ('queued','running') order by created_at limit 20`,
        );
        for (const job of jobs) {
          await stillActive();
          if (job.status === "queued" && !(await this.requesterActive(job))) {
            await this.transaction(
              undefined,
              (tx) =>
                tx`update family_backup_jobs set status='failed',last_error='Requesting recovery authority was removed.',updated_at=now() where org_id=${this.orgId} and id=${job.id}`,
            );
            continue;
          }
          const response = familyBackupJob.parse(
            await this.request(
              row,
              job.request.kind === "restore"
                ? (credentials.restoreKey ?? "")
                : credentials.managementKey,
              "/jobs",
              "POST",
              job.request,
            ),
          );
          await this.transaction(undefined, async (tx) => {
            await tx`update family_backup_jobs set status=${response.status},result=${tx.json(response)},last_error=${response.error},updated_at=now() where org_id=${this.orgId} and id=${job.id}`;
            if (job.status !== response.status)
              await this.family.record(
                tx,
                this.orgId,
                job.requested_by_actor_id,
                job.id,
                "family.backup.operation_updated",
                {
                  targetId: row.id,
                  status: response.status,
                  artifactDigest: response.receipt?.artifactDigest ?? "",
                },
                "family_backup_job",
              );
          });
        }
        await this.transaction(
          undefined,
          (tx) =>
            tx`update family_backup_targets set observed_status=${tx.json(observed)},observed_at=now(),last_error=null,updated_at=now() where org_id=${this.orgId} and id=${row.id} and status='active' and credential_envelope=${row.credential_envelope}`,
        );
      } catch (error) {
        await this.transaction(
          undefined,
          (tx) =>
            tx`update family_backup_targets set last_error=${error instanceof ConflictError ? error.message : "Recovery worker unavailable; check HTTPS, capability and local worker health."},updated_at=now() where org_id=${this.orgId} and id=${row.id}`,
        );
      }
  }
  private requesterActive(job: Job) {
    return this.transaction(undefined, async (tx) => {
      const required = [
        job.requested_by_actor_id,
        ...(job.required_approvals ? [job.approved_by_actor_id] : []),
      ];
      if (required.some((id) => !id)) return false;
      for (const actorId of required) {
        if (!actorId) return false;
        const rows =
          await tx`select a.scopes, helix_actor_role_bindings(a.org_id,a.id) as role_bindings from actors a join organization_memberships m on m.org_id=a.org_id and m.actor_id=a.id and m.status='active'
          join identity_subjects s on s.id=m.subject_id and s.status='active'
          where a.org_id=${this.orgId} and a.id=${actorId} and a.type='user' and a.disabled_at is null`;
        const row = rows[0];
        if (
          !row ||
          !canManageFamilyBackups(
            {
              id: actorId,
              orgId: this.orgId,
              type: "user",
              displayName: "Recovery operator",
              scopes: z.array(z.string()).parse(row.scopes),
              roleBindings: parseActorRoleBindings(row.role_bindings),
            },
            job.request.kind === "restore",
          )
        )
          return false;
      }
      return true;
    });
  }
  async recoverySet(actor: Actor, id: string) {
    this.authorize(actor, true);
    return this.transaction(actor, async (tx) => {
      const [previous] =
        await tx`select manifest,digest from family_recovery_sets where org_id=${actor.orgId} and id=${id}`;
      if (previous) return previous;
      const targets = await tx<
        Target[]
      >`select * from family_backup_targets where org_id=${actor.orgId} and status='active' order by id`;
      const apps = await tx<
        { id: string }[]
      >`select id from family_applications where org_id=${actor.orgId} and status='active' order by id`;
      const entries = targets.map((target) => ({
        targetId: target.id,
        binding: target.binding,
        receipt:
          [...(target.observed_status?.jobs ?? [])]
            .reverse()
            .find((job) => job.status === "completed" && job.receipt?.verifiedAt)?.receipt ?? null,
        observedAt: target.observed_at?.toISOString() ?? null,
      }));
      const complete =
        targets.some((target) => target.application_id === null) &&
        apps.every((app) => targets.some((target) => target.application_id === app.id)) &&
        entries.every(
          (entry) =>
            entry.receipt &&
            entry.receipt.offHost &&
            Date.now() - Date.parse(entry.receipt.createdAt) <=
              2 *
                (targets.find((target) => target.id === entry.targetId)?.policy.intervalMinutes ??
                  0) *
                60000 &&
            entry.observedAt &&
            Date.now() - Date.parse(entry.observedAt) < 60000,
        );
      const manifest = {
        format: "helix.family.recovery-set.v1",
        id,
        orgId: actor.orgId,
        createdAt: new Date().toISOString(),
        consistency: "independent-snapshots",
        complete,
        entries,
      };
      const digest = createHash("sha256").update(canonicalJson(manifest)).digest("hex");
      await tx`insert into family_recovery_sets(org_id,id,manifest,digest,created_by_actor_id) values(${actor.orgId},${id},${tx.json(manifest)},${digest},${actor.id})`;
      await this.family.record(
        tx,
        actor.orgId,
        actor.id,
        id,
        "family.backup.recovery_set_recorded",
        { digest },
        "family_recovery_set",
      );
      return { manifest, digest };
    });
  }
  async start() {
    await this.runOnce();
    this.timer = setInterval(() => {
      void this.runOnce().catch(this.onError);
    }, 15000);
    this.timer.unref();
  }
  async stop() {
    clearInterval(this.timer);
    await this.running;
  }
}
