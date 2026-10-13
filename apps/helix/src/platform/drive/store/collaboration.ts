import { insertNotification } from "../../notifications/index.js";
import { DriveConflictError, DriveForbiddenError, DriveNotFoundError } from "../errors.js";
import type { DriveAccessRequestRecord } from "../types.js";
import { requireFolderRole, requireReadyObjectAccess } from "./authz.js";
import { type DriveStoreContext } from "./context.js";
import {
  deliverDriveMail,
  loadDriveItemTitle,
  loadDriveMailActors,
} from "./share-notifications.js";

/**
 * Asking for access to a Drive item you cannot open, the owner's answer, and
 * hiding an item someone shared with you.
 *
 * The person asking cannot read the item, so the request and the decision go
 * through `helix_drive_request_access` and `helix_drive_decide_access_request`,
 * which check who is asking and who owns the item.
 */

type DriveResourceType = "object" | "drive_folder";

async function resourceTypeOf(
  context: DriveStoreContext,
  orgId: string,
  id: string,
): Promise<DriveResourceType> {
  const folders = await context.sql`
    select 1 from drive_folders where org_id = ${orgId} and id = ${id} and deleted_at is null
  `;
  return folders.length > 0 ? "drive_folder" : "object";
}

/** Turn what the access-request functions raise into errors a person can act on. */
function accessRequestError(error: unknown): unknown {
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  const message = error instanceof Error ? error.message : "";
  if (code === "23503") return new DriveNotFoundError("That item no longer exists.");
  if (code === "42501") return new DriveForbiddenError(message);
  if (code === "23514") return new DriveConflictError(message);
  return error;
}

export async function setHiddenShare(
  context: DriveStoreContext,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly hidden: boolean;
  },
): Promise<{ readonly objectId: string; readonly hidden: boolean }> {
  const resourceType = await resourceTypeOf(context, input.orgId, input.objectId);
  if (resourceType === "object") {
    await requireReadyObjectAccess(context.sql, input.orgId, input.actorId, input.objectId);
  } else {
    await requireFolderRole(context.sql, input.orgId, input.actorId, input.objectId, "reader");
  }
  if (input.hidden) {
    await context.sql`
      insert into drive_hidden_shares (org_id, actor_id, resource_type, resource_id)
      values (${input.orgId}, ${input.actorId}, ${resourceType}, ${input.objectId})
      on conflict do nothing
    `;
  } else {
    await context.sql`
      delete from drive_hidden_shares
      where org_id = ${input.orgId} and actor_id = ${input.actorId}
        and resource_type = ${resourceType} and resource_id = ${input.objectId}
    `;
  }
  return { objectId: input.objectId, hidden: input.hidden };
}

export async function requestAccess(
  context: DriveStoreContext,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly message?: string | undefined;
  },
): Promise<{ readonly requestId: string }> {
  const resourceType = await resourceTypeOf(context, input.orgId, input.objectId);
  const message = input.message ?? null;
  // Asking again while the owner has not answered changes nothing and tells nobody.
  const waiting = await context.sql<{ id: string }[]>`
    select id from drive_access_requests
    where org_id = ${input.orgId} and resource_type = ${resourceType}
      and resource_id = ${input.objectId} and requester_actor_id = ${input.actorId}
      and state = 'open'
  `;
  if (waiting[0] !== undefined) return { requestId: waiting[0].id };
  const asked = await context.sql<{ id: string }[]>`
    select helix_drive_request_access(
      ${input.orgId}, ${input.actorId}, ${resourceType}, ${input.objectId}, ${message}
    ) as id
  `.catch((error: unknown) => {
    throw accessRequestError(error);
  });
  // Read back in its own statement: a query does not see rows its own function call wrote.
  const rows = await context.sql<{ id: string; owner_actor_id: string }[]>`
    select id, owner_actor_id from drive_access_requests
    where org_id = ${input.orgId} and id = ${asked[0]?.id ?? null}
  `;
  const request = rows[0];
  if (request === undefined) throw new DriveConflictError("Could not ask for access.");
  const ownerId = request.owner_actor_id;
  const actors = await loadDriveMailActors(context.sql, input.orgId, [input.actorId, ownerId]);
  const requester = actors.get(input.actorId);
  const owner = actors.get(ownerId);
  const requesterName = requester?.displayName ?? "Someone";
  const title = await loadDriveItemTitle(context.sql, input.orgId, input.objectId, resourceType);
  await insertNotification(context.sql, {
    orgId: input.orgId,
    actorId: ownerId,
    verb: "drive.access.requested",
    objectType: "drive.object",
    objectId: input.objectId,
    summary: `${requesterName} asked for access to "${title}".`,
    body: message,
    payload: { objectId: input.objectId, requestId: request.id, requesterActorId: input.actorId },
  });
  const mailer = context.options.shareMailer;
  const requesterEmail = requester?.email ?? null;
  const ownerEmail = owner?.email ?? null;
  if (mailer !== undefined && requesterEmail !== null && ownerEmail !== null) {
    await deliverDriveMail(context, () =>
      mailer.sendAccessRequest({
        orgId: input.orgId,
        actorId: input.actorId,
        objectId: input.objectId,
        folder: resourceType === "drive_folder",
        title,
        message,
        requesterName,
        requesterEmail,
        ownerEmail,
        ownerName: owner?.displayName ?? null,
      }),
    );
  }
  return { requestId: request.id };
}

/** Open requests for items the actor owns, newest first. */
export async function listAccessRequests(
  context: DriveStoreContext,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId?: string | undefined;
  },
): Promise<readonly DriveAccessRequestRecord[]> {
  const objectId = input.objectId ?? null;
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
  >`
    select request.id, request.resource_id, request.requester_actor_id, request.message,
      request.created_at, requester.display_name, requester.email,
      coalesce(folder.name, object.metadata->>'name') as object_name
    from drive_access_requests request
    left join actors requester
      on requester.org_id = request.org_id and requester.id = request.requester_actor_id
    left join drive_folders folder
      on folder.org_id = request.org_id and folder.id = request.resource_id
    left join objects object
      on object.org_id = request.org_id and object.id = request.resource_id
    where request.org_id = ${input.orgId}
      and request.owner_actor_id = ${input.actorId}
      and request.state = 'open'
      and (${objectId}::uuid is null or request.resource_id = ${objectId})
    order by request.created_at desc
    limit 50
  `;
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
  await context.sql`
    select helix_drive_decide_access_request(
      ${input.orgId}, ${input.actorId}, ${input.requestId}, ${input.approve}
    )
  `.catch((error: unknown) => {
    throw accessRequestError(error);
  });
  const rows = await context.sql<
    { requester_actor_id: string; resource_id: string; resource_type: DriveResourceType }[]
  >`
    select requester_actor_id, resource_id, resource_type from drive_access_requests
    where org_id = ${input.orgId} and id = ${input.requestId}
  `;
  const request = rows[0];
  if (request === undefined) throw new DriveNotFoundError("That request no longer exists.");
  const requesterId = request.requester_actor_id;
  const actors = await loadDriveMailActors(context.sql, input.orgId, [input.actorId, requesterId]);
  const owner = actors.get(input.actorId);
  const requester = actors.get(requesterId);
  const ownerName = owner?.displayName ?? "The owner";
  const title = await loadDriveItemTitle(
    context.sql,
    input.orgId,
    request.resource_id,
    request.resource_type,
  );
  await insertNotification(context.sql, {
    orgId: input.orgId,
    actorId: requesterId,
    verb: input.approve ? "drive.access.approved" : "drive.access.declined",
    objectType: "drive.object",
    objectId: request.resource_id,
    summary: input.approve
      ? `${ownerName} gave you access to "${title}".`
      : `${ownerName} declined your request for access to "${title}".`,
    payload: { objectId: request.resource_id, requestId: input.requestId },
  });
  const mailer = context.options.shareMailer;
  const ownerEmail = owner?.email ?? null;
  const requesterEmail = requester?.email ?? null;
  if (mailer !== undefined && ownerEmail !== null && requesterEmail !== null) {
    await deliverDriveMail(context, () =>
      mailer.sendAccessDecision({
        orgId: input.orgId,
        actorId: input.actorId,
        objectId: request.resource_id,
        folder: request.resource_type === "drive_folder",
        title,
        approved: input.approve,
        ownerName,
        ownerEmail,
        requesterEmail,
        requesterName: requester?.displayName ?? null,
      }),
    );
  }
  return { requestId: input.requestId, approved: input.approve };
}
