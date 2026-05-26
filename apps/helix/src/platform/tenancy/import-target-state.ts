import type postgres from "postgres";
import type {
  TenantImportPlanExistingNaturalKey,
  TenantImportPlanExistingRowId,
  TenantImportPlanTargetState,
} from "./import-plan.js";

export interface LoadTenantImportTargetStateInput {
  readonly sql: postgres.Sql;
  readonly targetOrgId: string;
}

interface TargetAdminDomainRow {
  readonly id: string;
  readonly domain: string;
  readonly is_primary: boolean;
}

interface TargetAdminDnsRecordRow {
  readonly id: string;
  readonly domain_id: string;
  readonly record_type: string;
  readonly host: string;
}

interface TargetObjectRow {
  readonly id: string;
  readonly storage_key: string;
}

interface TargetDriveFolderRow {
  readonly id: string;
  readonly parent_folder_id: string | null;
  readonly name: string;
}

interface TargetDriveVersionRow {
  readonly id: string;
  readonly object_id: string;
  readonly version_number: number;
}

interface TargetResourceClassificationRow {
  readonly id: string;
  readonly resource_type: string;
  readonly resource_id: string;
}

export async function loadTenantImportTargetStateFromPostgres(
  input: LoadTenantImportTargetStateInput,
): Promise<TenantImportPlanTargetState> {
  const adminDomains = (await input.sql`
    select id, domain, is_primary
    from admin_domains
    where org_id = ${input.targetOrgId}
    order by is_primary desc, lower(domain) asc, id asc
  `) as unknown as readonly TargetAdminDomainRow[];
  const adminDnsRecords = (await input.sql`
    select id, domain_id, record_type, host
    from admin_dns_records
    where org_id = ${input.targetOrgId}
    order by domain_id asc, record_type asc, host asc, id asc
  `) as unknown as readonly TargetAdminDnsRecordRow[];
  const objects = (await input.sql`
    select id, storage_key
    from objects
    where org_id = ${input.targetOrgId}
    order by storage_key asc, id asc
  `) as unknown as readonly TargetObjectRow[];
  const driveFolders = (await input.sql`
    select id, parent_folder_id, name
    from drive_folders
    where org_id = ${input.targetOrgId}
    order by parent_folder_id asc nulls first, lower(name) asc, id asc
  `) as unknown as readonly TargetDriveFolderRow[];
  const driveVersions = (await input.sql`
    select id, object_id, version_number
    from drive_versions
    where org_id = ${input.targetOrgId}
    order by object_id asc, version_number asc, id asc
  `) as unknown as readonly TargetDriveVersionRow[];
  const resourceClassifications = (await input.sql`
    select id, resource_type, resource_id
    from resource_classifications
    where org_id = ${input.targetOrgId}
    order by resource_type asc, resource_id asc, id asc
  `) as unknown as readonly TargetResourceClassificationRow[];

  const existingRowIds: TenantImportPlanExistingRowId[] = [];
  const existingNaturalKeys: TenantImportPlanExistingNaturalKey[] = [];

  for (const row of adminDomains) {
    existingRowIds.push({
      table: "admin_domains",
      id: row.id,
      targetId: row.id,
    });
    existingNaturalKeys.push({
      table: "admin_domains",
      naturalKey: [row.domain.toLowerCase()],
      targetId: row.id,
    });
  }

  for (const row of adminDnsRecords) {
    existingRowIds.push({
      table: "admin_dns_records",
      id: row.id,
      targetId: row.id,
    });
    existingNaturalKeys.push({
      table: "admin_dns_records",
      naturalKey: [row.domain_id, row.record_type, row.host],
      targetId: row.id,
    });
  }

  for (const row of objects) {
    existingRowIds.push({
      table: "objects",
      id: row.id,
      targetId: row.id,
    });
    existingNaturalKeys.push({
      table: "objects",
      naturalKey: [row.storage_key],
      targetId: row.id,
    });
  }

  for (const row of driveFolders) {
    existingRowIds.push({
      table: "drive_folders",
      id: row.id,
      targetId: row.id,
    });
    existingNaturalKeys.push({
      table: "drive_folders",
      naturalKey: [row.parent_folder_id ?? "", row.name],
      targetId: row.id,
    });
  }

  for (const row of driveVersions) {
    existingRowIds.push({
      table: "drive_versions",
      id: row.id,
      targetId: row.id,
    });
    existingNaturalKeys.push({
      table: "drive_versions",
      naturalKey: [row.object_id, String(row.version_number)],
      targetId: row.id,
    });
  }

  for (const row of resourceClassifications) {
    existingRowIds.push({
      table: "resource_classifications",
      id: row.id,
      targetId: row.id,
    });
    existingNaturalKeys.push({
      table: "resource_classifications",
      naturalKey: [row.resource_type, row.resource_id],
      targetId: row.id,
    });
  }

  return {
    existingRowIds,
    existingNaturalKeys,
    primaryDomain: adminDomains.find((row) => row.is_primary)?.domain.toLowerCase() ?? null,
  };
}
