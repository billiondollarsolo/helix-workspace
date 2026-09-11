import type { JsonObject } from "@helix/sdk-types";
import { randomUUID } from "node:crypto";
import { grantObjectAccess } from "../../permissions/grant-object-access.js";
import { driveStorageKey } from "../core/storage-key.js";
import { DriveConflictError, DriveNotFoundError } from "../errors.js";
import type { DriveEntryRecord } from "../types.js";
import { appendDriveActivity } from "./activity.js";
import { isDriveObjectReady, requireReadyObjectAccess } from "./authz.js";
import { type DriveStoreContext } from "./context.js";
import { mapObjectEntry } from "./mappers.js";
import { type DriveSearchRow } from "./rows.js";
import {
  deliverDriveMail,
  loadDriveItemTitle,
  loadDriveMailActors,
} from "./share-notifications.js";

export async function setHiddenShare(
  context: DriveStoreContext,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly hidden: boolean;
  },
): Promise<{ readonly objectId: string; readonly hidden: boolean }> {
  const folder = await context.sql<
    { id: string }[]
  >`select id from drive_folders where org_id = ${input.orgId} and id = ${input.objectId} and deleted_at is null`;
  const resourceType = folder.length > 0 ? "drive_folder" : "object";
  if (resourceType === "object") {
    await requireReadyObjectAccess(context.sql, input.orgId, input.actorId, input.objectId);
  }
  if (input.hidden) {
    await context.sql`insert into drive_hidden_shares (org_id, actor_id, resource_type, resource_id)
      values (${input.orgId}, ${input.actorId}, ${resourceType}, ${input.objectId})
      on conflict do nothing`;
  } else {
    await context.sql`delete from drive_hidden_shares
      where org_id = ${input.orgId} and actor_id = ${input.actorId}
        and resource_type = ${resourceType} and resource_id = ${input.objectId}`;
  }
  return { objectId: input.objectId, hidden: input.hidden };
}

export async function requestAccess(
  context: DriveStoreContext,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly message?: string;
  },
): Promise<{ readonly requestId: string }> {
  const folder = await context.sql<
    { id: string }[]
  >`select id from drive_folders where org_id = ${input.orgId} and id = ${input.objectId} and deleted_at is null`;
  const resourceType = folder.length > 0 ? "drive_folder" : "object";
  const rows = await context.sql<{ id: string }[]>`
    select helix_drive_request_access(
      ${input.orgId}, ${input.actorId}, ${resourceType}, ${input.objectId}, ${input.message ?? null}
    ) as id
  `;
  const requestId = rows[0]?.id;
  if (requestId === undefined) throw new DriveConflictError("Could not create an access request.");
  const owner = await context.sql<
    { owner_actor_id: string }[]
  >`select owner_actor_id from drive_access_requests where id = ${requestId}`;
  const ownerId = owner[0]?.owner_actor_id;
  if (ownerId !== undefined) {
    await context.sql`insert into notifications (
        org_id, actor_id, verb, object_type, object_id, summary, body, payload
      ) values (
        ${input.orgId}, ${ownerId}, 'drive.access.requested', ${resourceType}, ${input.objectId},
        ${"Someone requested access to a Drive item"}, ${input.message ?? null},
        ${context.sql.json({ requesterActorId: input.actorId, requestId })}
      )`;
    const mailer = context.options.shareMailer;
    if (mailer !== undefined) {
      const actors = await loadDriveMailActors(context.sql, input.orgId, [input.actorId, ownerId]);
      const requester = actors.get(input.actorId);
      const owner = actors.get(ownerId);
      const requesterEmail = requester?.email ?? null;
      const ownerEmail = owner?.email ?? null;
      if (requesterEmail !== null && ownerEmail !== null) {
        const title = await loadDriveItemTitle(
          context.sql,
          input.orgId,
          input.objectId,
          resourceType,
        );
        await deliverDriveMail(context, () =>
          mailer.sendAccessRequest({
            orgId: input.orgId,
            actorId: input.actorId,
            objectId: input.objectId,
            title,
            message: input.message ?? null,
            requesterName: requester?.displayName ?? "Someone",
            requesterEmail,
            ownerEmail,
            ownerName: owner?.displayName ?? null,
          }),
        );
      }
    }
  }
  return { requestId };
}

export async function listAccessRequests(
  context: DriveStoreContext,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId?: string;
  },
): Promise<
  readonly {
    readonly id: string;
    readonly objectId: string;
    readonly requesterActorId: string;
    readonly requesterDisplayName: string | null;
    readonly requesterEmail: string | null;
    readonly objectName: string;
    readonly message: string | null;
    readonly createdAt: Date;
  }[]
> {
  const rows = await context.sql<
    {
      id: string;
      resource_id: string;
      requester_actor_id: string;
      display_name: string | null;
      email: string | null;
      object_name: string | null;
      message: string | null;
      created_at: Date;
    }[]
  >`select r.id, r.resource_id, r.requester_actor_id, r.message, r.created_at,
      a.display_name, a.email,
      coalesce(f.name, o.metadata->>'name', 'Drive item') as object_name
    from drive_access_requests r
    left join actors a on a.org_id = r.org_id and a.id = r.requester_actor_id
    left join drive_folders f on f.org_id = r.org_id and f.id = r.resource_id
    left join objects o on o.org_id = r.org_id and o.id = r.resource_id
    where r.org_id = ${input.orgId}
      and r.owner_actor_id = ${input.actorId}
      and r.state = 'open'
      and (${input.objectId ?? null}::uuid is null or r.resource_id = ${input.objectId ?? null})
    order by r.created_at desc
    limit 50`;
  return rows.map((row) => ({
    id: row.id,
    objectId: row.resource_id,
    requesterActorId: row.requester_actor_id,
    requesterDisplayName: row.display_name,
    requesterEmail: row.email,
    objectName: row.object_name ?? "Drive item",
    message: row.message,
    createdAt: row.created_at,
  }));
}

export async function decideAccessRequest(
  context: DriveStoreContext,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly requestId: string;
    readonly approve: boolean;
  },
): Promise<{ readonly requestId: string; readonly approved: boolean }> {
  const rows = await context.sql<{ id: string }[]>`
    select helix_drive_decide_access_request(
      ${input.orgId}, ${input.actorId}, ${input.requestId}, ${input.approve}
    ) as id
  `;
  const requesterId = rows[0]?.id;
  if (requesterId === undefined) throw new DriveNotFoundError("Unknown access request.");
  await context.sql`insert into notifications (
      org_id, actor_id, verb, object_type, object_id, summary, body, payload
    ) values (
      ${input.orgId}, ${requesterId},
      ${input.approve ? "drive.access.approved" : "drive.access.rejected"},
      ${"drive_access_request"}, ${input.requestId},
      ${input.approve ? "Your Drive access request was approved" : "Your Drive access request was declined"},
      ${null}, ${context.sql.json({ requestId: input.requestId })}
    )`;
  const mailer = context.options.shareMailer;
  if (mailer !== undefined) {
    const request = (
      await context.sql<
        { resource_id: string; resource_type: "object" | "drive_folder" }[]
      >`select resource_id, resource_type from drive_access_requests where id = ${input.requestId}`
    )[0];
    if (request !== undefined) {
      const actors = await loadDriveMailActors(context.sql, input.orgId, [
        input.actorId,
        requesterId,
      ]);
      const owner = actors.get(input.actorId);
      const requester = actors.get(requesterId);
      const ownerEmail = owner?.email ?? null;
      const requesterEmail = requester?.email ?? null;
      if (ownerEmail !== null && requesterEmail !== null) {
        const title = await loadDriveItemTitle(
          context.sql,
          input.orgId,
          request.resource_id,
          request.resource_type === "drive_folder" ? "drive_folder" : "object",
        );
        await deliverDriveMail(context, () =>
          mailer.sendAccessDecision({
            orgId: input.orgId,
            actorId: input.actorId,
            objectId: request.resource_id,
            title,
            approved: input.approve,
            ownerName: owner?.displayName ?? "Someone",
            ownerEmail,
            requesterEmail,
            requesterName: requester?.displayName ?? null,
          }),
        );
      }
    }
  }
  return { requestId: input.requestId, approved: input.approve };
}

export async function copyObject(
  context: DriveStoreContext,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly folderId?: string | null;
  },
): Promise<DriveEntryRecord> {
  const source = await requireReadyObjectAccess(
    context.sql,
    input.orgId,
    input.actorId,
    input.objectId,
  );
  if (!isDriveObjectReady(source)) {
    throw new DriveConflictError("Drive object is not ready.");
  }
  const copyId = randomUUID();
  const sourceName =
    typeof source.metadata.name === "string" && source.metadata.name.length > 0
      ? source.metadata.name
      : "file";
  const copyName = sourceName.startsWith("Copy of ") ? sourceName : `Copy of ${sourceName}`;
  const folderId =
    input.folderId === undefined
      ? typeof source.metadata.folderId === "string"
        ? source.metadata.folderId
        : null
      : input.folderId;
  const storageKey = driveStorageKey(input.orgId, copyId, 1, copyName);
  const storage = context.storage;
  if (storage?.copy !== undefined) {
    await storage.copy(source.storage_key, storageKey);
  } else if (storage !== undefined) {
    const body = await storage.get(source.storage_key);
    if (body === null) throw new DriveNotFoundError("Source file bytes are missing.");
    await storage.put({ key: storageKey, body: body.body, contentType: source.mime_type });
  } else {
    throw new DriveConflictError("Storage cannot copy this file.");
  }
  const sha256 = source.sha256 ?? "0".repeat(64);
  const inserted = await context.sql<DriveSearchRow[]>`
    insert into objects (
      id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata
    ) values (
      ${copyId}, ${input.orgId}, ${input.actorId}, ${source.kind}, ${storageKey}, ${source.mime_type},
      ${source.byte_size}, ${sha256},
      ${context.sql.json({
        ...withoutSeedKey(source.metadata),
        name: copyName,
        folderId,
        status: "ready",
      })}
    )
    returning *, 1 as version_number
  `;
  const row = inserted[0];
  if (row === undefined) throw new DriveConflictError("Could not copy the Drive file.");
  await context.sql`insert into drive_versions (
      org_id, object_id, version_number, storage_key, mime_type, byte_size, sha256, created_by_actor_id, metadata
    ) values (
      ${input.orgId}, ${copyId}, 1, ${storageKey}, ${source.mime_type}, ${source.byte_size}, ${sha256},
      ${input.actorId}, ${context.sql.json({ name: copyName })}
    )`;
  await grantObjectAccess(context.sql, {
    orgId: input.orgId,
    actorId: input.actorId,
    objectId: copyId,
    role: "owner",
    grantedByActorId: input.actorId,
  });
  await appendDriveActivity(context.sql, {
    orgId: input.orgId,
    actorId: input.actorId,
    verb: "drive.object.copied",
    objectId: copyId,
    payload: { sourceObjectId: input.objectId },
  });
  return mapObjectEntry(row);
}

function withoutSeedKey(metadata: JsonObject): JsonObject {
  const { seedKey: _seedKey, ...rest } = metadata;
  return rest;
}
