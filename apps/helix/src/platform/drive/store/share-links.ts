import { randomBytes } from "node:crypto";
import { hashSecret } from "../../auth/oauth.js";
import { withTenantIoSagaPostgresContext as withTenantPostgresContext } from "../../tenancy/postgres-roles.js";
import { bytesFromDatabase } from "../core/mappers.js";
import { DriveConflictError } from "../errors.js";
import { appendDriveActivity } from "./activity.js";
import { assertDriveObjectReady, requireObjectRole, requireReadyObjectRole } from "./authz.js";
import { type DriveStoreContext } from "./context.js";
import {
  type DriveFileStreamResult,
  type DriveShareAccessInput,
  type DriveShareLinkRecord,
} from "./contracts.js";
import { mapObjectEntry } from "./mappers.js";
import { type DriveShareLinkAccessRow, type DriveShareLinkRow, type ObjectRow } from "./rows.js";
import {
  appendDriveShareLinkEvent,
  assertDriveSharePolicy,
  consumeDriveShareRateLimit,
  driveShareDenialReason,
  mapShareLink,
  normalizeShareDomains,
  requireSharePassword,
  sha256Hex,
  shareActorId,
  shareLinkRow,
} from "./share-policy.js";
import { driveContentEtag, openStoredObject, storageForOrg } from "./storage.js";
export async function createShareLink(
  context: DriveStoreContext,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly password?: string | undefined;
    readonly expiresAt?: Date | null;
    readonly maxDownloads?: number | null;
    readonly rateLimitPerHour?: number;
    readonly oneTime?: boolean | undefined;
    readonly allowedDomains?: readonly string[] | undefined;
    readonly allowDownload?: boolean | undefined;
  },
): Promise<DriveShareLinkRecord> {
  const passwordHash =
    input.password === undefined ? null : await hashSecret(requireSharePassword(input.password));
  const allowedDomains = normalizeShareDomains(input.allowedDomains ?? []);
  return context.sql.begin(async (tx) => {
    const object = await requireObjectRole(tx, input.orgId, input.actorId, input.objectId, "owner");
    assertDriveObjectReady(object);
    const classification = await assertDriveSharePolicy(tx, object, allowedDomains);
    if (
      input.expiresAt !== undefined &&
      input.expiresAt !== null &&
      input.expiresAt <= new Date()
    ) {
      throw new DriveConflictError("Share-link expiry must be in the future.");
    }
    const token = randomBytes(32).toString("base64url");
    const tokenHash = sha256Hex(token);
    const rows = await tx<DriveShareLinkRow[]>`
        insert into drive_share_links (
          org_id, token_hash, object_id, role, password_hash, expires_at, one_time,
          allowed_domains, allow_download, classification, created_by_actor_id, max_downloads, rate_limit_per_hour
        )
        values (
          ${input.orgId},
          ${tokenHash},
          ${input.objectId},
          'reader',
          ${passwordHash},
          ${input.expiresAt ?? null},
          ${input.oneTime ?? false},
          ${allowedDomains},
          ${input.allowDownload ?? true},
          ${classification},
          ${input.actorId},
          ${input.maxDownloads ?? null},
          ${input.rateLimitPerHour ?? 120}
        )
        returning *
      `;
    const row = rows[0];
    if (row === undefined) {
      throw new DriveConflictError("Expected drive_share_links row.");
    }
    await appendDriveActivity(tx, {
      orgId: input.orgId,
      actorId: input.actorId,
      verb: "drive.link.created",
      objectId: input.objectId,
      payload: {
        linkId: row.id,
        role: "reader",
        passwordProtected: passwordHash !== null,
        oneTime: input.oneTime ?? false,
        allowedDomains,
        allowDownload: input.allowDownload ?? true,
        classification,
      },
    });
    await appendDriveShareLinkEvent(tx, row, "create", "allowed", input.actorId, null, {});
    return mapShareLink(row, token);
  });
}

export async function listShareLinks(
  context: DriveStoreContext,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
  },
): Promise<readonly DriveShareLinkRecord[]> {
  await requireReadyObjectRole(context.sql, input.orgId, input.actorId, input.objectId, "owner");
  const rows = await context.sql<DriveShareLinkRow[]>`
      select *
      from drive_share_links
      where org_id = ${input.orgId}
        and object_id = ${input.objectId}
        and revoked_at is null
      order by created_at desc
    `;
  return rows.map((row) => mapShareLink(row));
}

export async function revokeShareLink(
  context: DriveStoreContext,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly linkId: string;
  },
): Promise<boolean> {
  return context.sql.begin(async (tx) => {
    const existing = await tx<DriveShareLinkRow[]>`
        select *
        from drive_share_links
        where id = ${input.linkId}
          and org_id = ${input.orgId}
        limit 1
      `;
    const link = existing[0];
    if (link === undefined) {
      return false;
    }
    await requireObjectRole(tx, input.orgId, input.actorId, link.object_id, "owner");
    const rows = await tx<DriveShareLinkRow[]>`
        update drive_share_links
        set revoked_at = now()
        where id = ${input.linkId}
          and org_id = ${input.orgId}
          and revoked_at is null
        returning *
      `;
    const revoked = rows[0];
    if (revoked === undefined) return false;
    await appendDriveActivity(tx, {
      orgId: input.orgId,
      actorId: input.actorId,
      verb: "drive.link.revoked",
      objectId: link.object_id,
      payload: { linkId: link.id },
    });
    await appendDriveShareLinkEvent(tx, revoked, "revoke", "allowed", input.actorId, null, {});
    return true;
  });
}

export async function resolveShareLink(
  context: DriveStoreContext,
  input: DriveShareAccessInput,
): Promise<{
  readonly orgId: string;
  readonly objectId: string;
  readonly linkId: string;
} | null> {
  if (
    !/^(?:[A-Za-z0-9_-]{43}|[a-f0-9]{64})$/u.test(input.token) ||
    !/^[a-f0-9]{64}$/u.test(input.clientKey)
  ) {
    return null;
  }
  await consumeDriveShareRateLimit(context.sql, sha256Hex(`ip:${input.clientKey}`), 120);
  const tokenHash = sha256Hex(input.token);
  await consumeDriveShareRateLimit(context.sql, sha256Hex(`token:${tokenHash}`), 60);
  const linkRows = await context.sql<DriveShareLinkRow[]>`
      select * from helix_drive_share_link_by_token_hash(${tokenHash})
    `;
  const link = linkRows[0];
  if (link === undefined) return null;
  await consumeDriveShareRateLimit(
    context.sql,
    sha256Hex(`hour:${tokenHash}`),
    link.rate_limit_per_hour,
    3600,
  );
  const row = await withTenantPostgresContext(context.sql, { orgId: link.org_id }, async (tx) => {
    const objects = await tx<ObjectRow[]>`
        select * from objects
        where id = ${link.object_id} and org_id = ${link.org_id}
        limit 1
      `;
    const object = objects[0];
    if (object === undefined) return null;
    return {
      ...link,
      ...object,
      link_id: link.id,
      link_org_id: link.org_id,
      link_object_id: link.object_id,
      link_created_at: link.created_at,
      link_classification: link.classification,
    } satisfies DriveShareLinkAccessRow;
  });
  if (row === null) return null;
  const denied = await driveShareDenialReason(context.sql, row, input);
  if (denied !== null) {
    await appendDriveShareLinkEvent(
      context.sql,
      shareLinkRow(row),
      input.download === true ? "download" : "access",
      "denied",
      shareActorId(row, input.actor),
      input.clientKey,
      { reason: denied },
    );
    return null;
  }
  return { orgId: row.link_org_id, objectId: row.link_object_id, linkId: row.link_id };
}

export async function openFileByShareToken(
  context: DriveStoreContext,
  input: DriveShareAccessInput,
): Promise<DriveFileStreamResult | null> {
  const resolved = await resolveShareLink(context, input);
  if (resolved === null) {
    return null;
  }
  const object = await withTenantPostgresContext(
    context.sql,
    { orgId: resolved.orgId },
    async (tx) => {
      const rows = await tx<ObjectRow[]>`
          select *
          from objects
          where id = ${resolved.objectId}
            and org_id = ${resolved.orgId}
            and kind in ('file', 'recording')
            and deleted_at is null
            and coalesce(metadata->>'status', 'ready') = 'ready'
          limit 1
        `;
      const found = rows[0];
      if (found === undefined) return undefined;
      const versions = await tx<
        {
          readonly version_number: number;
        }[]
      >`
          select version_number
          from drive_versions
          where org_id = ${resolved.orgId} and object_id = ${resolved.objectId}
          order by version_number desc
          limit 1
        `;
      return { ...found, version_number: versions[0]?.version_number ?? null };
    },
  );
  if (object === undefined) {
    return null;
  }
  const storage = await storageForOrg(context, resolved.orgId);
  const head = await storage?.head?.(object.storage_key);
  const expectedBytes = bytesFromDatabase(object.byte_size);
  const storedSha256 = head?.metadata?.sha256;
  if (
    head === null ||
    head === undefined ||
    head.byteSize !== expectedBytes ||
    (storedSha256 !== undefined && object.sha256 !== null && storedSha256 !== object.sha256)
  ) {
    const rows = await context.sql<DriveShareLinkRow[]>`
        select * from helix_drive_share_link_by_token_hash(${sha256Hex(input.token)})
      `;
    if (rows[0] !== undefined) {
      await appendDriveShareLinkEvent(
        context.sql,
        rows[0],
        input.download === true ? "download" : "access",
        "integrity_error",
        shareActorId(rows[0], input.actor),
        input.clientKey,
        { expectedBytes, actualBytes: head?.byteSize ?? null },
      );
    }
    return {
      orgId: resolved.orgId,
      entry: mapObjectEntry(object),
      byteSize: expectedBytes,
      etag: driveContentEtag(object.sha256, object.id, object.version_number),
      open: async () => null,
    };
  }
  const consumed = await withTenantPostgresContext(
    context.sql,
    { orgId: resolved.orgId },
    async (tx) =>
      await tx<DriveShareLinkRow[]>`
          update drive_share_links link
          set consumed_at = case when link.one_time then statement_timestamp() else link.consumed_at end,
              access_count = link.access_count + 1,
              download_count = link.download_count + 1,
              last_access_at = statement_timestamp()
          where link.id = ${resolved.linkId}
            and link.org_id = ${resolved.orgId}
            and link.revoked_at is null
            and (link.expires_at is null or link.expires_at > statement_timestamp())
            and (not link.one_time or link.consumed_at is null)
            and (link.max_downloads is null or link.download_count < link.max_downloads)
          returning *
        `,
  );
  const link = consumed[0];
  if (link === undefined) return null;
  await appendDriveShareLinkEvent(
    context.sql,
    link,
    input.download === true ? "download" : "access",
    "allowed",
    shareActorId(link, input.actor),
    input.clientKey,
    {},
  );
  return openStoredObject(context, resolved.orgId, object);
}
