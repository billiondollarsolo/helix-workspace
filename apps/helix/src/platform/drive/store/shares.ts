import { parseDriveRole } from "../core/roles.js";
import type { DriveAccessGrantRecord } from "../types.js";
import { appendDriveActivity } from "./activity.js";
import {
  assertDriveObjectReady,
  requireFolderRole,
  requireObjectAccess,
  requireObjectRole,
  requireReadyObjectAccess,
} from "./authz.js";
import { type DriveStoreContext } from "./context.js";
import { mapDriveAccessGrant } from "./mappers.js";
import { type DriveAccessGrantRow } from "./rows.js";
export async function share(
  context: DriveStoreContext,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly targetActorIds: readonly string[];
    readonly role: string;
    readonly expiresAt?: Date | null;
  },
): Promise<{
  readonly objectId: string;
  readonly sharedWithActorIds: readonly string[];
  readonly role: string;
}> {
  return context.sql.begin(async (tx) => {
    const role = parseDriveRole(input.role);
    const sharedWithActorIds = [...new Set(input.targetActorIds)];
    const folder = await tx<
      { id: string }[]
    >`select id from drive_folders where org_id = ${input.orgId} and id = ${input.objectId} and deleted_at is null`;
    const resourceType = folder.length > 0 ? "drive_folder" : "object";
    if (resourceType === "drive_folder") {
      await requireFolderRole(tx, input.orgId, input.actorId, input.objectId, "owner");
    } else {
      const object = await requireObjectRole(
        tx,
        input.orgId,
        input.actorId,
        input.objectId,
        "owner",
      );
      assertDriveObjectReady(object);
    }
    for (const targetActorId of sharedWithActorIds) {
      await tx`
          insert into permissions (org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id, expires_at)
          values (${input.orgId}, ${targetActorId}, ${resourceType}, ${input.objectId}, ${role}, ${input.actorId}, ${input.expiresAt ?? null})
          on conflict do nothing
        `;
    }
    await appendDriveActivity(tx, {
      orgId: input.orgId,
      actorId: input.actorId,
      verb: resourceType === "drive_folder" ? "drive.folder.shared" : "drive.object.shared",
      objectId: input.objectId,
      payload: { sharedWithActorIds, role },
    });
    return { objectId: input.objectId, sharedWithActorIds, role };
  });
}

export async function listAccess(
  context: DriveStoreContext,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
  },
): Promise<readonly DriveAccessGrantRecord[]> {
  const folder = await context.sql<
    { owner_actor_id: string | null }[]
  >`select owner_actor_id from drive_folders where org_id = ${input.orgId} and id = ${input.objectId} and deleted_at is null`;
  if (folder[0] !== undefined) {
    await requireFolderRole(context.sql, input.orgId, input.actorId, input.objectId, "reader");
    const rows = await context.sql<DriveAccessGrantRow[]>`
      select distinct on (p.actor_id)
        p.actor_id, p.role, a.display_name, a.email, p.granted_by_actor_id, p.expires_at, p.created_at, p.updated_at
      from permissions p
      left join actors a on a.id = p.actor_id and a.org_id = p.org_id
      where p.org_id = ${input.orgId}
        and p.resource_type = 'drive_folder'
        and p.resource_id = ${input.objectId}
        and (p.expires_at is null or p.expires_at > now())
        and (${folder[0].owner_actor_id}::uuid is null or p.actor_id <> ${folder[0].owner_actor_id})
      order by p.actor_id, p.updated_at desc, p.created_at desc
    `;
    return rows.map(mapDriveAccessGrant);
  }
  await requireReadyObjectAccess(context.sql, input.orgId, input.actorId, input.objectId);
  const rows = await context.sql<DriveAccessGrantRow[]>`
      select distinct on (p.actor_id)
        p.actor_id,
        p.role,
        a.display_name,
        a.email,
        p.granted_by_actor_id,
        p.expires_at,
        p.created_at,
        p.updated_at
      from permissions p
      join objects o
        on o.org_id = p.org_id
        and o.id = p.resource_id
        and o.kind in ('file', 'recording')
        and o.deleted_at is null
      left join actors a on a.id = p.actor_id and a.org_id = p.org_id
      where p.org_id = ${input.orgId}
        and p.resource_type = 'object'
        and p.resource_id = ${input.objectId}
        and p.actor_id <> o.owner_actor_id
        and (p.expires_at is null or p.expires_at > now())
      order by p.actor_id, p.updated_at desc, p.created_at desc
    `;
  return rows.map(mapDriveAccessGrant);
}

export async function removeAccess(
  context: DriveStoreContext,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly targetActorId: string;
  },
): Promise<boolean> {
  return context.sql.begin(async (tx) => {
    // Self-removal is allowed for any grantee; removing others requires owner.
    if (input.targetActorId !== input.actorId) {
      await requireObjectRole(tx, input.orgId, input.actorId, input.objectId, "owner");
    } else {
      await requireObjectAccess(tx, input.orgId, input.actorId, input.objectId);
    }
    const rows = await tx<
      {
        readonly removed_count: number | string;
      }[]
    >`
        with target_object as (
          select id, owner_actor_id
          from objects
          where id = ${input.objectId}
            and org_id = ${input.orgId}
            and kind in ('file', 'recording')
            and deleted_at is null
        ),
        deleted as (
          delete from permissions p
          using target_object o
          where p.org_id = ${input.orgId}
            and p.resource_type = 'object'
            and p.resource_id = o.id
            and p.actor_id = ${input.targetActorId}
            and (o.owner_actor_id is null or p.actor_id <> o.owner_actor_id)
            and p.source_group_grant_id is null
            and (
              ${input.targetActorId === input.actorId}
              or helix_drive_effective_role(
                ${input.orgId}, ${input.actorId}, 'object', o.id
              ) = 'owner'
            )
          returning p.actor_id
        )
        select count(*)::int as removed_count from deleted
      `;
    const removed = Number(rows[0]?.removed_count ?? 0) > 0;
    if (removed) {
      await appendDriveActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "drive.object.access_removed",
        objectId: input.objectId,
        payload: { targetActorId: input.targetActorId },
      });
    }
    return removed;
  });
}

export async function updateAccess(
  context: DriveStoreContext,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly targetActorId: string;
    readonly role: string;
    readonly expiresAt?: Date | null;
  },
): Promise<DriveAccessGrantRecord | null> {
  return context.sql.begin(async (tx) => {
    const object = await requireObjectRole(tx, input.orgId, input.actorId, input.objectId, "owner");
    assertDriveObjectReady(object);
    const role = parseDriveRole(input.role);
    const rows = await tx<DriveAccessGrantRow[]>`
        with target_object as (
          select id, owner_actor_id
          from objects
          where id = ${input.objectId}
            and org_id = ${input.orgId}
            and kind in ('file', 'recording')
            and deleted_at is null
        ),
        updated as (
          update permissions p
          set role = ${role},
              expires_at = ${input.expiresAt ?? null},
              granted_by_actor_id = ${input.actorId},
              updated_at = now()
          from target_object o
          where p.org_id = ${input.orgId}
            and p.resource_type = 'object'
            and p.resource_id = o.id
            and p.actor_id = ${input.targetActorId}
            and (o.owner_actor_id is null or p.actor_id <> o.owner_actor_id)
            and p.source_group_grant_id is null
          returning
            p.actor_id,
            p.role,
            p.granted_by_actor_id,
            p.expires_at,
            p.created_at,
            p.updated_at
        )
        select distinct on (u.actor_id)
          u.actor_id,
          u.role,
          a.display_name,
          a.email,
          u.granted_by_actor_id,
          u.expires_at,
          u.created_at,
          u.updated_at
        from updated u
        left join actors a on a.id = u.actor_id and a.org_id = ${input.orgId}
        order by u.actor_id, u.updated_at desc, u.created_at desc
      `;
    const grant = rows[0] === undefined ? null : mapDriveAccessGrant(rows[0]);
    if (grant !== null) {
      await appendDriveActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "drive.object.access_updated",
        objectId: input.objectId,
        payload: { targetActorId: input.targetActorId, role: input.role },
      });
    }
    return grant;
  });
}
