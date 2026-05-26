import type { JsonObject, JsonValue } from "@helix/sdk-types";
import type {
  TenantExportManifest,
  TenantExportPostgresDataChunkManifest,
  TenantExportSelfFetchManifest,
} from "./export.js";
import {
  validateTenantExportPostgresDataChunks,
  type TenantExportValidationFiles,
  type TenantExportValidationIssue,
  type TenantExportValidationResult,
} from "./export-validation.js";

export type TenantImportPlanPostgresTable =
  | "admin_domains"
  | "admin_dns_records"
  | "objects"
  | "drive_versions"
  | "resource_classifications";

export type TenantImportPlanObjectBytesMode = "included" | "metadata_only";

export type TenantImportPlanIssueSeverity = "error" | "warning";

export type TenantImportPlanIssueCode =
  | "export_validation_failed"
  | "org_id_remap_required"
  | "domain_id_remap_required"
  | "object_id_remap_required"
  | "principal_remap_required"
  | "resource_reference_deferred"
  | "verified_state_requires_recheck"
  | "primary_domain_conflict_check_required"
  | "target_primary_key_conflict"
  | "target_natural_key_conflict"
  | "target_primary_domain_conflict"
  | "principal_remap_missing"
  | "resource_remap_missing";

export type TenantImportPlanOperationKind =
  | "upsert_admin_domain"
  | "upsert_admin_dns_record"
  | "upsert_object"
  | "upsert_drive_version"
  | "upsert_resource_classification";

export type TenantImportPlanOperationAction = "insert" | "update" | "blocked";

export type TenantImportPlanConflictPolicyMode = "preserve" | "match" | "regenerate" | "null";

export type TenantImportPlanConflictPolicyReferenceField =
  | "createdBy"
  | "createdByActorId"
  | "actorId"
  | "ownerActorId"
  | "domainId"
  | "objectId"
  | "resourceId";

export type TenantImportPlanConflictPolicyStateField =
  | "verificationStatus"
  | "verifiedAt"
  | "isPrimary"
  | "status"
  | "observedValue"
  | "lastCheckedAt";

export interface TenantImportDryRunConflictPolicy {
  readonly rowIdConflicts?: "regenerate" | "preserve" | undefined;
  readonly principalReferences?: "preserve" | "null" | undefined;
  readonly resourceReferences?: "require-remap" | "preserve" | undefined;
  readonly verifiedState?: "regenerate" | "preserve" | undefined;
  readonly primaryDomain?: "preserve" | "null" | undefined;
}

export interface TenantImportPlanOperationConflictPolicy {
  readonly rowId: TenantImportPlanConflictPolicyMode;
  readonly references: Readonly<Record<string, TenantImportPlanConflictPolicyMode>>;
  readonly state: Readonly<Record<string, TenantImportPlanConflictPolicyMode>>;
}

export interface BuildTenantImportPlanInput {
  readonly manifest: TenantExportManifest;
  readonly files: TenantExportValidationFiles;
  readonly targetOrgId?: string | undefined;
  readonly targetSlug?: string | undefined;
  readonly remaps?: TenantImportPlanProvidedRemaps | undefined;
  readonly targetState?: TenantImportPlanTargetState | undefined;
  readonly conflictPolicy?: TenantImportDryRunConflictPolicy | undefined;
}

export interface BuildTenantImportPlanFromArchiveInput {
  readonly archive: Uint8Array;
  readonly targetOrgId?: string | undefined;
  readonly targetSlug?: string | undefined;
  readonly remaps?: TenantImportPlanProvidedRemaps | undefined;
  readonly targetState?: TenantImportPlanTargetState | undefined;
  readonly conflictPolicy?: TenantImportDryRunConflictPolicy | undefined;
}

export interface TenantImportPlanProvidedRemaps {
  readonly principals?: Readonly<Record<string, string | null>> | undefined;
  readonly resources?: Readonly<Record<string, string>> | undefined;
}

export interface TenantImportPlanTargetState {
  readonly existingRowIds?: readonly TenantImportPlanExistingRowId[] | undefined;
  readonly existingNaturalKeys?: readonly TenantImportPlanExistingNaturalKey[] | undefined;
  readonly primaryDomain?: string | null | undefined;
}

export interface TenantImportPlanExistingRowId {
  readonly table: TenantImportPlanPostgresTable;
  readonly id: string;
  readonly targetId?: string | undefined;
}

export interface TenantImportPlanExistingNaturalKey {
  readonly table: TenantImportPlanPostgresTable;
  readonly naturalKey: readonly string[];
  readonly targetId?: string | undefined;
}

export type TenantImportArchiveReadIssueCode =
  | "invalid_tar_archive"
  | "unsafe_archive_path"
  | "duplicate_archive_entry"
  | "missing_archive_entry"
  | "invalid_archive_json"
  | "invalid_archive_manifest";

export interface TenantImportArchiveReadIssue {
  readonly severity: "error";
  readonly code: TenantImportArchiveReadIssueCode;
  readonly message: string;
  readonly path?: string | undefined;
  readonly expected?: unknown;
  readonly actual?: unknown;
}

export interface TenantImportArchivePlanResult {
  readonly ok: boolean;
  readonly issues: readonly TenantImportArchiveReadIssue[];
  readonly plan?: TenantImportPlan | undefined;
}

export interface TenantImportPreparedArchive {
  readonly entries: ReadonlyMap<string, Uint8Array>;
  readonly manifest: TenantExportManifest;
  readonly rowChunkFiles: ReadonlyMap<string, Uint8Array>;
  readonly selfFetchManifest?: TenantExportSelfFetchManifest | undefined;
}

export type TenantImportPreparedArchiveResult =
  | {
      readonly ok: true;
      readonly issues: readonly [];
      readonly archive: TenantImportPreparedArchive;
    }
  | {
      readonly ok: false;
      readonly issues: readonly TenantImportArchiveReadIssue[];
    };

export interface TenantImportPlanIssue {
  readonly severity: TenantImportPlanIssueSeverity;
  readonly code: TenantImportPlanIssueCode;
  readonly message: string;
  readonly table?: TenantImportPlanPostgresTable | undefined;
  readonly path?: string | undefined;
  readonly line?: number | undefined;
  readonly sourceId?: string | undefined;
  readonly field?: string | undefined;
  readonly expected?: unknown;
  readonly actual?: unknown;
  readonly validationIssues?: readonly TenantExportValidationIssue[] | undefined;
}

export interface TenantImportPlanOperation {
  readonly order: number;
  readonly kind: TenantImportPlanOperationKind;
  readonly table: TenantImportPlanPostgresTable;
  readonly path: string;
  readonly line: number;
  readonly action: TenantImportPlanOperationAction;
  readonly sourceId: string;
  readonly targetId: string | null;
  readonly sourceOrgId: string;
  readonly targetOrgId: string;
  readonly naturalKey: readonly string[];
  readonly dependsOn: readonly string[];
  readonly remappedFields: Readonly<Record<string, unknown>>;
  readonly conflictPolicy: TenantImportPlanOperationConflictPolicy;
  readonly row: Readonly<Record<string, unknown>>;
}

export type TenantImportPlanRemapKind = "org" | "row_id" | "principal" | "resource";

export type TenantImportPlanRemapStatus = "identity" | "rewrite" | "pending" | "unresolved";

export interface TenantImportPlanRemapEntry {
  readonly kind: TenantImportPlanRemapKind;
  readonly status: TenantImportPlanRemapStatus;
  readonly sourceId: string;
  readonly targetId?: string | undefined;
  readonly table?: TenantImportPlanPostgresTable | undefined;
  readonly naturalKey?: readonly string[] | undefined;
  readonly resourceType?: string | undefined;
  readonly reason: string;
}

export type TenantImportPlanConflictSeverity = "warning" | "error";

export type TenantImportPlanConflictCode =
  | "target_primary_key_conflict"
  | "target_natural_key_conflict"
  | "target_primary_domain_conflict";

export interface TenantImportPlanConflict {
  readonly severity: TenantImportPlanConflictSeverity;
  readonly code: TenantImportPlanConflictCode;
  readonly table: TenantImportPlanPostgresTable;
  readonly message: string;
  readonly sourceId?: string | undefined;
  readonly targetId?: string | undefined;
  readonly naturalKey?: readonly string[] | undefined;
  readonly field?: string | undefined;
}

export interface TenantImportPlanStep {
  readonly order: number;
  readonly kind: "postgres_rows" | "storage_objects" | "tenant_config";
  readonly label: string;
  readonly table?: TenantImportPlanPostgresTable | undefined;
  readonly path?: string | undefined;
  readonly rowCount?: number | undefined;
}

export interface TenantImportPlan {
  readonly dryRun: true;
  readonly ok: boolean;
  readonly source: {
    readonly orgId: string;
    readonly slug: string;
    readonly generatedAt: string;
  };
  readonly target: {
    readonly orgId: string;
    readonly slug?: string | undefined;
    readonly rewritesOrgId: boolean;
  };
  readonly validation: TenantExportValidationResult;
  readonly objectBytes: {
    readonly mode: TenantImportPlanObjectBytesMode;
    readonly objectCount: number;
    readonly totalKnownBytes: number;
  };
  readonly summary: {
    readonly postgresRows: number;
    readonly adminDomainRows: number;
    readonly adminDnsRecordRows: number;
    readonly objectRows: number;
    readonly driveVersionRows: number;
    readonly resourceClassificationRows: number;
    readonly operationCount: number;
    readonly remapCount: number;
    readonly conflictCount: number;
  };
  readonly steps: readonly TenantImportPlanStep[];
  readonly issues: readonly TenantImportPlanIssue[];
  readonly remaps: readonly TenantImportPlanRemapEntry[];
  readonly conflicts: readonly TenantImportPlanConflict[];
  readonly operations: readonly TenantImportPlanOperation[];
}

type JsonRecord = Record<string, unknown>;

interface ChunkDefinition {
  readonly table: TenantImportPlanPostgresTable;
  readonly path: string;
  readonly operationKind: TenantImportPlanOperationKind;
  readonly label: string;
}

const chunkDefinitions: readonly ChunkDefinition[] = [
  {
    table: "admin_domains",
    path: "postgres/data/chunks/admin_domains/000000.jsonl",
    operationKind: "upsert_admin_domain",
    label: "Plan admin domain rows",
  },
  {
    table: "admin_dns_records",
    path: "postgres/data/chunks/admin_dns_records/000000.jsonl",
    operationKind: "upsert_admin_dns_record",
    label: "Plan admin DNS record rows",
  },
  {
    table: "objects",
    path: "postgres/data/chunks/objects/000000.jsonl",
    operationKind: "upsert_object",
    label: "Plan object metadata rows",
  },
  {
    table: "drive_versions",
    path: "postgres/data/chunks/drive_versions/000000.jsonl",
    operationKind: "upsert_drive_version",
    label: "Plan Drive version metadata rows",
  },
  {
    table: "resource_classifications",
    path: "postgres/data/chunks/resource_classifications/000000.jsonl",
    operationKind: "upsert_resource_classification",
    label: "Plan resource classification rows",
  },
];

const chunkDefinitionsByTable = new Map(chunkDefinitions.map((chunk) => [chunk.table, chunk]));

export function buildTenantImportPlan(input: BuildTenantImportPlanInput): TenantImportPlan {
  const sourceOrgId = input.manifest.org.id;
  const targetOrgId = input.targetOrgId ?? sourceOrgId;
  const validation = validateTenantExportPostgresDataChunks({
    manifest: input.manifest,
    files: input.files,
  });
  const objectBytes = {
    mode: input.manifest.objectInventory.bytesIncluded
      ? ("included" as const)
      : ("metadata_only" as const),
    objectCount: input.manifest.objectInventory.objectCount,
    totalKnownBytes: input.manifest.objectInventory.totalKnownBytes,
  };
  const base = {
    dryRun: true as const,
    source: {
      orgId: sourceOrgId,
      slug: input.manifest.org.slug,
      generatedAt: input.manifest.generatedAt,
    },
    target: {
      orgId: targetOrgId,
      ...(input.targetSlug === undefined ? {} : { slug: input.targetSlug }),
      rewritesOrgId: targetOrgId !== sourceOrgId,
    },
    validation,
    objectBytes,
  };

  if (!validation.ok) {
    const validationErrors = validation.issues.filter((issue) => issue.severity === "error");
    return {
      ...base,
      ok: false,
      summary: planSummary(validation, 0),
      steps: [],
      issues: [
        {
          severity: "error",
          code: "export_validation_failed",
          message: "Tenant export row data failed import preflight validation.",
          validationIssues: validationErrors,
        },
      ],
      remaps: [],
      conflicts: [],
      operations: [],
    };
  }

  const files = normalizeFiles(input.files);
  const rowsByTable = readRowsByTable(input.manifest, files);
  const remaps = buildRemaps({
    sourceOrgId,
    targetOrgId,
    rowsByTable,
    providedRemaps: input.remaps,
    targetState: input.targetState,
  });
  const operations = buildOperations({
    sourceOrgId,
    targetOrgId,
    rowsByTable,
    providedRemaps: input.remaps,
    targetState: input.targetState,
    providedConflictPolicy: input.conflictPolicy,
  });
  const conflicts = buildConflicts({
    targetState: input.targetState,
    operations,
    rowsByTable,
  });
  const issues = buildPlanIssues({
    sourceOrgId,
    targetOrgId,
    rowsByTable,
    conflicts,
    providedRemaps: input.remaps,
  });

  return {
    ...base,
    ok: issues.every((issue) => issue.severity !== "error"),
    summary: planSummary(validation, operations.length, remaps.length, conflicts.length),
    steps: buildSteps(input.manifest, validation),
    issues,
    remaps,
    conflicts,
    operations,
  };
}

export const buildTenantExportImportPlan = buildTenantImportPlan;

export function buildTenantImportPlanFromArchive(
  input: BuildTenantImportPlanFromArchiveInput,
): TenantImportArchivePlanResult {
  const prepared = readTenantImportPreparedArchive(input.archive);
  if (!prepared.ok) {
    return {
      ok: false,
      issues: prepared.issues,
    };
  }

  const plan = buildTenantImportPlan({
    manifest: prepared.archive.manifest,
    files: prepared.archive.rowChunkFiles,
    ...(input.targetOrgId === undefined ? {} : { targetOrgId: input.targetOrgId }),
    ...(input.targetSlug === undefined ? {} : { targetSlug: input.targetSlug }),
    ...(input.remaps === undefined ? {} : { remaps: input.remaps }),
    ...(input.targetState === undefined ? {} : { targetState: input.targetState }),
    ...(input.conflictPolicy === undefined ? {} : { conflictPolicy: input.conflictPolicy }),
  });
  return {
    ok: plan.ok,
    issues: [],
    plan,
  };
}

export function readTenantImportPreparedArchive(
  archiveBytes: Uint8Array,
): TenantImportPreparedArchiveResult {
  const archive = readTenantExportArchive(archiveBytes);
  if (archive.issues.length > 0) {
    return {
      ok: false,
      issues: archive.issues,
    };
  }
  const manifestJson = readRequiredJsonRecord(archive.entries, "manifest.json");
  const configSnapshot = readRequiredJsonRecord(archive.entries, "config-snapshot.json");
  const objectInventory = readRequiredJsonRecord(archive.entries, "objects/inventory.json");
  const rowDataChunks = readRequiredJsonRecord(
    archive.entries,
    "postgres/data/chunks/manifest.json",
  );
  const selfFetchManifest = readOptionalTenantExportSelfFetchManifest(archive.entries);
  const issues = [
    ...manifestJson.issues,
    ...configSnapshot.issues,
    ...objectInventory.issues,
    ...rowDataChunks.issues,
    ...selfFetchManifest.issues,
  ];
  if (issues.length > 0) {
    return {
      ok: false,
      issues,
    };
  }

  const manifest = tenantExportManifestFromArchiveEntries({
    manifest: manifestJson.value,
    configSnapshot: configSnapshot.value,
    objectInventory: objectInventory.value,
    rowDataChunks: rowDataChunks.value,
  });
  if (manifest.issues.length > 0) {
    return {
      ok: false,
      issues: manifest.issues,
    };
  }

  return {
    ok: true,
    issues: [],
    archive: {
      entries: archive.entries,
      manifest: manifest.value,
      rowChunkFiles: tenantExportRowChunkFilesFromArchive(archive.entries),
      ...(selfFetchManifest.value === undefined
        ? {}
        : { selfFetchManifest: selfFetchManifest.value }),
    },
  };
}

function planSummary(
  validation: TenantExportValidationResult,
  operationCount: number,
  remapCount = 0,
  conflictCount = 0,
): TenantImportPlan["summary"] {
  const {
    adminDomainRows,
    adminDnsRecordRows,
    objectRows,
    driveVersionRows,
    resourceClassificationRows,
  } = validation.summary;
  return {
    postgresRows:
      adminDomainRows +
      adminDnsRecordRows +
      objectRows +
      driveVersionRows +
      resourceClassificationRows,
    adminDomainRows,
    adminDnsRecordRows,
    objectRows,
    driveVersionRows,
    resourceClassificationRows,
    operationCount,
    remapCount,
    conflictCount,
  };
}

function buildSteps(
  manifest: TenantExportManifest,
  validation: TenantExportValidationResult,
): readonly TenantImportPlanStep[] {
  const steps: TenantImportPlanStep[] = [
    {
      order: 1,
      kind: "tenant_config",
      label: "Review tenant config snapshot for target org policy compatibility",
    },
    {
      order: 2,
      kind: "storage_objects",
      label: manifest.objectInventory.bytesIncluded
        ? "Plan object restore from included archive bytes"
        : "Plan object restore from metadata or self-fetch inventory",
    },
  ];
  let order = steps.length + 1;
  for (const chunk of manifest.postgres.rowDataChunks.chunks) {
    const definition = chunkDefinitionsByTable.get(chunk.table as TenantImportPlanPostgresTable);
    if (definition === undefined) {
      continue;
    }
    steps.push({
      order,
      kind: "postgres_rows",
      label: definition.label,
      table: definition.table,
      path: definition.path,
      rowCount: rowCountForTable(validation, definition.table),
    });
    order += 1;
  }
  return steps;
}

function rowCountForTable(
  validation: TenantExportValidationResult,
  table: TenantImportPlanPostgresTable,
): number {
  switch (table) {
    case "admin_domains":
      return validation.summary.adminDomainRows;
    case "admin_dns_records":
      return validation.summary.adminDnsRecordRows;
    case "objects":
      return validation.summary.objectRows;
    case "drive_versions":
      return validation.summary.driveVersionRows;
    case "resource_classifications":
      return validation.summary.resourceClassificationRows;
  }
}

function buildPlanIssues(input: {
  readonly sourceOrgId: string;
  readonly targetOrgId: string;
  readonly rowsByTable: ReadonlyMap<TenantImportPlanPostgresTable, readonly JsonRecord[]>;
  readonly conflicts: readonly TenantImportPlanConflict[];
  readonly providedRemaps: TenantImportPlanProvidedRemaps | undefined;
}): readonly TenantImportPlanIssue[] {
  const issues: TenantImportPlanIssue[] = [];
  const domainRows = input.rowsByTable.get("admin_domains") ?? [];
  const dnsRows = input.rowsByTable.get("admin_dns_records") ?? [];
  const objectRows = input.rowsByTable.get("objects") ?? [];
  const driveVersionRows = input.rowsByTable.get("drive_versions") ?? [];
  const classificationRows = input.rowsByTable.get("resource_classifications") ?? [];

  if (input.targetOrgId !== input.sourceOrgId) {
    issues.push({
      severity: "warning",
      code: "org_id_remap_required",
      message: "Dry-run will rewrite exported row orgId values to the target org ID.",
      expected: input.targetOrgId,
      actual: input.sourceOrgId,
    });
  }

  if (dnsRows.length > 0) {
    issues.push({
      severity: "warning",
      code: "domain_id_remap_required",
      table: "admin_dns_records",
      path: tablePath("admin_dns_records"),
      field: "domainId",
      message: "DNS rows depend on admin domain ID mapping before import can apply.",
    });
  }

  if (driveVersionRows.length > 0) {
    issues.push({
      severity: "warning",
      code: "object_id_remap_required",
      table: "drive_versions",
      path: tablePath("drive_versions"),
      field: "objectId",
      message: "Drive version rows depend on object ID mapping before import can apply.",
    });
  }

  if (
    domainRows.some((row) => row.createdBy !== null) ||
    objectRows.some((row) => row.ownerActorId !== null) ||
    driveVersionRows.some((row) => row.createdByActorId !== null) ||
    classificationRows.some((row) => row.actorId !== null)
  ) {
    issues.push({
      severity: "warning",
      code: "principal_remap_required",
      message:
        "Actor references need an explicit principal remap, preserve, null, or reject policy.",
    });
  }

  domainRows.forEach((row, index) => {
    const createdBy = row.createdBy;
    if (
      typeof createdBy === "string" &&
      input.providedRemaps?.principals?.[createdBy] === undefined
    ) {
      issues.push({
        severity: "warning",
        code: "principal_remap_missing",
        table: "admin_domains",
        path: tablePath("admin_domains"),
        line: index + 1,
        sourceId: stringField(row, "id"),
        field: "createdBy",
        actual: createdBy,
        message: "Admin domain creator reference has no target principal remap.",
      });
    }
  });

  objectRows.forEach((row, index) => {
    const ownerActorId = row.ownerActorId;
    if (
      typeof ownerActorId === "string" &&
      input.providedRemaps?.principals?.[ownerActorId] === undefined
    ) {
      issues.push({
        severity: "warning",
        code: "principal_remap_missing",
        table: "objects",
        path: tablePath("objects"),
        line: index + 1,
        sourceId: stringField(row, "id"),
        field: "ownerActorId",
        actual: ownerActorId,
        message: "Object owner reference has no target principal remap.",
      });
    }
  });

  driveVersionRows.forEach((row, index) => {
    const createdByActorId = row.createdByActorId;
    if (
      typeof createdByActorId === "string" &&
      input.providedRemaps?.principals?.[createdByActorId] === undefined
    ) {
      issues.push({
        severity: "warning",
        code: "principal_remap_missing",
        table: "drive_versions",
        path: tablePath("drive_versions"),
        line: index + 1,
        sourceId: stringField(row, "id"),
        field: "createdByActorId",
        actual: createdByActorId,
        message: "Drive version creator reference has no target principal remap.",
      });
    }
  });

  classificationRows.forEach((row, index) => {
    const actorId = row.actorId;
    if (typeof actorId === "string" && input.providedRemaps?.principals?.[actorId] === undefined) {
      issues.push({
        severity: "warning",
        code: "principal_remap_missing",
        table: "resource_classifications",
        path: tablePath("resource_classifications"),
        line: index + 1,
        sourceId: stringField(row, "id"),
        field: "actorId",
        actual: actorId,
        message: "Resource classification actor reference has no target principal remap.",
      });
    }
    const resourceType = stringField(row, "resourceType");
    const resourceId = stringField(row, "resourceId");
    const resourceKey = resourceReferenceKey(resourceType, resourceId);
    if (input.providedRemaps?.resources?.[resourceKey] === undefined) {
      issues.push({
        severity: "warning",
        code: "resource_remap_missing",
        table: "resource_classifications",
        path: tablePath("resource_classifications"),
        line: index + 1,
        sourceId: stringField(row, "id"),
        field: "resourceId",
        actual: resourceKey,
        message: "Resource classification reference has no target resource remap.",
      });
    }
  });

  if (classificationRows.length > 0) {
    issues.push({
      severity: "warning",
      code: "resource_reference_deferred",
      table: "resource_classifications",
      path: tablePath("resource_classifications"),
      message:
        "Resource classifications should apply after referenced tenant resources and resource ID remaps exist.",
    });
  }

  if (domainRows.some(hasVerifiedDomainState) || dnsRows.some(hasVerifiedDnsState)) {
    issues.push({
      severity: "warning",
      code: "verified_state_requires_recheck",
      message:
        "Verified domain and DNS state is environment-sensitive and should be rechecked or explicitly preserved.",
    });
  }

  if (domainRows.some((row) => row.isPrimary === true)) {
    issues.push({
      severity: "warning",
      code: "primary_domain_conflict_check_required",
      table: "admin_domains",
      path: tablePath("admin_domains"),
      field: "isPrimary",
      message:
        "Primary domain imports must check whether the target org already has a primary domain.",
    });
  }

  for (const conflict of input.conflicts) {
    issues.push({
      severity: conflict.severity,
      code: conflict.code,
      table: conflict.table,
      sourceId: conflict.sourceId,
      field: conflict.field,
      message: conflict.message,
      expected: conflict.naturalKey,
      actual: conflict.targetId,
    });
  }

  return issues;
}

function buildRemaps(input: {
  readonly sourceOrgId: string;
  readonly targetOrgId: string;
  readonly rowsByTable: ReadonlyMap<TenantImportPlanPostgresTable, readonly JsonRecord[]>;
  readonly providedRemaps: TenantImportPlanProvidedRemaps | undefined;
  readonly targetState: TenantImportPlanTargetState | undefined;
}): readonly TenantImportPlanRemapEntry[] {
  const domainIdTargets = buildDomainIdTargets(input.rowsByTable, input.targetState);
  const objectIdTargets = buildObjectIdTargets(input.rowsByTable, input.targetState);
  const remaps: TenantImportPlanRemapEntry[] = [
    {
      kind: "org",
      sourceId: input.sourceOrgId,
      ...(input.targetOrgId === input.sourceOrgId ? {} : { targetId: input.targetOrgId }),
      status: input.targetOrgId === input.sourceOrgId ? "identity" : "rewrite",
      reason:
        input.targetOrgId === input.sourceOrgId
          ? "Exported rows already target the source org ID."
          : "Exported row orgId values will be rewritten to the target org ID.",
    },
  ];

  for (const definition of chunkDefinitions) {
    const rows = input.rowsByTable.get(definition.table) ?? [];
    for (const row of rows) {
      const sourceId = stringField(row, "id");
      const naturalKey = naturalKeyForRow(definition.table, row);
      const targetId = targetIdForNaturalKey(definition.table, naturalKey, input.targetState);
      remaps.push({
        kind: "row_id",
        table: definition.table,
        sourceId,
        ...(targetId === null ? {} : { targetId }),
        status: targetId === null ? "pending" : "rewrite",
        naturalKey,
        reason:
          targetId === null
            ? "Target row ID must be preserved, matched, or regenerated during apply."
            : "Target row already matches this exported row natural key.",
      });
    }
  }

  const principalIds = new Set<string>();
  for (const row of input.rowsByTable.get("admin_domains") ?? []) {
    addStringSetValue(principalIds, row.createdBy);
  }
  for (const row of input.rowsByTable.get("objects") ?? []) {
    addStringSetValue(principalIds, row.ownerActorId);
  }
  for (const row of input.rowsByTable.get("drive_versions") ?? []) {
    addStringSetValue(principalIds, row.createdByActorId);
  }
  for (const row of input.rowsByTable.get("resource_classifications") ?? []) {
    addStringSetValue(principalIds, row.actorId);
  }
  for (const sourceId of [...principalIds].sort()) {
    const providedTargetId = input.providedRemaps?.principals?.[sourceId];
    remaps.push({
      kind: "principal",
      sourceId,
      ...(providedTargetId === undefined || providedTargetId === null
        ? {}
        : { targetId: providedTargetId }),
      status: providedTargetId === undefined ? "unresolved" : "rewrite",
      reason:
        providedTargetId === undefined
          ? "Principal references need an explicit target principal remap or null/preserve policy."
          : providedTargetId === null
            ? "Principal reference will be nulled during apply."
            : "Principal reference will be rewritten to a provided target principal.",
    });
  }

  const resourceReferences = new Map<
    string,
    { readonly resourceType: string; readonly resourceId: string }
  >();
  for (const row of input.rowsByTable.get("resource_classifications") ?? []) {
    const resourceType = stringField(row, "resourceType");
    const resourceId = stringField(row, "resourceId");
    resourceReferences.set(resourceReferenceKey(resourceType, resourceId), {
      resourceType,
      resourceId,
    });
  }
  for (const reference of [...resourceReferences.values()].sort((left, right) =>
    `${left.resourceType}:${left.resourceId}`.localeCompare(
      `${right.resourceType}:${right.resourceId}`,
    ),
  )) {
    const targetId =
      input.providedRemaps?.resources?.[
        resourceReferenceKey(reference.resourceType, reference.resourceId)
      ];
    remaps.push({
      kind: "resource",
      sourceId: reference.resourceId,
      resourceType: reference.resourceType,
      ...(targetId === undefined ? {} : { targetId }),
      status: targetId === undefined ? "unresolved" : "rewrite",
      reason:
        targetId === undefined
          ? "Resource classifications must resolve target resource IDs after resource import."
          : "Resource classification reference will be rewritten to a provided target resource.",
    });
  }

  for (const [sourceId, targetId] of domainIdTargets) {
    if (sourceId === targetId) {
      continue;
    }
    remaps.push({
      kind: "row_id",
      table: "admin_domains",
      sourceId,
      targetId,
      status: "rewrite",
      reason: "DNS domainId values will use the matched target admin domain ID.",
    });
  }

  for (const [sourceId, targetId] of objectIdTargets) {
    if (sourceId === targetId) {
      continue;
    }
    remaps.push({
      kind: "row_id",
      table: "objects",
      sourceId,
      targetId,
      status: "rewrite",
      reason: "Drive version objectId values will use the matched target object ID.",
    });
  }

  return remaps;
}

function buildConflicts(input: {
  readonly targetState: TenantImportPlanTargetState | undefined;
  readonly operations: readonly TenantImportPlanOperation[];
  readonly rowsByTable: ReadonlyMap<TenantImportPlanPostgresTable, readonly JsonRecord[]>;
}): readonly TenantImportPlanConflict[] {
  if (input.targetState === undefined) {
    return [];
  }
  const conflicts: TenantImportPlanConflict[] = [];
  for (const operation of input.operations) {
    const existingRow = input.targetState.existingRowIds?.find(
      (row) => row.table === operation.table && row.id === operation.sourceId,
    );
    if (existingRow !== undefined) {
      conflicts.push({
        severity: "warning",
        code: "target_primary_key_conflict",
        table: operation.table,
        sourceId: operation.sourceId,
        ...(existingRow.targetId === undefined ? {} : { targetId: existingRow.targetId }),
        message: "Target already has a row with the exported source ID.",
      });
    }

    const existingNaturalKey = input.targetState.existingNaturalKeys?.find(
      (entry) =>
        entry.table === operation.table && arraysEqual(entry.naturalKey, operation.naturalKey),
    );
    if (existingNaturalKey !== undefined) {
      conflicts.push({
        severity: "warning",
        code: "target_natural_key_conflict",
        table: operation.table,
        sourceId: operation.sourceId,
        naturalKey: operation.naturalKey,
        ...(existingNaturalKey.targetId === undefined
          ? {}
          : { targetId: existingNaturalKey.targetId }),
        message: "Target already has a row with the exported natural key.",
      });
    }
  }

  const targetPrimaryDomain = input.targetState.primaryDomain?.toLowerCase();
  if (targetPrimaryDomain !== undefined) {
    const importedPrimaryDomains = (input.rowsByTable.get("admin_domains") ?? [])
      .filter((row) => row.isPrimary === true)
      .map((row) => stringField(row, "domain").toLowerCase());
    for (const domain of importedPrimaryDomains) {
      if (domain !== targetPrimaryDomain) {
        conflicts.push({
          severity: "warning",
          code: "target_primary_domain_conflict",
          table: "admin_domains",
          naturalKey: [domain],
          field: "isPrimary",
          message: "Target org already has a different primary domain.",
        });
      }
    }
  }

  return conflicts;
}

function hasVerifiedDomainState(row: JsonRecord): boolean {
  return row.verificationStatus === "verified" || row.verifiedAt !== null;
}

function hasVerifiedDnsState(row: JsonRecord): boolean {
  return row.status === "verified" || row.observedValue !== null || row.lastCheckedAt !== null;
}

function buildOperations(input: {
  readonly sourceOrgId: string;
  readonly targetOrgId: string;
  readonly rowsByTable: ReadonlyMap<TenantImportPlanPostgresTable, readonly JsonRecord[]>;
  readonly providedRemaps: TenantImportPlanProvidedRemaps | undefined;
  readonly targetState: TenantImportPlanTargetState | undefined;
  readonly providedConflictPolicy: TenantImportDryRunConflictPolicy | undefined;
}): readonly TenantImportPlanOperation[] {
  const operations: TenantImportPlanOperation[] = [];
  const domainIdTargets = buildDomainIdTargets(input.rowsByTable, input.targetState);
  const objectIdTargets = buildObjectIdTargets(input.rowsByTable, input.targetState);
  for (const definition of chunkDefinitions) {
    const rows = input.rowsByTable.get(definition.table) ?? [];
    rows.forEach((row, index) => {
      const remappedFields = remappedFieldsForRow({
        table: definition.table,
        row,
        targetOrgId: input.targetOrgId,
        domainIdTargets,
        objectIdTargets,
        providedRemaps: input.providedRemaps,
      });
      const plannedRow = {
        ...row,
        ...remappedFields,
      };
      const naturalKey = naturalKeyForRow(definition.table, plannedRow);
      const targetId = targetIdForNaturalKey(definition.table, naturalKey, input.targetState);
      const conflictPolicy = conflictPolicyForRow({
        table: definition.table,
        row,
        targetId,
        targetState: input.targetState,
        domainIdTargets,
        objectIdTargets,
        providedRemaps: input.providedRemaps,
        providedConflictPolicy: input.providedConflictPolicy,
      });
      operations.push({
        order: operations.length + 1,
        kind: definition.operationKind,
        table: definition.table,
        path: definition.path,
        line: index + 1,
        action: operationActionForRow(
          definition.table,
          row,
          input.providedRemaps,
          targetId,
          input.providedConflictPolicy,
        ),
        sourceId: stringField(row, "id"),
        targetId,
        sourceOrgId: input.sourceOrgId,
        targetOrgId: input.targetOrgId,
        naturalKey,
        dependsOn: dependsOnForRow(definition.table, plannedRow),
        remappedFields,
        conflictPolicy,
        row: plannedRow,
      });
    });
  }
  return operations;
}

function operationActionForRow(
  table: TenantImportPlanPostgresTable,
  row: JsonRecord,
  providedRemaps: TenantImportPlanProvidedRemaps | undefined,
  targetId: string | null,
  providedConflictPolicy: TenantImportDryRunConflictPolicy | undefined,
): TenantImportPlanOperationAction {
  if (table === "resource_classifications") {
    const resourceKey = resourceReferenceKey(
      stringField(row, "resourceType"),
      stringField(row, "resourceId"),
    );
    if (
      providedRemaps?.resources?.[resourceKey] === undefined &&
      providedConflictPolicy?.resourceReferences !== "preserve"
    ) {
      return "blocked";
    }
  }
  return targetId === null ? "insert" : "update";
}

function remappedFieldsForRow(input: {
  readonly table: TenantImportPlanPostgresTable;
  readonly row: JsonRecord;
  readonly targetOrgId: string;
  readonly domainIdTargets: ReadonlyMap<string, string>;
  readonly objectIdTargets: ReadonlyMap<string, string>;
  readonly providedRemaps: TenantImportPlanProvidedRemaps | undefined;
}): Readonly<Record<string, unknown>> {
  const remapped: Record<string, unknown> = {
    orgId: input.targetOrgId,
  };
  if (input.table === "admin_domains") {
    const createdBy = input.row.createdBy;
    if (
      typeof createdBy === "string" &&
      input.providedRemaps?.principals?.[createdBy] !== undefined
    ) {
      remapped.createdBy = input.providedRemaps.principals[createdBy];
    }
  }
  if (input.table === "admin_dns_records") {
    const domainId = stringField(input.row, "domainId");
    remapped.domainId = input.domainIdTargets.get(domainId) ?? domainId;
  }
  if (input.table === "objects") {
    const ownerActorId = input.row.ownerActorId;
    if (
      typeof ownerActorId === "string" &&
      input.providedRemaps?.principals?.[ownerActorId] !== undefined
    ) {
      remapped.ownerActorId = input.providedRemaps.principals[ownerActorId];
    }
  }
  if (input.table === "drive_versions") {
    const objectId = stringField(input.row, "objectId");
    remapped.objectId = input.objectIdTargets.get(objectId) ?? objectId;
    const createdByActorId = input.row.createdByActorId;
    if (
      typeof createdByActorId === "string" &&
      input.providedRemaps?.principals?.[createdByActorId] !== undefined
    ) {
      remapped.createdByActorId = input.providedRemaps.principals[createdByActorId];
    }
  }
  if (input.table === "resource_classifications") {
    const actorId = input.row.actorId;
    if (typeof actorId === "string" && input.providedRemaps?.principals?.[actorId] !== undefined) {
      remapped.actorId = input.providedRemaps.principals[actorId];
    }
    const resourceKey = resourceReferenceKey(
      stringField(input.row, "resourceType"),
      stringField(input.row, "resourceId"),
    );
    const targetResourceId = input.providedRemaps?.resources?.[resourceKey];
    if (targetResourceId !== undefined) {
      remapped.resourceId = targetResourceId;
    }
  }
  return remapped;
}

function conflictPolicyForRow(input: {
  readonly table: TenantImportPlanPostgresTable;
  readonly row: JsonRecord;
  readonly targetId: string | null;
  readonly targetState: TenantImportPlanTargetState | undefined;
  readonly domainIdTargets: ReadonlyMap<string, string>;
  readonly objectIdTargets: ReadonlyMap<string, string>;
  readonly providedRemaps: TenantImportPlanProvidedRemaps | undefined;
  readonly providedConflictPolicy: TenantImportDryRunConflictPolicy | undefined;
}): TenantImportPlanOperationConflictPolicy {
  return {
    rowId: rowIdConflictPolicy({
      table: input.table,
      row: input.row,
      targetId: input.targetId,
      targetState: input.targetState,
      providedConflictPolicy: input.providedConflictPolicy,
    }),
    references: referenceConflictPolicyForRow(input),
    state: stateConflictPolicyForRow(input),
  };
}

function rowIdConflictPolicy(input: {
  readonly table: TenantImportPlanPostgresTable;
  readonly row: JsonRecord;
  readonly targetId: string | null;
  readonly targetState: TenantImportPlanTargetState | undefined;
  readonly providedConflictPolicy: TenantImportDryRunConflictPolicy | undefined;
}): TenantImportPlanConflictPolicyMode {
  const sourceId = stringField(input.row, "id");
  const hasPrimaryKeyConflict =
    input.targetState?.existingRowIds?.some(
      (existing) => existing.table === input.table && existing.id === sourceId,
    ) ?? false;
  const defaultMode =
    input.targetId !== null ? "match" : hasPrimaryKeyConflict ? "regenerate" : "preserve";
  if (input.targetId === null && hasPrimaryKeyConflict) {
    return input.providedConflictPolicy?.rowIdConflicts ?? defaultMode;
  }
  return defaultMode;
}

function referenceConflictPolicyForRow(input: {
  readonly table: TenantImportPlanPostgresTable;
  readonly row: JsonRecord;
  readonly domainIdTargets: ReadonlyMap<string, string>;
  readonly objectIdTargets: ReadonlyMap<string, string>;
  readonly providedRemaps: TenantImportPlanProvidedRemaps | undefined;
  readonly providedConflictPolicy: TenantImportDryRunConflictPolicy | undefined;
}): Readonly<Record<string, TenantImportPlanConflictPolicyMode>> {
  const references: Record<string, TenantImportPlanConflictPolicyMode> = {};
  if (input.table === "admin_domains") {
    const createdBy = input.row.createdBy;
    if (typeof createdBy === "string") {
      references.createdBy = referencePolicyOverride(
        "createdBy",
        principalReferencePolicy(createdBy, input.providedRemaps),
        input.providedConflictPolicy,
      );
    }
  }
  if (input.table === "admin_dns_records") {
    const domainId = stringField(input.row, "domainId");
    references.domainId = referencePolicyOverride(
      "domainId",
      input.domainIdTargets.has(domainId) ? "match" : "preserve",
      input.providedConflictPolicy,
    );
  }
  if (input.table === "objects") {
    const ownerActorId = input.row.ownerActorId;
    if (typeof ownerActorId === "string") {
      references.ownerActorId = referencePolicyOverride(
        "ownerActorId",
        principalReferencePolicy(ownerActorId, input.providedRemaps),
        input.providedConflictPolicy,
      );
    }
  }
  if (input.table === "drive_versions") {
    const objectId = stringField(input.row, "objectId");
    references.objectId = referencePolicyOverride(
      "objectId",
      input.objectIdTargets.has(objectId) ? "match" : "preserve",
      input.providedConflictPolicy,
    );
    const createdByActorId = input.row.createdByActorId;
    if (typeof createdByActorId === "string") {
      references.createdByActorId = referencePolicyOverride(
        "createdByActorId",
        principalReferencePolicy(createdByActorId, input.providedRemaps),
        input.providedConflictPolicy,
      );
    }
  }
  if (input.table === "resource_classifications") {
    const actorId = input.row.actorId;
    if (typeof actorId === "string") {
      references.actorId = referencePolicyOverride(
        "actorId",
        principalReferencePolicy(actorId, input.providedRemaps),
        input.providedConflictPolicy,
      );
    }
    const resourceKey = resourceReferenceKey(
      stringField(input.row, "resourceType"),
      stringField(input.row, "resourceId"),
    );
    references.resourceId = referencePolicyOverride(
      "resourceId",
      input.providedRemaps?.resources?.[resourceKey] === undefined ? "preserve" : "match",
      input.providedConflictPolicy,
    );
  }
  return references;
}

function referencePolicyOverride(
  field: TenantImportPlanConflictPolicyReferenceField,
  fallback: TenantImportPlanConflictPolicyMode,
  providedConflictPolicy: TenantImportDryRunConflictPolicy | undefined,
): TenantImportPlanConflictPolicyMode {
  if (
    (field === "createdBy" ||
      field === "createdByActorId" ||
      field === "actorId" ||
      field === "ownerActorId") &&
    fallback === "preserve" &&
    providedConflictPolicy?.principalReferences !== undefined
  ) {
    return providedConflictPolicy.principalReferences;
  }
  if (
    field === "resourceId" &&
    fallback === "preserve" &&
    providedConflictPolicy?.resourceReferences === "preserve"
  ) {
    return "preserve";
  }
  return fallback;
}

function principalReferencePolicy(
  sourceId: string,
  providedRemaps: TenantImportPlanProvidedRemaps | undefined,
): TenantImportPlanConflictPolicyMode {
  if (providedRemaps?.principals?.[sourceId] === undefined) {
    return "preserve";
  }
  return providedRemaps.principals[sourceId] === null ? "null" : "match";
}

function stateConflictPolicyForRow(input: {
  readonly table: TenantImportPlanPostgresTable;
  readonly row: JsonRecord;
  readonly providedConflictPolicy: TenantImportDryRunConflictPolicy | undefined;
}): Readonly<Record<string, TenantImportPlanConflictPolicyMode>> {
  const state: Record<string, TenantImportPlanConflictPolicyMode> = {};
  if (input.table === "admin_domains") {
    if (input.row.verificationStatus === "verified") {
      state.verificationStatus = statePolicyOverride(
        "verificationStatus",
        "regenerate",
        input.providedConflictPolicy,
      );
    }
    if (input.row.verifiedAt !== null && input.row.verifiedAt !== undefined) {
      state.verifiedAt = statePolicyOverride(
        "verifiedAt",
        "regenerate",
        input.providedConflictPolicy,
      );
    }
    if (input.row.isPrimary === true) {
      state.isPrimary = statePolicyOverride("isPrimary", "preserve", input.providedConflictPolicy);
    }
  }
  if (input.table === "admin_dns_records") {
    if (input.row.status === "verified") {
      state.status = statePolicyOverride("status", "regenerate", input.providedConflictPolicy);
    }
    if (input.row.observedValue !== null && input.row.observedValue !== undefined) {
      state.observedValue = statePolicyOverride(
        "observedValue",
        "regenerate",
        input.providedConflictPolicy,
      );
    }
    if (input.row.lastCheckedAt !== null && input.row.lastCheckedAt !== undefined) {
      state.lastCheckedAt = statePolicyOverride(
        "lastCheckedAt",
        "regenerate",
        input.providedConflictPolicy,
      );
    }
  }
  return state;
}

function statePolicyOverride(
  field: TenantImportPlanConflictPolicyStateField,
  fallback: TenantImportPlanConflictPolicyMode,
  providedConflictPolicy: TenantImportDryRunConflictPolicy | undefined,
): TenantImportPlanConflictPolicyMode {
  if (
    (field === "verificationStatus" ||
      field === "verifiedAt" ||
      field === "status" ||
      field === "observedValue" ||
      field === "lastCheckedAt") &&
    providedConflictPolicy?.verifiedState !== undefined
  ) {
    return providedConflictPolicy.verifiedState;
  }
  if (field === "isPrimary" && providedConflictPolicy?.primaryDomain !== undefined) {
    return providedConflictPolicy.primaryDomain;
  }
  return fallback;
}

function naturalKeyForRow(
  table: TenantImportPlanPostgresTable,
  row: JsonRecord,
): readonly string[] {
  switch (table) {
    case "admin_domains":
      return [stringField(row, "domain").toLowerCase()];
    case "admin_dns_records":
      return [
        stringField(row, "domainId"),
        stringField(row, "recordType"),
        stringField(row, "host"),
      ];
    case "objects":
      return [stringField(row, "storageKey")];
    case "drive_versions":
      return [stringField(row, "objectId"), String(numberField(row, "versionNumber"))];
    case "resource_classifications":
      return [stringField(row, "resourceType"), stringField(row, "resourceId")];
  }
}

function dependsOnForRow(table: TenantImportPlanPostgresTable, row: JsonRecord): readonly string[] {
  if (table === "admin_dns_records") {
    return [`admin_domains:${stringField(row, "domainId")}`];
  }
  if (table === "drive_versions") {
    return [`objects:${stringField(row, "objectId")}`];
  }
  return [];
}

function buildDomainIdTargets(
  rowsByTable: ReadonlyMap<TenantImportPlanPostgresTable, readonly JsonRecord[]>,
  targetState: TenantImportPlanTargetState | undefined,
): ReadonlyMap<string, string> {
  const targets = new Map<string, string>();
  for (const row of rowsByTable.get("admin_domains") ?? []) {
    const sourceId = stringField(row, "id");
    const naturalKey = naturalKeyForRow("admin_domains", row);
    const targetId = targetIdForNaturalKey("admin_domains", naturalKey, targetState);
    if (targetId !== null) {
      targets.set(sourceId, targetId);
    }
  }
  return targets;
}

function buildObjectIdTargets(
  rowsByTable: ReadonlyMap<TenantImportPlanPostgresTable, readonly JsonRecord[]>,
  targetState: TenantImportPlanTargetState | undefined,
): ReadonlyMap<string, string> {
  const targets = new Map<string, string>();
  for (const row of rowsByTable.get("objects") ?? []) {
    const sourceId = stringField(row, "id");
    const naturalKey = naturalKeyForRow("objects", row);
    const targetId = targetIdForNaturalKey("objects", naturalKey, targetState);
    if (targetId !== null) {
      targets.set(sourceId, targetId);
    }
  }
  return targets;
}

function targetIdForNaturalKey(
  table: TenantImportPlanPostgresTable,
  naturalKey: readonly string[],
  targetState: TenantImportPlanTargetState | undefined,
): string | null {
  const match = targetState?.existingNaturalKeys?.find(
    (entry) => entry.table === table && arraysEqual(entry.naturalKey, naturalKey),
  );
  return match?.targetId ?? null;
}

function addStringSetValue(values: Set<string>, value: unknown): void {
  if (typeof value === "string") {
    values.add(value);
  }
}

function resourceReferenceKey(resourceType: string, resourceId: string): string {
  return `${resourceType}:${resourceId}`;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function readRowsByTable(
  manifest: TenantExportManifest,
  files: ReadonlyMap<string, Uint8Array>,
): ReadonlyMap<TenantImportPlanPostgresTable, readonly JsonRecord[]> {
  const rowsByTable = new Map<TenantImportPlanPostgresTable, readonly JsonRecord[]>();
  for (const chunk of manifest.postgres.rowDataChunks.chunks) {
    const definition = chunkDefinitionsByTable.get(chunk.table as TenantImportPlanPostgresTable);
    if (definition === undefined) {
      continue;
    }
    const body = files.get(definition.path);
    if (body === undefined) {
      rowsByTable.set(definition.table, []);
      continue;
    }
    rowsByTable.set(definition.table, parseJsonl(body));
  }
  return rowsByTable;
}

function parseJsonl(body: Uint8Array): readonly JsonRecord[] {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  if (text.length === 0) {
    return [];
  }
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  return lines.map((line) => JSON.parse(line) as JsonRecord);
}

function normalizeFiles(files: TenantExportValidationFiles): ReadonlyMap<string, Uint8Array> {
  if (files instanceof Map) {
    const normalized = new Map<string, Uint8Array>();
    const mapFiles = files as ReadonlyMap<string, Uint8Array | string>;
    for (const [path, body] of mapFiles.entries()) {
      normalized.set(path, normalizeFileBody(body));
    }
    return normalized;
  }
  const normalized = new Map<string, Uint8Array>();
  for (const [path, body] of Object.entries(files) as [string, Uint8Array | string][]) {
    normalized.set(path, normalizeFileBody(body));
  }
  return normalized;
}

function normalizeFileBody(body: Uint8Array | string): Uint8Array {
  if (typeof body === "string") {
    return Buffer.from(body, "utf8");
  }
  return body;
}

function tablePath(table: TenantImportPlanPostgresTable): string {
  const definition = chunkDefinitionsByTable.get(table);
  if (definition === undefined) {
    throw new Error(`Unsupported import plan table: ${table}.`);
  }
  return definition.path;
}

function stringField(row: JsonRecord, field: string): string {
  const value = row[field];
  if (typeof value !== "string") {
    throw new Error(`Expected ${field} to be a string after validation.`);
  }
  return value;
}

function numberField(row: JsonRecord, field: string): number {
  const value = row[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Expected ${field} to be a number after validation.`);
  }
  return value;
}

interface ParsedTenantExportArchive {
  readonly entries: ReadonlyMap<string, Uint8Array>;
  readonly issues: readonly TenantImportArchiveReadIssue[];
}

interface RequiredJsonRecordResult {
  readonly value: JsonRecord;
  readonly issues: readonly TenantImportArchiveReadIssue[];
}

interface TenantExportManifestFromArchiveEntriesResult {
  readonly value: TenantExportManifest;
  readonly issues: readonly TenantImportArchiveReadIssue[];
}

interface OptionalTenantExportSelfFetchManifestResult {
  readonly value?: TenantExportSelfFetchManifest | undefined;
  readonly issues: readonly TenantImportArchiveReadIssue[];
}

function readTenantExportArchive(archive: Uint8Array): ParsedTenantExportArchive {
  const buffer = Buffer.from(archive);
  const entries = new Map<string, Uint8Array>();
  const issues: TenantImportArchiveReadIssue[] = [];
  let sawEndMarker = false;

  for (let offset = 0; offset + 512 <= buffer.byteLength; ) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      sawEndMarker = true;
      break;
    }

    const path = readTarString(header, 0, 100);
    if (!isSafeArchivePath(path)) {
      issues.push({
        severity: "error",
        code: "unsafe_archive_path",
        path,
        message: "Tenant export archive entry path must be relative and normalized.",
      });
      break;
    }
    if (entries.has(path)) {
      issues.push({
        severity: "error",
        code: "duplicate_archive_entry",
        path,
        message: "Tenant export archive contains a duplicate entry.",
      });
      break;
    }

    const typeflag = header.subarray(156, 157).toString("ascii");
    if (typeflag !== "0" && typeflag !== "\0") {
      issues.push({
        severity: "error",
        code: "invalid_tar_archive",
        path,
        message: "Tenant export archive entries must be regular files.",
        actual: typeflag,
      });
      break;
    }

    const magic = header.subarray(257, 263).toString("ascii");
    const version = header.subarray(263, 265).toString("ascii");
    if (magic !== "ustar\0" || version !== "00") {
      issues.push({
        severity: "error",
        code: "invalid_tar_archive",
        path,
        message: "Tenant export archive entry must use the ustar format.",
        expected: { magic: "ustar\\0", version: "00" },
        actual: { magic, version },
      });
      break;
    }

    if (!tarHeaderChecksumMatches(header)) {
      issues.push({
        severity: "error",
        code: "invalid_tar_archive",
        path,
        message: "Tenant export archive entry checksum is invalid.",
      });
      break;
    }

    const size = readTarOctal(header, 124, 12);
    if (size === null) {
      issues.push({
        severity: "error",
        code: "invalid_tar_archive",
        path,
        message: "Tenant export archive entry has an invalid size.",
      });
      break;
    }
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > buffer.byteLength) {
      issues.push({
        severity: "error",
        code: "invalid_tar_archive",
        path,
        message: "Tenant export archive entry body is truncated.",
      });
      break;
    }

    entries.set(path, buffer.subarray(bodyStart, bodyEnd));
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }

  if (!sawEndMarker && issues.length === 0) {
    issues.push({
      severity: "error",
      code: "invalid_tar_archive",
      message: "Tenant export archive is missing the tar end marker.",
    });
  }

  return {
    entries,
    issues,
  };
}

function readRequiredJsonRecord(
  entries: ReadonlyMap<string, Uint8Array>,
  path: string,
): RequiredJsonRecordResult {
  const body = entries.get(path);
  if (body === undefined) {
    return {
      value: {},
      issues: [
        {
          severity: "error",
          code: "missing_archive_entry",
          path,
          message: "Tenant export archive is missing a required metadata entry.",
        },
      ],
    };
  }
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
    if (!isJsonRecord(value)) {
      return {
        value: {},
        issues: [
          {
            severity: "error",
            code: "invalid_archive_json",
            path,
            message: "Tenant export archive metadata entry must be a JSON object.",
          },
        ],
      };
    }
    return {
      value,
      issues: [],
    };
  } catch (error) {
    return {
      value: {},
      issues: [
        {
          severity: "error",
          code: "invalid_archive_json",
          path,
          message: `Tenant export archive metadata entry is not valid JSON: ${errorMessage(
            error,
          )}.`,
        },
      ],
    };
  }
}

function readOptionalTenantExportSelfFetchManifest(
  entries: ReadonlyMap<string, Uint8Array>,
): OptionalTenantExportSelfFetchManifestResult {
  const path = "objects/self-fetch-manifest.json";
  const body = entries.get(path);
  if (body === undefined) {
    return { issues: [] };
  }
  const decoded = readRequiredJsonRecord(entries, path);
  if (decoded.issues.length > 0) {
    return { issues: decoded.issues };
  }
  if (!isTenantExportSelfFetchManifest(decoded.value)) {
    return {
      issues: [
        {
          severity: "error",
          code: "invalid_archive_manifest",
          path,
          message: "Tenant export self-fetch manifest has an invalid shape.",
        },
      ],
    };
  }
  return {
    value: {
      version: 1,
      generatedAt: stringValue(decoded.value.generatedAt),
      org: {
        id: stringValue((decoded.value.org as JsonRecord).id),
        slug: stringValue((decoded.value.org as JsonRecord).slug),
      },
      delivery: "self-fetch",
      expiresAt: stringValue(decoded.value.expiresAt),
      expiresSeconds: numberValue(decoded.value.expiresSeconds),
      objects: arrayValue(decoded.value.objects).map((object) => ({
        storageKey: stringValue(object.storageKey),
        ...(object.byteSize === undefined ? {} : { byteSize: numberValue(object.byteSize) }),
        ...(object.sha256 === undefined ? {} : { sha256: stringValue(object.sha256) }),
        url: stringValue(object.url),
        expiresAt: stringValue(object.expiresAt),
      })),
    },
    issues: [],
  };
}

function tenantExportManifestFromArchiveEntries(input: {
  readonly manifest: JsonRecord;
  readonly configSnapshot: JsonRecord;
  readonly objectInventory: JsonRecord;
  readonly rowDataChunks: JsonRecord;
}): TenantExportManifestFromArchiveEntriesResult {
  const issues: TenantImportArchiveReadIssue[] = [];
  if (input.manifest.version !== 1) {
    issues.push({
      severity: "error",
      code: "invalid_archive_manifest",
      path: "manifest.json",
      message: "Tenant export archive manifest must use version 1.",
      expected: 1,
      actual: input.manifest.version,
    });
  }
  if (!isJsonRecord(input.manifest.org)) {
    issues.push({
      severity: "error",
      code: "invalid_archive_manifest",
      path: "manifest.json",
      message: "Tenant export archive manifest is missing org metadata.",
    });
  }
  if (!isJsonRecord(input.manifest.postgres)) {
    issues.push({
      severity: "error",
      code: "invalid_archive_manifest",
      path: "manifest.json",
      message: "Tenant export archive manifest is missing postgres metadata.",
    });
  }
  if (!isJsonRecord(input.manifest.auditLog)) {
    issues.push({
      severity: "error",
      code: "invalid_archive_manifest",
      path: "manifest.json",
      message: "Tenant export archive manifest is missing audit summary metadata.",
    });
  }
  if (!isTenantExportObjectInventory(input.objectInventory)) {
    issues.push({
      severity: "error",
      code: "invalid_archive_manifest",
      path: "objects/inventory.json",
      message: "Tenant export object inventory has an invalid shape.",
    });
  }
  if (!isTenantExportPostgresDataChunkManifest(input.rowDataChunks)) {
    issues.push({
      severity: "error",
      code: "invalid_archive_manifest",
      path: "postgres/data/chunks/manifest.json",
      message: "Tenant export row chunk manifest has an invalid shape.",
    });
  }
  if (
    isJsonRecord(input.manifest.postgres) &&
    isJsonRecord(input.manifest.postgres.rowDataChunks) &&
    JSON.stringify(input.manifest.postgres.rowDataChunks) !== JSON.stringify(input.rowDataChunks)
  ) {
    issues.push({
      severity: "error",
      code: "invalid_archive_manifest",
      path: "postgres/data/chunks/manifest.json",
      message: "Tenant export row chunk manifest entry must match manifest.json metadata.",
    });
  }
  if (issues.length > 0) {
    return {
      value: emptyTenantExportManifest(),
      issues,
    };
  }

  const org = input.manifest.org as JsonRecord;
  const postgres = input.manifest.postgres as JsonRecord;
  const auditLog = input.manifest.auditLog as JsonRecord;
  return {
    value: {
      version: 1,
      generatedAt: stringValue(input.manifest.generatedAt),
      org: {
        id: stringValue(org.id),
        slug: stringValue(org.slug),
        displayName: stringValue(org.displayName),
        status: stringValue(org.status),
        tier: stringValue(org.tier),
        planId: stringValue(org.planId),
        region: stringValue(org.region),
      },
      configSnapshot: {
        byoConfig: jsonObjectValue(input.configSnapshot.byoConfig),
        featureFlags: jsonObjectValue(input.configSnapshot.featureFlags),
        quotas: jsonObjectValue(input.configSnapshot.quotas),
        branding: jsonObjectValue(input.configSnapshot.branding),
      },
      objectInventory: {
        bytesIncluded: input.objectInventory.bytesIncluded === true,
        objectCount: numberValue(input.objectInventory.objectCount),
        totalKnownBytes: numberValue(input.objectInventory.totalKnownBytes),
        objects: arrayValue(input.objectInventory.objects).map((object) => ({
          storageKey: stringValue(object.storageKey),
          ...(object.byteSize === undefined ? {} : { byteSize: numberValue(object.byteSize) }),
          ...(object.sha256 === undefined ? {} : { sha256: stringValue(object.sha256) }),
        })),
      },
      postgres: {
        rowCounts: arrayValue(postgres.rowCounts).map((row) => ({
          table: stringValue(row.table),
          rowCount: numberValue(row.rowCount),
        })),
        rowDataChunks: input.rowDataChunks as unknown as TenantExportPostgresDataChunkManifest,
      },
      auditLog: {
        rowCount: numberValue(auditLog.rowCount),
        firstEntryAt: nullableStringValue(auditLog.firstEntryAt),
        lastEntryAt: nullableStringValue(auditLog.lastEntryAt),
      },
    },
    issues,
  };
}

function tenantExportRowChunkFilesFromArchive(
  entries: ReadonlyMap<string, Uint8Array>,
): ReadonlyMap<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (const [path, body] of entries) {
    if (path.startsWith("postgres/data/chunks/") && path.endsWith(".jsonl")) {
      files.set(path, body);
    }
  }
  return files;
}

function isTenantExportObjectInventory(value: JsonRecord): boolean {
  return (
    typeof value.bytesIncluded === "boolean" &&
    typeof value.objectCount === "number" &&
    typeof value.totalKnownBytes === "number" &&
    Array.isArray(value.objects) &&
    value.objects.every(
      (object) =>
        isJsonRecord(object) &&
        typeof object.storageKey === "string" &&
        (object.byteSize === undefined || typeof object.byteSize === "number") &&
        (object.sha256 === undefined || typeof object.sha256 === "string"),
    )
  );
}

function isTenantExportPostgresDataChunkManifest(value: JsonRecord): boolean {
  return (
    value.version === 1 &&
    value.format === "jsonl" &&
    Array.isArray(value.chunks) &&
    Array.isArray(value.includedTables) &&
    Array.isArray(value.excludedTables) &&
    Array.isArray(value.notes)
  );
}

function isTenantExportSelfFetchManifest(value: JsonRecord): boolean {
  return (
    value.version === 1 &&
    value.delivery === "self-fetch" &&
    typeof value.generatedAt === "string" &&
    isJsonRecord(value.org) &&
    typeof value.org.id === "string" &&
    typeof value.org.slug === "string" &&
    typeof value.expiresAt === "string" &&
    typeof value.expiresSeconds === "number" &&
    Array.isArray(value.objects) &&
    value.objects.every(
      (object) =>
        isJsonRecord(object) &&
        typeof object.storageKey === "string" &&
        (object.byteSize === undefined || typeof object.byteSize === "number") &&
        (object.sha256 === undefined || typeof object.sha256 === "string") &&
        typeof object.url === "string" &&
        typeof object.expiresAt === "string",
    )
  );
}

function isSafeArchivePath(path: string): boolean {
  return (
    path.length > 0 &&
    !containsControlCharacter(path) &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0 && code <= 31) {
      return true;
    }
  }
  return false;
}

function readTarString(header: Buffer, offset: number, length: number): string {
  return header
    .subarray(offset, offset + length)
    .toString("utf8")
    .replace(/\0.*$/u, "");
}

function readTarOctal(header: Buffer, offset: number, length: number): number | null {
  const value = header
    .subarray(offset, offset + length)
    .toString("ascii")
    .replace(/\0.*$/u, "")
    .trim();
  if (value.length === 0 || !/^[0-7]+$/u.test(value)) {
    return null;
  }
  return Number.parseInt(value, 8);
}

function tarHeaderChecksumMatches(header: Buffer): boolean {
  const expected = readTarOctal(header, 148, 8);
  if (expected === null) {
    return false;
  }
  let actual = 0;
  for (let index = 0; index < header.byteLength; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
  }
  return actual === expected;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableStringValue(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return stringValue(value);
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function jsonObjectValue(value: unknown): JsonObject {
  return isJsonRecord(value) && isJsonValue(value) ? value : {};
}

function arrayValue(value: unknown): readonly JsonRecord[] {
  return Array.isArray(value) ? value.filter(isJsonRecord) : [];
}

function emptyTenantExportManifest(): TenantExportManifest {
  return {
    version: 1,
    generatedAt: "",
    org: {
      id: "",
      slug: "",
      displayName: "",
      status: "",
      tier: "",
      planId: "",
      region: "",
    },
    configSnapshot: {
      byoConfig: {},
      featureFlags: {},
      quotas: {},
      branding: {},
    },
    objectInventory: {
      bytesIncluded: false,
      objectCount: 0,
      totalKnownBytes: 0,
      objects: [],
    },
    postgres: {
      rowCounts: [],
      rowDataChunks: {
        version: 1,
        format: "jsonl",
        chunks: [],
        includedTables: [],
        excludedTables: [],
        notes: [],
      },
    },
    auditLog: {
      rowCount: 0,
      firstEntryAt: null,
      lastEntryAt: null,
    },
  };
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (isJsonRecord(value)) {
    return Object.values(value).every(isJsonValue);
  }
  return false;
}
