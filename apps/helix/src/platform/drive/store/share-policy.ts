import type { JsonObject } from "@helix/sdk-types";
import { createHash } from "node:crypto";
import { RateLimitedError } from "../../../api/api-error.js";
import { verifySecret } from "../../auth/oauth.js";
import { toSqlJson } from "../../util/sql.js";
import { stringMetadata } from "../core/mappers.js";
import { DriveForbiddenError } from "../errors.js";
import { verifyDriveSharePassword } from "../share-link-security.js";
import { UUID_RE } from "./activity.js";
import { type DriveShareAccessInput, type DriveShareLinkRecord } from "./contracts.js";
import {
  type DriveShareLinkAccessRow,
  type DriveShareLinkRow,
  type DriveSharePolicyRow,
  type ObjectRow,
  type SqlLike,
} from "./rows.js";
const SHARE_DOMAIN_RE =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function requireSharePassword(password: string): string {
  if (password.length < 12 || password.length > 256) {
    throw new TypeError("Share-link passwords must contain 12 to 256 characters.");
  }
  return password;
}

export function normalizeShareDomains(domains: readonly string[]): readonly string[] {
  const normalized = [...new Set(domains.map((domain) => domain.trim().toLowerCase()))].sort();
  if (normalized.length > 50 || normalized.some((domain) => !SHARE_DOMAIN_RE.test(domain))) {
    throw new TypeError("Share-link domains must be valid lower-case DNS names (maximum 50).");
  }
  return normalized;
}

async function driveSharePolicyReason(
  sql: SqlLike,
  object: Pick<ObjectRow, "id" | "org_id" | "metadata">,
  allowedDomains: readonly string[],
): Promise<{
  readonly reason: string | null;
  readonly classification: string;
}> {
  const rows = await sql<DriveSharePolicyRow[]>`
    select
      (select classification.classification
       from resource_classifications classification
       where classification.org_id = ${object.org_id}
         and classification.resource_type = 'drive.file'
         and classification.resource_id = ${object.id}
       limit 1) as classification,
      (select policy.settings from admin_security_policies policy
       where policy.org_id = ${object.org_id} and policy.policy_type = 'external_sharing'
         and policy.enabled and policy.enforcement <> 'disabled'
       limit 1) as external_settings,
      (select policy.settings from admin_security_policies policy
       where policy.org_id = ${object.org_id} and policy.policy_type = 'dlp'
         and policy.enabled and policy.enforcement <> 'disabled'
       limit 1) as dlp_settings
  `;
  const policy = rows[0];
  const storedClassification = policy?.classification;
  const classification =
    storedClassification === "public" ||
    storedClassification === "standard" ||
    storedClassification === "confidential" ||
    storedClassification === "restricted"
      ? storedClassification
      : "standard";
  if (classification === "confidential" || classification === "restricted") {
    return { reason: "classification_blocks_public_link", classification };
  }
  const externalMode = policy?.external_settings?.mode;
  if (externalMode === "blocked") {
    return { reason: "external_sharing_blocked", classification };
  }
  if (externalMode === "allowlist") {
    const configured = new Set(
      Array.isArray(policy?.external_settings?.allowedDomains)
        ? policy.external_settings.allowedDomains.filter(
            (domain): domain is string => typeof domain === "string",
          )
        : [],
    );
    if (allowedDomains.length === 0 || allowedDomains.some((domain) => !configured.has(domain))) {
      return { reason: "domain_not_allowlisted", classification };
    }
  }
  const dlp = policy?.dlp_settings;
  if (
    dlp?.action === "block" &&
    dlp.scanSharedDocs !== false &&
    !["clean", "allowed"].includes(stringMetadata(object.metadata, "dlpVerdict") ?? "")
  ) {
    return { reason: "dlp_verdict_required", classification };
  }
  return { reason: null, classification };
}

export async function assertDriveSharePolicy(
  sql: SqlLike,
  object: ObjectRow,
  allowedDomains: readonly string[],
): Promise<string> {
  const denied = await driveSharePolicyReason(sql, object, allowedDomains);
  if (denied.reason !== null) {
    throw new DriveForbiddenError(`Drive public link rejected: ${denied.reason}.`);
  }
  return denied.classification;
}

export async function consumeDriveShareRateLimit(
  sql: SqlLike,
  scopeHash: string,
  limit: number,
  windowSeconds = 60,
): Promise<void> {
  const rows = await sql<
    {
      readonly allowed: boolean;
    }[]
  >`
    select helix_consume_drive_share_rate_limit(${scopeHash}, ${limit}, ${windowSeconds}) as allowed
  `;
  if (rows[0]?.allowed !== true) {
    throw new RateLimitedError("Share-link request limit exceeded.", {
      retryAfterSeconds: windowSeconds,
    });
  }
}

export function shareLinkRow(row: DriveShareLinkAccessRow): DriveShareLinkRow {
  return {
    id: row.link_id,
    org_id: row.link_org_id,
    token_hash: row.token_hash,
    object_id: row.link_object_id,
    role: "reader",
    password_hash: row.password_hash,
    max_downloads: row.max_downloads,
    download_count: row.download_count,
    rate_limit_per_hour: row.rate_limit_per_hour,
    one_time: row.one_time,
    allowed_domains: row.allowed_domains,
    allow_download: row.allow_download,
    consumed_at: row.consumed_at,
    access_count: row.access_count,
    last_access_at: row.last_access_at,
    classification: row.link_classification,
    expires_at: row.expires_at,
    created_by_actor_id: row.created_by_actor_id,
    created_at: row.link_created_at,
    revoked_at: row.revoked_at,
  };
}

export function shareActorId(
  link: Pick<DriveShareLinkRow, "org_id">,
  actor: DriveShareAccessInput["actor"],
): string | null {
  return actor?.orgId === link.org_id && UUID_RE.test(actor.id) ? actor.id : null;
}

export async function appendDriveShareLinkEvent(
  sql: SqlLike,
  link: DriveShareLinkRow,
  eventType: "create" | "access" | "download" | "revoke",
  outcome: "allowed" | "denied" | "integrity_error",
  actorId: string | null,
  clientKey: string | null,
  details: JsonObject,
): Promise<void> {
  await sql`
    select helix_append_drive_share_link_event(
      ${link.org_id}, ${link.id}, ${eventType}, ${outcome}, ${actorId}, ${clientKey},
      ${sql.json(toSqlJson(details))}::jsonb
    )
  `;
}

export async function driveShareDenialReason(
  sql: SqlLike,
  row: DriveShareLinkAccessRow,
  input: DriveShareAccessInput,
): Promise<string | null> {
  if (
    row.revoked_at !== null ||
    (row.expires_at !== null && row.expires_at <= new Date()) ||
    (row.one_time && row.consumed_at !== null) ||
    (row.max_downloads !== null && row.download_count >= row.max_downloads) ||
    row.deleted_at !== null ||
    (stringMetadata(row.metadata, "status") !== undefined &&
      stringMetadata(row.metadata, "status") !== "ready")
  ) {
    return "unavailable";
  }
  if (input.download === true && !row.allow_download) return "download_blocked";
  if (
    row.password_hash !== null &&
    (input.password === undefined ||
      !(await (row.password_hash.startsWith("scrypt:")
        ? verifyDriveSharePassword(input.password, row.password_hash)
        : verifySecret(input.password, row.password_hash))))
  ) {
    return "password_invalid";
  }
  if (row.allowed_domains.length > 0) {
    const actorDomain = input.actor?.email?.split("@").at(-1)?.toLowerCase();
    if (
      input.actor?.orgId !== row.link_org_id ||
      actorDomain === undefined ||
      !row.allowed_domains.includes(actorDomain)
    ) {
      return "domain_identity_required";
    }
  }
  return (await driveSharePolicyReason(sql, row, row.allowed_domains)).reason;
}

export function mapShareLink(
  row: DriveShareLinkRow,
  token: string | null = null,
): DriveShareLinkRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    objectId: row.object_id,
    token,
    role: "reader",
    expiresAt: row.expires_at,
    passwordProtected: row.password_hash !== null,
    maxDownloads: row.max_downloads,
    downloadCount: row.download_count,
    rateLimitPerHour: row.rate_limit_per_hour,
    oneTime: row.one_time,
    allowedDomains: [...row.allowed_domains],
    allowDownload: row.allow_download,
    consumedAt: row.consumed_at,
    createdByActorId: row.created_by_actor_id,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}
