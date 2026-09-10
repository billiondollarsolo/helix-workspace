import type { JsonObject, JsonValue } from "@helix/sdk-types";
import type postgres from "postgres";
import type { DriveCommentRevisionRecord, DriveVersionRecord } from "../types.js";
export interface ObjectRow {
  readonly id: string;
  readonly org_id: string;
  readonly owner_actor_id: string | null;
  readonly kind: string;
  readonly storage_key: string;
  readonly mime_type: string;
  readonly byte_size: string | number;
  readonly sha256: string | null;
  readonly metadata: JsonObject;
  readonly deleted_at: Date | null;
  readonly trash_purge_after: Date | null;
  readonly retain_until: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface DriveVersionRow {
  readonly id: string;
  readonly org_id: string;
  readonly object_id: string;
  readonly version_number: number;
  readonly storage_key: string;
  readonly mime_type: string;
  readonly byte_size: string | number;
  readonly sha256: string;
  readonly metadata: JsonObject;
  readonly created_by_actor_id: string | null;
  readonly created_at: Date;
}

export interface DriveFolderRow {
  readonly id: string;
  readonly org_id: string;
  readonly name: string;
  readonly parent_folder_id: string | null;
  readonly owner_actor_id: string | null;
  readonly created_by_actor_id: string | null;
  readonly metadata: JsonObject;
  readonly deleted_at: Date | null;
  readonly trash_purge_after: Date | null;
  readonly retain_until: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface DriveSearchRow extends ObjectRow {
  readonly version_number: number | null;
  readonly mine?: boolean | null;
  readonly shared_count?: number | string | null;
  readonly starred?: boolean | null;
}

export interface DriveListRow {
  readonly entry_type: "file" | "folder";
  readonly id: string;
  readonly name: string;
  readonly folder_id: string | null;
  readonly owner_actor_id: string | null;
  readonly mime_type: string | null;
  readonly byte_size: string | number | null;
  readonly sha256: string | null;
  readonly storage_key: string | null;
  readonly version_number: number | null;
  readonly metadata: JsonObject;
  readonly deleted_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly mine: boolean | null;
  readonly shared_count: string | number | null;
  readonly starred: boolean | null;
  readonly sort_name: string;
  readonly sort_type: number;
  readonly snapshot_at: Date;
}

export interface DriveSearchProjectionRow extends ObjectRow {
  readonly owner_display_name: string | null;
  readonly owner_email: string | null;
  readonly folder_path: readonly string[];
  readonly allowed_actor_ids: readonly string[];
}

export interface StorageQuotaDecisionRow {
  readonly accepted: boolean;
  readonly used_bytes: string | number;
  readonly reserved_bytes: string | number;
  readonly limit_bytes: string | number | null;
  readonly projected_bytes: string | number;
}

export interface DriveAccessGrantRow {
  readonly actor_id: string;
  readonly role: string;
  readonly display_name: string | null;
  readonly email: string | null;
  readonly granted_by_actor_id: string | null;
  readonly expires_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface DriveCommentRow {
  readonly id: string;
  readonly org_id: string;
  readonly object_id: string;
  readonly parent_comment_id: string | null;
  readonly actor_id: string | null;
  readonly anchor: JsonObject;
  readonly body: string;
  readonly status: string;
  readonly metadata: JsonObject;
  readonly resolved_at: Date | null;
  readonly revision: string | number;
  readonly changed_by_actor_id: string | null;
  readonly resolved_by_actor_id: string | null;
  readonly deleted_by_actor_id: string | null;
  readonly deleted_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date | null;
}

export interface DriveCommentRevisionRow {
  readonly id: string;
  readonly org_id: string;
  readonly object_id: string;
  readonly comment_id: string;
  readonly revision: string | number;
  readonly change_kind: DriveCommentRevisionRecord["changeKind"];
  readonly parent_comment_id: string | null;
  readonly comment_actor_id: string | null;
  readonly anchor: JsonObject;
  readonly body: string;
  readonly status: DriveCommentRevisionRecord["status"];
  readonly metadata: JsonObject;
  readonly resolved_at: Date | null;
  readonly resolved_by_actor_id: string | null;
  readonly deleted_at: Date | null;
  readonly deleted_by_actor_id: string | null;
  readonly changed_by_actor_id: string;
  readonly captured_at: Date;
}

export interface DriveShareLinkRow {
  readonly id: string;
  readonly org_id: string;
  readonly token_hash: string;
  readonly object_id: string;
  readonly role: "reader";
  readonly password_hash: string | null;
  readonly max_downloads: number | null;
  readonly download_count: number;
  readonly rate_limit_per_hour: number;
  readonly one_time: boolean;
  readonly allowed_domains: readonly string[];
  readonly allow_download: boolean;
  readonly consumed_at: Date | null;
  readonly access_count: string | number;
  readonly last_access_at: Date | null;
  readonly classification: string;
  readonly expires_at: Date | null;
  readonly created_by_actor_id: string | null;
  readonly created_at: Date;
  readonly revoked_at: Date | null;
}

export interface DriveShareLinkAccessRow extends ObjectRow {
  readonly link_id: string;
  readonly link_org_id: string;
  readonly link_object_id: string;
  readonly token_hash: string;
  readonly role: "reader";
  readonly password_hash: string | null;
  readonly max_downloads: number | null;
  readonly download_count: number;
  readonly rate_limit_per_hour: number;
  readonly one_time: boolean;
  readonly allowed_domains: readonly string[];
  readonly allow_download: boolean;
  readonly consumed_at: Date | null;
  readonly access_count: string | number;
  readonly last_access_at: Date | null;
  readonly link_classification: string;
  readonly expires_at: Date | null;
  readonly created_by_actor_id: string | null;
  readonly link_created_at: Date;
  readonly revoked_at: Date | null;
}

interface DriveScanJobRow {
  readonly id: string;
  readonly org_id: string;
  readonly object_id: string;
  readonly actor_id: string | null;
  readonly status: "pending" | "processing" | "dead_lettered";
  readonly attempt_count: number;
  readonly next_attempt_at: Date | null;
  readonly finalize_metadata: JsonObject;
}

export interface DriveScanFailureRow extends DriveScanJobRow {
  readonly status: "pending" | "dead_lettered";
}

export interface DriveScanClaimRow extends DriveScanJobRow {
  readonly owner_actor_id: string | null;
  readonly storage_key: string;
  readonly mime_type: string;
  readonly byte_size: string | number;
  readonly sha256: string | null;
}

export interface DriveQuarantineDeletionRow {
  readonly id: string;
  readonly org_id: string;
  readonly object_id: string;
  readonly actor_id: string | null;
  readonly storage_key: string;
  readonly status: "pending" | "processing" | "completed";
  readonly attempt_count: number;
  readonly next_attempt_at: Date;
  readonly completed_at?: Date | null;
}

export interface DriveMultipartSessionRow {
  readonly id: string;
  readonly org_id: string;
  readonly object_id: string;
  readonly actor_id: string | null;
  readonly storage_key: string;
  readonly upload_id: string | null;
  readonly status:
    "provisioning" | "pending" | "completing" | "uploaded" | "completed" | "aborting";
  readonly byte_size: string | number;
  readonly part_size: number;
  readonly part_count: number;
  readonly expires_at: Date;
  readonly lease_expires_at: Date | null;
  readonly completion_hash: string | null;
  readonly version_id: string | null;
  readonly last_error: string | null;
}

export interface DriveMultipartSweepRow extends DriveMultipartSessionRow {
  readonly prior_status: DriveMultipartSessionRow["status"];
}

export interface DriveMultipartClaim {
  readonly session: DriveMultipartSessionRow;
  readonly object: ObjectRow;
  readonly version?: DriveVersionRecord;
  readonly completeStorage: boolean;
}

export interface DriveFinalizationClaim {
  readonly object: ObjectRow;
  readonly token: string;
  readonly previousStatus: string;
  readonly reservedKey: string;
  readonly versionNumber: number;
}

export type DrivePreparedUploadSweepRow = ObjectRow;

export interface DriveCommentProjectionRow extends DriveCommentRow {
  readonly actor_display_name: string | null;
  readonly actor_email: string | null;
}

export interface DriveCommentObjectContext extends ObjectRow {
  readonly comment_role_rank: number;
}

export interface DriveWebDavLockRow {
  readonly path_key: string;
  readonly token: string;
  readonly actor_id: string;
  readonly owner: string;
  readonly depth: "0" | "infinity";
  readonly fence: string | number;
  readonly created_at: Date;
  readonly expires_at: Date;
}

export interface DriveWebDavCollectionRow {
  readonly version: string | number;
  readonly min_version: string | number;
}

export interface DriveWebDavChangeRow {
  readonly resource_path_key: string;
  readonly resource_type: "file" | "folder";
  readonly status: 200 | 404;
  readonly version: string | number;
}

export type SqlLike = postgres.Sql | postgres.TransactionSql;

export interface DriveStorageQuotaRow {
  readonly storage_bytes_limit: JsonValue | null;
  readonly storage_used_bytes: string | number;
}

export interface DriveCommentCursor {
  readonly id: string;
}

export interface DriveListCursor {
  readonly name: string;
  readonly type: number;
  readonly id: string;
  readonly snapshotAt: Date;
  readonly filter: string;
}

export interface DriveSharePolicyRow {
  readonly classification: string | null;
  readonly external_settings: JsonObject | null;
  readonly dlp_settings: JsonObject | null;
}
