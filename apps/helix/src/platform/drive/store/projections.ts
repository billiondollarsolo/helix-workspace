import { toSqlJson } from "../../util/sql.js";
import type { DriveAutoTagWrite, DriveEnrichmentWrite, DriveSearchRecord } from "../types.js";
import { type DriveStoreContext } from "./context.js";
import { mapDriveSearchRecord } from "./mappers.js";
import { type DriveSearchProjectionRow } from "./rows.js";
import { isTextFile, readSearchText, SEARCH_FILE_BYTES } from "../text-content.js";
import { readStoredUpload, storageForOrg } from "./storage.js";
function uniqueStrings(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length > 0 && !seen.has(trimmed)) {
      seen.add(trimmed);
      output.push(trimmed);
    }
  }
  return output;
}

export async function getDriveSearchRecord(
  context: DriveStoreContext,
  fileId: string,
  includeContent = false,
): Promise<DriveSearchRecord | null> {
  const rows = await context.sql<DriveSearchProjectionRow[]>`
      with recursive target as (
        select *
        from objects
        where id = ${fileId}
          and kind = 'file'
          and deleted_at is null
          and coalesce(metadata->>'status', 'ready') = 'ready'
        limit 1
      ),
      folder_path as (
        select f.id, f.parent_folder_id, array[f.name]::text[] as path
        from drive_folders f
        join target t on f.id::text = t.metadata->>'folderId'
        union all
        select f.id, f.parent_folder_id, array[f.name]::text[] || fp.path
        from drive_folders f
        join folder_path fp on fp.parent_folder_id = f.id
      )
      select
        t.*,
        a.display_name as owner_display_name,
        a.email as owner_email,
        coalesce(
          (select fp.path from folder_path fp where fp.parent_folder_id is null limit 1),
          array[]::text[]
        ) as folder_path,
        helix_drive_visible_actor_ids(t.org_id, 'object', t.id)::text[] as allowed_actor_ids
      from target t
      left join actors a on a.id = t.owner_actor_id and a.org_id = t.org_id
    `;
  const row = rows[0];
  if (row === undefined) return null;
  const record = mapDriveSearchRecord(row);
  if (
    !includeContent ||
    row.metadata.status !== "ready" ||
    row.sha256 === null ||
    record.byteSize > SEARCH_FILE_BYTES ||
    !isTextFile(record.mimeType, record.name)
  )
    return record;
  const storage = await storageForOrg(context, record.orgId);
  const content = await readStoredUpload(storage, row.storage_key);
  if (content === undefined || content === null)
    throw new Error("Search source file contents are unavailable.");
  const textContent = await readSearchText(content.body, row.sha256);
  // Storage I/O can race edits, malware quarantine, or grant revocation: reload authoritative metadata.
  const current = await getDriveSearchRecord(context, fileId);
  return current?.sha256 === row.sha256 && current.metadata?.status === "ready"
    ? { ...current, textContent }
    : null;
}

export function getDriveEnrichmentRecord(
  context: DriveStoreContext,
  fileId: string,
): Promise<DriveSearchRecord | null> {
  return getDriveSearchRecord(context, fileId);
}

export async function recordDriveEnrichment(
  context: DriveStoreContext,
  input: DriveEnrichmentWrite,
): Promise<void> {
  await context.sql`
      update objects
      set
        metadata = jsonb_set(
          metadata,
          '{enrichments}',
          coalesce(metadata->'enrichments', '{}'::jsonb) ||
            jsonb_build_object(${input.feature}::text, ${context.sql.json(toSqlJson(input.data))}::jsonb),
          true
        ),
        updated_at = now()
      where id = ${input.fileId}
        and kind = 'file'
        and deleted_at is null
        and coalesce(metadata->>'status', 'ready') = 'ready'
    `;
}

export async function setDriveAutoTags(
  context: DriveStoreContext,
  input: DriveAutoTagWrite,
): Promise<void> {
  const tags = uniqueStrings(input.tags);
  await context.sql`
      update objects
      set
        metadata = metadata || ${context.sql.json(
          toSqlJson({
            tags,
            autoTag: {
              source: input.source,
              tags,
              updatedAt: new Date().toISOString(),
            },
          }),
        )}::jsonb,
        updated_at = now()
      where id = ${input.fileId}
        and kind = 'file'
        and deleted_at is null
        and coalesce(metadata->>'status', 'ready') = 'ready'
    `;
}
