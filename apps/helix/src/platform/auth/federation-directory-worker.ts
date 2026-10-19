import { deliverFederationRotation } from "./federation-credentials.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { withTenantIoSagaPostgresContext } from "../tenancy/postgres-roles.js";
import type { FederationPairing, FederationApplicationRow } from "./federation-pairing.js";
import { FederationPeerEndedError } from "./federation-pairing.js";

type DirectoryUser = {
  subject: string;
  actorId: string;
  name: string;
  email: string;
  role: "viewer" | "member" | "admin";
};
type DirectoryGroup = {
  id: string;
  name: string;
  subjects: string[];
};
type Snapshot = {
  users: DirectoryUser[];
  groups: DirectoryGroup[];
};
const scimUser = z
  .object({
    id: z.string(),
    externalId: z.string().optional(),
    userName: z.string(),
    active: z.boolean(),
    displayName: z.string().optional(),
    emails: z.array(z.object({ value: z.string() })).optional(),
  })
  .passthrough();
const scimGroup = z
  .object({
    id: z.string(),
    externalId: z.string().optional(),
    displayName: z.string(),
    members: z.array(z.object({ value: z.string() })).optional(),
  })
  .passthrough();
type ScimUser = z.infer<typeof scimUser>;
type ScimGroup = z.infer<typeof scimGroup>;
const userSchema = "urn:ietf:params:scim:schemas:core:2.0:User";
const groupSchema = "urn:ietf:params:scim:schemas:core:2.0:Group";

/** Durable invalidation plus desired-state reconciliation; old events are never replayed. */
export class FederationDirectoryWorker {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  constructor(
    private readonly federation: FederationPairing,
    private readonly orgId: string,
    private readonly onError: (error: unknown) => void,
  ) {}
  async start() {
    if (this.timer) return;
    await this.runOnce();
    this.timer = setInterval(() => void this.runOnce().catch(this.onError), 15_000);
    this.timer.unref();
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }
  runOnce(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.run().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  private async run() {
    const rows = await withTenantIoSagaPostgresContext(
      this.federation.sql,
      { orgId: this.orgId, serviceContext: true },
      (tx) =>
        tx<
          FederationApplicationRow[]
        >`select * from federation_applications where org_id=${this.orgId} and next_sync_at<=now()
        and (status='active' or (status='revoked' and directory_pending) or (status in ('prepared','awaiting-peer') and pairing_expires_at<=now())) order by next_sync_at limit 100`,
    );
    for (const row of rows) {
      try {
        if (row.status === "prepared" || row.status === "awaiting-peer") await this.expire(row);
        else if (row.status === "revoked") {
          if (row.receipt_envelope)
            await this.federation.request(
              row.public_origin,
              `/v1/federation/${row.connection_id}/revoke`,
              this.federation.material(row).scimToken,
              {},
            );
          await withTenantIoSagaPostgresContext(
            this.federation.sql,
            { orgId: this.orgId, serviceContext: true },
            async (tx) => {
              await tx`update federation_applications set directory_pending=false,last_error=null where org_id=${this.orgId} and id=${row.id}`;
            },
          );
        } else await this.sync(row);
      } catch (error) {
        if (error instanceof FederationPeerEndedError) {
          await this.federation.retire(row, row.status === "revoked" ? "revoked" : "failed");
          continue;
        }
        await withTenantIoSagaPostgresContext(
          this.federation.sql,
          { orgId: this.orgId, serviceContext: true },
          async (tx) => {
            await tx`update federation_applications set retry_count=retry_count+1,last_error='Directory reconciliation failed. Check the receiving app, TLS and connection status.',
            next_sync_at=now()+make_interval(secs=>least(60,5*power(2,least(retry_count,4))::integer)) where org_id=${this.orgId} and id=${row.id}`;
          },
        );
        this.onError(error);
      }
    }
  }
  private async expire(row: FederationApplicationRow) {
    if (row.oidc_client_id) await this.federation.clients.disable(row.oidc_client_id);
    await withTenantIoSagaPostgresContext(
      this.federation.sql,
      { orgId: this.orgId, serviceContext: true },
      async (tx) => {
        if (row.receipt_envelope) {
          const material = this.federation.material(row);
          await this.federation.revokePendingCredentials(tx, row);
          await tx`update agent_credentials set revoked_at=coalesce(revoked_at,now()),updated_at=now() where org_id=${this.orgId} and id=${material.enrollmentCredentialId}`;
          await tx`update actors set disabled_at=coalesce(disabled_at,now()),updated_at=now() where org_id=${this.orgId} and id=${material.enrollmentActorId}`;
        }
        await tx`update federation_applications set status='expired',receipt_envelope=null,directory_pending=false,updated_at=now() where org_id=${this.orgId} and id=${row.id} and status in ('prepared','awaiting-peer')`;
      },
    );
  }
  private async snapshot(row: FederationApplicationRow) {
    return withTenantIoSagaPostgresContext(
      this.federation.sql,
      { orgId: this.orgId, serviceContext: true },
      async (tx) => {
        const [current] = await tx<
          FederationApplicationRow[]
        >`select * from federation_applications where org_id=${this.orgId} and id=${row.id} and status='active' for update`;
        if (!current) throw new Error("Federation connection was revoked");
        const users = await tx<
          {
            subject: string;
            actor_id: string;
            name: string;
            email: string;
            role: DirectoryUser["role"];
          }[]
        >`
        select u.id as subject,a.id actor_id,a.display_name as name,u.email,assigned.role
        from federation_app_assignments assigned
        join organization_memberships m on m.org_id=assigned.org_id and m.actor_id=assigned.actor_id and m.status='active'
        join actors a on a.org_id=m.org_id and a.id=m.actor_id and a.type='user' and a.disabled_at is null
        join identity_subjects s on s.id=m.subject_id and s.status='active' and s.federation_generation=assigned.identity_generation
        join identity_provider_subjects p on p.subject_id=s.id and p.provider='better-auth'
        join "user" u on u.id=p.provider_subject and u."emailVerified"=true
        where assigned.org_id=${this.orgId} and assigned.application_id=${row.id} order by u.id limit 5001`;
        if (users.length > 5000)
          throw new Error("Federation directory exceeds the supported reconciliation batch");
        const groups = await tx<
          { id: string; name: string; actor_id: string }[]
        >`select g.id,g.name,gm.actor_id from admin_groups g
        join admin_group_members gm on gm.org_id=g.org_id and gm.group_id=g.id
        join federation_app_assignments assigned on assigned.org_id=gm.org_id and assigned.actor_id=gm.actor_id and assigned.application_id=${row.id}
        where g.org_id=${this.orgId} order by g.id,gm.actor_id`;
        const byActor = new Map(users.map((user) => [user.actor_id, user.subject]));
        const grouped = new Map<string, DirectoryGroup>();
        for (const group of groups) {
          const subject = byActor.get(group.actor_id);
          if (!subject) continue;
          const entry = grouped.get(group.id) ?? { id: group.id, name: group.name, subjects: [] };
          entry.subjects.push(subject);
          grouped.set(group.id, entry);
        }
        const snapshot: Snapshot = {
          users: users.map((user) => ({
            subject: user.subject,
            actorId: user.actor_id,
            name: user.name.slice(0, 120),
            email: user.email,
            role: user.role,
          })),
          groups: [...grouped.values()],
        };
        const hash = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
        const revision = Number(current.revision) + 1;
        if (!Number.isSafeInteger(revision)) throw new Error("Federation revision exhausted");
        const [prepared] = await tx<
          FederationApplicationRow[]
        >`update federation_applications set revision=${revision},
        directory_revision=directory_revision+case when desired_hash is distinct from ${hash} then 1 else 0 end,
        desired_hash=${hash},desired_snapshot=${tx.json(snapshot)},next_sync_at=now()+interval '15 seconds',updated_at=now()
        where org_id=${this.orgId} and id=${row.id} returning *`;
        if (!prepared) throw new Error("Federation snapshot was not stored");
        return {
          row: prepared,
          snapshot,
          revision,
          directoryRevision: Number(prepared.directory_revision),
        };
      },
    );
  }
  private async sync(initial: FederationApplicationRow) {
    await deliverFederationRotation(this.federation, initial);
    const { row, snapshot, revision, directoryRevision } = await this.snapshot(initial);
    const material = this.federation.material(row);
    const challenge = z
      .object({ nonce: z.string(), checkpointRevision: z.number().int() })
      .parse(
        await this.federation.request(
          row.public_origin,
          `/v1/federation/${row.connection_id}/challenge`,
          material.scimToken,
          {},
        ),
      );
    if (challenge.checkpointRevision >= revision) {
      await this.federation.retire(row, "failed", revision);
      throw new Error(
        "Receiving app has a newer checkpoint. Review restored directory state before reconnecting.",
      );
    }
    const checkpoint = { nonce: challenge.nonce, revision, directoryRevision };
    await this.federation.request(
      row.public_origin,
      `/v1/federation/${row.connection_id}/begin`,
      material.scimToken,
      checkpoint,
    );
    const scim = async (path: string, method = "GET", body?: unknown) => {
      const response = await this.federation.fetch(
        new URL(`/scim/v2/${row.tenant_id}/${path}`, row.public_origin),
        {
          method,
          headers: {
            authorization: `Bearer ${material.scimToken}`,
            "content-type": "application/scim+json",
            "x-helix-directory-nonce": challenge.nonce,
            "x-helix-directory-revision": String(revision),
            "user-agent": "HelixWorkspace/1.0",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
      if (!response.ok) throw new Error(`SCIM reconciliation refused (${String(response.status)})`);
      return response.status === 204 ? null : (response.json() as Promise<unknown>);
    };
    const all = async <T>(resource: string, schema: z.ZodType<T>) => {
      const result: T[] = [];
      for (let start = 1; start <= 10001; start += 100) {
        const page = z
          .object({ totalResults: z.number().int().nonnegative(), Resources: z.array(schema) })
          .parse(await scim(`${resource}?startIndex=${String(start)}&count=100`));
        result.push(...page.Resources);
        if (result.length >= page.totalResults) return result;
        if (page.Resources.length === 0)
          throw new Error("SCIM pagination stopped before the final resource");
      }
      throw new Error("SCIM resource limit exceeded");
    };
    const existingUsers = await all("Users", scimUser);
    const wanted = new Map(snapshot.users.map((user) => [user.subject, user]));
    const bySubject = new Map<string, ScimUser>();
    for (const user of existingUsers) {
      if (!user.externalId)
        throw new Error("Federation SCIM user has no immutable external identifier");
      if (bySubject.has(user.externalId))
        throw new Error("SCIM contains duplicate external identifiers");
      bySubject.set(user.externalId, user);
      if (!wanted.has(user.externalId) && user.active)
        await scim(`Users/${user.id}`, "PATCH", {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "replace", path: "active", value: false }],
        });
    }
    const ids = new Map<string, string>();
    for (const desired of snapshot.users) {
      const current = bySubject.get(desired.subject);
      const body = {
        schemas: [userSchema],
        userName: desired.subject,
        externalId: desired.subject,
        displayName: desired.name,
        active: true,
        emails: [{ value: desired.email, primary: true }],
      };
      if (!current) {
        const created = scimUser.parse(await scim("Users", "POST", body));
        ids.set(desired.subject, created.id);
      } else {
        if (
          !current.active ||
          current.userName !== desired.subject ||
          current.displayName !== desired.name ||
          current.emails?.[0]?.value !== desired.email
        )
          await scim(`Users/${current.id}`, "PUT", body);
        ids.set(desired.subject, current.id);
      }
    }
    const existingGroups = await all("Groups", scimGroup);
    const desiredGroups = new Set(snapshot.groups.map((group) => group.id));
    const groupsByExternal = new Map<string, ScimGroup>();
    for (const group of existingGroups) {
      if (group.externalId) groupsByExternal.set(group.externalId, group);
      if (!group.externalId || !desiredGroups.has(group.externalId))
        await scim(`Groups/${group.id}`, "DELETE");
    }
    for (const group of snapshot.groups) {
      const members = group.subjects.map((subject) => ({ value: ids.get(subject) }));
      if (members.some((member) => member.value === undefined))
        throw new Error("Directory group references an unassigned person");
      const body = {
        schemas: [groupSchema],
        externalId: group.id,
        displayName: group.name,
        members,
      };
      const current = groupsByExternal.get(group.id);
      const existingMembers = (current?.members ?? []).map((member) => member.value).sort();
      if (!current) await scim("Groups", "POST", body);
      else if (
        current.displayName !== group.name ||
        JSON.stringify(existingMembers) !==
          JSON.stringify(members.map((member) => member.value).sort())
      )
        await scim(`Groups/${current.id}`, "PUT", body);
    }
    await this.federation.request(
      row.public_origin,
      `/v1/federation/${row.connection_id}/checkpoint`,
      material.scimToken,
      {
        ...checkpoint,
        users: snapshot.users.map((user) => ({ subject: user.subject, role: user.role })),
      },
    );
    await withTenantIoSagaPostgresContext(
      this.federation.sql,
      { orgId: this.orgId, serviceContext: true },
      async (tx) => {
        await tx`update federation_applications set acknowledged_revision=${revision},last_synced_at=now(),last_error=null,retry_count=0,
        directory_pending=(directory_revision<>${directoryRevision}),next_sync_at=now()+interval '15 seconds'
        where org_id=${this.orgId} and id=${row.id} and revision=${revision} and status='active'`;
      },
    );
  }
}
