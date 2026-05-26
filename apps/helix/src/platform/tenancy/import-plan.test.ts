import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildTenantExportArchive,
  buildTenantExportManifest,
  type TenantExportManifest,
  type TenantExportPostgresDataChunkFile,
  type TenantExportPostgresDataChunkManifest,
} from "./export.js";
import { buildTenantImportPlan, buildTenantImportPlanFromArchive } from "./import-plan.js";
import type { OrgRecord } from "./orgs.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const targetOrgId = "33333333-3333-4333-8333-333333333333";
const actorId = "11111111-1111-4111-8111-111111111111";
const domainId = "44444444-4444-4444-8444-444444444444";
const dnsRecordId = "55555555-5555-4555-8555-555555555555";
const resourceClassificationId = "66666666-6666-4666-8666-666666666666";
const driveFolderId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const objectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const permissionId = "babababa-baba-4bab-8bab-babababababa";
const driveVersionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const targetDomainId = "77777777-7777-4777-8777-777777777777";
const targetDnsRecordId = "88888888-8888-4888-8888-888888888888";
const targetResourceClassificationId = "99999999-9999-4999-8999-999999999999";
const targetDriveFolderId = "12121212-1212-4212-8212-121212121212";
const targetObjectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const targetPermissionId = "dadadada-dada-4dad-8dad-dadadadadada";
const targetDriveVersionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

describe("buildTenantImportPlan", () => {
  it("builds a pure dry-run plan for the current row chunks", () => {
    const input = validImportPlanInput({
      objects: [
        { storageKey: "objects/a.txt", byteSize: 10, sha256: "a".repeat(64) },
        { storageKey: "objects/b.txt", byteSize: 15 },
      ],
      bytesIncluded: true,
    });

    const plan = buildTenantImportPlan(input);

    expect(plan).toMatchObject({
      dryRun: true,
      ok: true,
      source: {
        orgId,
        slug: "acme",
        generatedAt: "2026-05-24T10:00:00.000Z",
      },
      target: {
        orgId,
        rewritesOrgId: false,
      },
      objectBytes: {
        mode: "included",
        objectCount: 2,
        totalKnownBytes: 25,
      },
      summary: {
        postgresRows: 7,
        adminDomainRows: 1,
        adminDnsRecordRows: 1,
        driveFolderRows: 1,
        objectRows: 1,
        permissionRows: 1,
        driveVersionRows: 1,
        resourceClassificationRows: 1,
        operationCount: 7,
      },
    });
    expect(plan.operations.map((operation) => operation.kind)).toEqual([
      "upsert_admin_domain",
      "upsert_admin_dns_record",
      "upsert_drive_folder",
      "upsert_object",
      "upsert_permission",
      "upsert_drive_version",
      "upsert_resource_classification",
    ]);
    expect(plan.operations.map((operation) => operation.order)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(plan.operations[1]).toMatchObject({
      table: "admin_dns_records",
      dependsOn: [`admin_domains:${domainId}`],
      naturalKey: [domainId, "TXT", "_helix.example.com"],
    });
    expect(plan.operations[0]?.conflictPolicy).toEqual({
      rowId: "preserve",
      references: {
        createdBy: "preserve",
      },
      state: {
        isPrimary: "preserve",
        verificationStatus: "regenerate",
        verifiedAt: "regenerate",
      },
    });
    expect(plan.operations[1]?.conflictPolicy).toEqual({
      rowId: "preserve",
      references: {
        domainId: "preserve",
      },
      state: {
        status: "regenerate",
        observedValue: "regenerate",
        lastCheckedAt: "regenerate",
      },
    });
    expect(plan.operations[2]?.conflictPolicy).toEqual({
      rowId: "preserve",
      references: {
        ownerActorId: "preserve",
        createdByActorId: "preserve",
      },
      state: {},
    });
    expect(plan.operations[3]?.conflictPolicy).toEqual({
      rowId: "preserve",
      references: {
        ownerActorId: "preserve",
        folderId: "preserve",
      },
      state: {},
    });
    expect(plan.operations[4]?.conflictPolicy).toEqual({
      rowId: "preserve",
      references: {
        resourceId: "preserve",
        actorId: "preserve",
        grantedByActorId: "preserve",
      },
      state: {},
    });
    expect(plan.operations[4]).toMatchObject({
      table: "permissions",
      dependsOn: [`objects:${objectId}`],
      naturalKey: ["object", objectId, actorId, "viewer"],
    });
    expect(plan.operations[5]?.conflictPolicy).toEqual({
      rowId: "preserve",
      references: {
        objectId: "preserve",
        createdByActorId: "preserve",
      },
      state: {},
    });
    expect(plan.operations[5]).toMatchObject({
      table: "drive_versions",
      dependsOn: [`objects:${objectId}`],
      naturalKey: [objectId, "1"],
    });
    expect(plan.operations[6]?.conflictPolicy).toEqual({
      rowId: "preserve",
      references: {
        actorId: "preserve",
        resourceId: "preserve",
      },
      state: {},
    });
    expect(plan.steps.map((step) => step.kind)).toEqual([
      "tenant_config",
      "storage_objects",
      "postgres_rows",
      "postgres_rows",
      "postgres_rows",
      "postgres_rows",
      "postgres_rows",
      "postgres_rows",
      "postgres_rows",
    ]);
    expect(issueCodes(plan)).toEqual(
      expect.arrayContaining([
        "domain_id_remap_required",
        "object_id_remap_required",
        "folder_id_remap_required",
        "principal_remap_required",
        "resource_reference_deferred",
        "verified_state_requires_recheck",
        "primary_domain_conflict_check_required",
      ]),
    );
  });

  it("reports target org rewrites without mutating the source manifest", () => {
    const input = validImportPlanInput();

    const plan = buildTenantImportPlan({
      ...input,
      targetOrgId,
      targetSlug: "target-acme",
    });

    expect(plan.target).toEqual({
      orgId: targetOrgId,
      slug: "target-acme",
      rewritesOrgId: true,
    });
    expect(plan.operations.every((operation) => operation.targetOrgId === targetOrgId)).toBe(true);
    expect(plan.operations.every((operation) => operation.row.orgId === targetOrgId)).toBe(true);
    expect(input.manifest.org.id).toBe(orgId);
    expect(issueCodes(plan)).toContain("org_id_remap_required");
  });

  it("uses target facts and provided remaps to shape operations and conflicts", () => {
    const input = validImportPlanInput();

    const plan = buildTenantImportPlan({
      ...input,
      targetOrgId,
      remaps: {
        principals: {
          [actorId]: null,
        },
        resources: {
          [`object:${objectId}`]: targetObjectId,
        },
      },
      targetState: {
        primaryDomain: "other.example.com",
        existingNaturalKeys: [
          {
            table: "admin_domains",
            naturalKey: ["example.com"],
            targetId: targetDomainId,
          },
          {
            table: "admin_dns_records",
            naturalKey: [targetDomainId, "TXT", "_helix.example.com"],
            targetId: targetDnsRecordId,
          },
          {
            table: "drive_folders",
            naturalKey: ["", "Projects"],
            targetId: targetDriveFolderId,
          },
          {
            table: "objects",
            naturalKey: ["drive/report.txt"],
            targetId: targetObjectId,
          },
          {
            table: "permissions",
            naturalKey: ["object", targetObjectId, actorId, "viewer"],
            targetId: targetPermissionId,
          },
          {
            table: "drive_versions",
            naturalKey: [targetObjectId, "1"],
            targetId: targetDriveVersionId,
          },
          {
            table: "resource_classifications",
            naturalKey: ["object", targetObjectId],
            targetId: targetResourceClassificationId,
          },
        ],
      },
    });

    expect(plan.summary).toMatchObject({
      remapCount: 13,
      conflictCount: 8,
    });
    expect(plan.operations[0]).toMatchObject({
      action: "update",
      table: "admin_domains",
      sourceId: domainId,
      targetId: targetDomainId,
      remappedFields: {
        orgId: targetOrgId,
        createdBy: null,
      },
      conflictPolicy: {
        rowId: "match",
        references: {
          createdBy: "null",
        },
        state: {
          isPrimary: "preserve",
          verificationStatus: "regenerate",
          verifiedAt: "regenerate",
        },
      },
    });
    expect(plan.operations[0]?.row).toMatchObject({
      orgId: targetOrgId,
      createdBy: null,
    });
    expect(plan.operations[1]).toMatchObject({
      action: "update",
      table: "admin_dns_records",
      sourceId: dnsRecordId,
      targetId: targetDnsRecordId,
      naturalKey: [targetDomainId, "TXT", "_helix.example.com"],
      dependsOn: [`admin_domains:${targetDomainId}`],
      remappedFields: {
        orgId: targetOrgId,
        domainId: targetDomainId,
      },
      conflictPolicy: {
        rowId: "match",
        references: {
          domainId: "match",
        },
        state: {
          status: "regenerate",
          observedValue: "regenerate",
          lastCheckedAt: "regenerate",
        },
      },
    });
    expect(plan.operations[1]?.row).toMatchObject({
      orgId: targetOrgId,
      domainId: targetDomainId,
    });
    expect(plan.operations[2]).toMatchObject({
      action: "update",
      table: "drive_folders",
      sourceId: driveFolderId,
      targetId: targetDriveFolderId,
      naturalKey: ["", "Projects"],
      remappedFields: {
        orgId: targetOrgId,
        ownerActorId: null,
        createdByActorId: null,
      },
      conflictPolicy: {
        rowId: "match",
        references: {
          ownerActorId: "null",
          createdByActorId: "null",
        },
        state: {},
      },
    });
    expect(plan.operations[2]?.row).toMatchObject({
      orgId: targetOrgId,
      ownerActorId: null,
      createdByActorId: null,
    });
    expect(plan.operations[3]).toMatchObject({
      action: "update",
      table: "objects",
      sourceId: objectId,
      targetId: targetObjectId,
      naturalKey: ["drive/report.txt"],
      remappedFields: {
        orgId: targetOrgId,
        ownerActorId: null,
        metadata: { folderId: targetDriveFolderId, name: "report.txt" },
      },
      conflictPolicy: {
        rowId: "match",
        references: {
          ownerActorId: "null",
          folderId: "match",
        },
        state: {},
      },
    });
    expect(plan.operations[3]?.row).toMatchObject({
      orgId: targetOrgId,
      ownerActorId: null,
      metadata: { folderId: targetDriveFolderId, name: "report.txt" },
    });
    expect(plan.operations[4]).toMatchObject({
      action: "blocked",
      table: "permissions",
      sourceId: permissionId,
      targetId: targetPermissionId,
      naturalKey: ["object", targetObjectId, actorId, "viewer"],
      dependsOn: [`objects:${targetObjectId}`],
      remappedFields: {
        orgId: targetOrgId,
        resourceId: targetObjectId,
        grantedByActorId: null,
      },
      conflictPolicy: {
        rowId: "match",
        references: {
          resourceId: "match",
          actorId: "null",
          grantedByActorId: "null",
        },
        state: {},
      },
    });
    expect(plan.operations[4]?.row).toMatchObject({
      orgId: targetOrgId,
      resourceId: targetObjectId,
      grantedByActorId: null,
    });
    expect(plan.operations[5]).toMatchObject({
      action: "update",
      table: "drive_versions",
      sourceId: driveVersionId,
      targetId: targetDriveVersionId,
      naturalKey: [targetObjectId, "1"],
      dependsOn: [`objects:${targetObjectId}`],
      remappedFields: {
        orgId: targetOrgId,
        objectId: targetObjectId,
        createdByActorId: null,
      },
      conflictPolicy: {
        rowId: "match",
        references: {
          objectId: "match",
          createdByActorId: "null",
        },
        state: {},
      },
    });
    expect(plan.operations[5]?.row).toMatchObject({
      orgId: targetOrgId,
      objectId: targetObjectId,
      createdByActorId: null,
    });
    expect(plan.operations[6]).toMatchObject({
      action: "update",
      table: "resource_classifications",
      sourceId: resourceClassificationId,
      targetId: targetResourceClassificationId,
      naturalKey: ["object", targetObjectId],
      remappedFields: {
        orgId: targetOrgId,
        actorId: null,
        resourceId: targetObjectId,
      },
      conflictPolicy: {
        rowId: "match",
        references: {
          actorId: "null",
          resourceId: "match",
        },
        state: {},
      },
    });
    expect(plan.operations[6]?.row).toMatchObject({
      orgId: targetOrgId,
      actorId: null,
      resourceId: targetObjectId,
    });
    expect(plan.remaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "principal",
          sourceId: actorId,
          status: "rewrite",
          reason: "Principal reference will be nulled during apply.",
        }),
        expect.objectContaining({
          kind: "resource",
          sourceId: objectId,
          targetId: targetObjectId,
          status: "rewrite",
        }),
      ]),
    );
    expect(plan.conflicts.map((conflict) => conflict.code)).toEqual(
      expect.arrayContaining(["target_natural_key_conflict", "target_primary_domain_conflict"]),
    );
    expect(input.manifest.org.id).toBe(orgId);
  });

  it("chooses regenerate policy for source row ID conflicts without mutating target IDs", () => {
    const input = validImportPlanInput();

    const plan = buildTenantImportPlan({
      ...input,
      targetState: {
        existingRowIds: [
          {
            table: "admin_domains",
            id: domainId,
            targetId: "target-existing-domain-row",
          },
        ],
      },
    });

    expect(plan.operations[0]).toMatchObject({
      action: "insert",
      table: "admin_domains",
      sourceId: domainId,
      targetId: null,
      conflictPolicy: {
        rowId: "regenerate",
      },
    });
    expect(plan.operations[0]?.row.id).toBe(domainId);
    expect(plan.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "target_primary_key_conflict",
          table: "admin_domains",
          sourceId: domainId,
          targetId: "target-existing-domain-row",
        }),
      ]),
    );
  });

  it("applies explicit row ID conflict policy without mutating target IDs", () => {
    const input = validImportPlanInput();

    const plan = buildTenantImportPlan({
      ...input,
      conflictPolicy: {
        rowIdConflicts: "preserve",
      },
      targetState: {
        existingRowIds: [
          {
            table: "admin_domains",
            id: domainId,
          },
        ],
      },
    });

    expect(plan.operations[0]).toMatchObject({
      action: "insert",
      targetId: null,
      row: {
        id: domainId,
      },
      conflictPolicy: {
        rowId: "preserve",
      },
    });
    expect(plan.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "target_primary_key_conflict",
          sourceId: domainId,
        }),
      ]),
    );
  });

  it("applies explicit conflict policy input without mutating planned rows", () => {
    const input = validImportPlanInput();

    const plan = buildTenantImportPlan({
      ...input,
      conflictPolicy: {
        principalReferences: "null",
        resourceReferences: "preserve",
        verifiedState: "preserve",
      },
    });

    expect(plan.operations[0]).toMatchObject({
      targetId: null,
      row: {
        id: domainId,
        createdBy: actorId,
        verificationStatus: "verified",
      },
      conflictPolicy: {
        rowId: "preserve",
        references: {
          createdBy: "null",
        },
        state: {
          verificationStatus: "preserve",
          verifiedAt: "preserve",
          isPrimary: "preserve",
        },
      },
    });
    expect(plan.operations[2]).toMatchObject({
      row: {
        ownerActorId: actorId,
        createdByActorId: actorId,
      },
      conflictPolicy: {
        references: {
          ownerActorId: "null",
          createdByActorId: "null",
        },
      },
    });
    expect(plan.operations[3]).toMatchObject({
      row: {
        ownerActorId: actorId,
      },
      conflictPolicy: {
        references: {
          ownerActorId: "null",
          folderId: "preserve",
        },
      },
    });
    expect(plan.operations[4]).toMatchObject({
      row: {
        actorId,
        grantedByActorId: actorId,
        resourceId: objectId,
      },
      conflictPolicy: {
        references: {
          actorId: "null",
          grantedByActorId: "null",
          resourceId: "preserve",
        },
      },
    });
    expect(plan.operations[4]?.action).toBe("blocked");
    expect(plan.operations[5]).toMatchObject({
      row: {
        createdByActorId: actorId,
        objectId,
      },
      conflictPolicy: {
        references: {
          createdByActorId: "null",
          objectId: "preserve",
        },
      },
    });
    expect(plan.operations[6]).toMatchObject({
      row: {
        actorId,
        resourceId: objectId,
      },
      conflictPolicy: {
        references: {
          actorId: "null",
          resourceId: "preserve",
        },
      },
    });
    expect(plan.operations[6]?.action).toBe("insert");
  });

  it("returns validation blockers and no operations when the archive rows are invalid", () => {
    const input = validImportPlanInput();
    const manifest = withChunkManifest(input.manifest, {
      ...input.manifest.postgres.rowDataChunks,
      chunks: input.manifest.postgres.rowDataChunks.chunks.map((chunk) =>
        chunk.table === "admin_domains"
          ? {
              ...chunk,
              rowCount: chunk.rowCount + 1,
              sha256: "0".repeat(64),
            }
          : chunk,
      ),
    });

    const plan = buildTenantImportPlan({
      manifest,
      files: input.files,
    });

    expect(plan.ok).toBe(false);
    expect(plan.operations).toEqual([]);
    expect(plan.steps).toEqual([]);
    expect(plan.issues).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "export_validation_failed",
      }),
    ]);
    expect(plan.issues[0]?.validationIssues?.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["chunk_digest_mismatch", "chunk_row_count_mismatch"]),
    );
  });

  it("accepts exports with no row chunks and reports metadata-only object bytes", () => {
    const manifest = tenantExportManifest({
      objects: [{ storageKey: "objects/source-only.bin", byteSize: 12 }],
    });

    const plan = buildTenantImportPlan({
      manifest,
      files: {},
    });

    expect(plan).toMatchObject({
      ok: true,
      objectBytes: {
        mode: "metadata_only",
        objectCount: 1,
        totalKnownBytes: 12,
      },
      summary: {
        postgresRows: 0,
        operationCount: 0,
      },
      operations: [],
    });
    expect(plan.steps.map((step) => step.kind)).toEqual(["tenant_config", "storage_objects"]);
  });

  it("builds a dry-run plan directly from an export archive", async () => {
    const input = validImportPlanInput({
      objects: [
        { storageKey: "objects/a.txt", byteSize: 10, sha256: "a".repeat(64) },
        { storageKey: "objects/b.txt", byteSize: 15 },
      ],
    });
    const archive = await buildTenantExportArchive(input.manifest);

    const result = buildTenantImportPlanFromArchive({
      archive: archive.bytes,
      targetOrgId,
      targetSlug: "target-acme",
    });

    expect(result.issues).toEqual([]);
    expect(result.plan).toMatchObject({
      dryRun: true,
      ok: true,
      source: {
        orgId,
        slug: "acme",
      },
      target: {
        orgId: targetOrgId,
        slug: "target-acme",
        rewritesOrgId: true,
      },
      objectBytes: {
        mode: "metadata_only",
        objectCount: 2,
        totalKnownBytes: 25,
      },
      summary: {
        postgresRows: 7,
        operationCount: 7,
      },
    });
    expect(result.plan?.operations.map((operation) => operation.kind)).toEqual([
      "upsert_admin_domain",
      "upsert_admin_dns_record",
      "upsert_drive_folder",
      "upsert_object",
      "upsert_permission",
      "upsert_drive_version",
      "upsert_resource_classification",
    ]);
    expect(result.plan?.operations[0]?.conflictPolicy).toMatchObject({
      rowId: "preserve",
      references: {
        createdBy: "preserve",
      },
    });
    expect(result.plan?.issues.map((issue) => issue.code)).toContain("org_id_remap_required");
  });

  it("reports archive metadata errors before planning", () => {
    const result = buildTenantImportPlanFromArchive({
      archive: Buffer.alloc(1024),
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing_archive_entry",
          path: "manifest.json",
        }),
        expect.objectContaining({
          code: "missing_archive_entry",
          path: "objects/inventory.json",
        }),
        expect.objectContaining({
          code: "missing_archive_entry",
          path: "postgres/data/chunks/manifest.json",
        }),
      ]),
    );
  });

  it("returns a validation-blocked plan when archive row bytes are tampered", async () => {
    const input = validImportPlanInput();
    const archive = await buildTenantExportArchive(input.manifest);
    const tampered = tamperTarEntryByte(
      archive.bytes,
      "postgres/data/chunks/admin_domains/000000.jsonl",
    );

    const result = buildTenantImportPlanFromArchive({
      archive: tampered,
    });

    expect(result.issues).toEqual([]);
    expect(result.plan).toMatchObject({
      ok: false,
      operations: [],
      issues: [
        expect.objectContaining({
          code: "export_validation_failed",
        }),
      ],
    });
    expect(result.plan?.issues[0]?.validationIssues?.map((issue) => issue.code)).toContain(
      "chunk_digest_mismatch",
    );
  });
});

function validImportPlanInput(
  input: {
    readonly domainRows?: readonly Record<string, unknown>[];
    readonly dnsRows?: readonly Record<string, unknown>[];
    readonly driveFolderRows?: readonly Record<string, unknown>[];
    readonly objectRows?: readonly Record<string, unknown>[];
    readonly permissionRows?: readonly Record<string, unknown>[];
    readonly driveVersionRows?: readonly Record<string, unknown>[];
    readonly resourceClassificationRows?: readonly Record<string, unknown>[];
    readonly objects?: readonly TestStorageObject[];
    readonly bytesIncluded?: boolean | undefined;
  } = {},
): {
  readonly manifest: TenantExportManifest;
  readonly files: ReadonlyMap<string, Uint8Array>;
} {
  const chunks = [
    chunkFile({
      table: "admin_domains",
      path: "postgres/data/chunks/admin_domains/000000.jsonl",
      orderBy: ["lower(domain)", "created_at", "id"],
      rows: input.domainRows ?? [adminDomainRow()],
    }),
    chunkFile({
      table: "admin_dns_records",
      path: "postgres/data/chunks/admin_dns_records/000000.jsonl",
      orderBy: ["domain_id", "record_type", "host", "id"],
      rows: input.dnsRows ?? [adminDnsRecordRow()],
    }),
    chunkFile({
      table: "drive_folders",
      path: "postgres/data/chunks/drive_folders/000000.jsonl",
      orderBy: ["path(name,id)"],
      rows: input.driveFolderRows ?? [driveFolderRow()],
    }),
    chunkFile({
      table: "objects",
      path: "postgres/data/chunks/objects/000000.jsonl",
      orderBy: ["kind", "storage_key", "id"],
      rows: input.objectRows ?? [objectRow()],
    }),
    chunkFile({
      table: "permissions",
      path: "postgres/data/chunks/permissions/000000.jsonl",
      orderBy: ["resource_type", "resource_id", "actor_id", "role", "id"],
      rows: input.permissionRows ?? [permissionRow()],
    }),
    chunkFile({
      table: "drive_versions",
      path: "postgres/data/chunks/drive_versions/000000.jsonl",
      orderBy: ["object_id", "version_number", "id"],
      rows: input.driveVersionRows ?? [driveVersionRow()],
    }),
    chunkFile({
      table: "resource_classifications",
      path: "postgres/data/chunks/resource_classifications/000000.jsonl",
      orderBy: ["resource_type", "resource_id", "id"],
      rows: input.resourceClassificationRows ?? [resourceClassificationRow()],
    }),
  ];

  return {
    manifest: tenantExportManifest({
      rowDataChunkFiles: chunks,
      ...(input.objects === undefined ? {} : { objects: input.objects }),
      ...(input.bytesIncluded === undefined ? {} : { bytesIncluded: input.bytesIncluded }),
    }),
    files: new Map(chunks.map((chunk) => [chunk.metadata.path, chunk.body] as const)),
  };
}

function tenantExportManifest(
  input: {
    readonly rowDataChunkFiles?: readonly TenantExportPostgresDataChunkFile[] | undefined;
    readonly objects?: readonly TestStorageObject[];
    readonly bytesIncluded?: boolean | undefined;
  } = {},
): TenantExportManifest {
  return buildTenantExportManifest({
    org: orgRecord(),
    generatedAt: new Date("2026-05-24T10:00:00.000Z"),
    objects: input.objects ?? [],
    rowCounts: [],
    auditSummary: {
      rowCount: 0,
      firstEntryAt: null,
      lastEntryAt: null,
    },
    ...(input.rowDataChunkFiles === undefined
      ? {}
      : { rowDataChunkFiles: input.rowDataChunkFiles }),
    ...(input.bytesIncluded === undefined ? {} : { bytesIncluded: input.bytesIncluded }),
  });
}

function chunkFile(input: {
  readonly table: string;
  readonly path: string;
  readonly orderBy: readonly string[];
  readonly rows: readonly Record<string, unknown>[];
}): TenantExportPostgresDataChunkFile {
  const body = Buffer.from(
    input.rows.map((row) => JSON.stringify(row)).join("\n") + (input.rows.length > 0 ? "\n" : ""),
    "utf8",
  );
  return {
    metadata: {
      table: input.table,
      path: input.path,
      rowCount: input.rows.length,
      byteSize: body.byteLength,
      sha256: createHash("sha256").update(body).digest("hex"),
      orderBy: input.orderBy,
    },
    body,
  };
}

function adminDomainRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: domainId,
    orgId,
    domain: "example.com",
    isPrimary: true,
    verificationStatus: "verified",
    verifiedAt: "2026-05-24T09:30:00.000Z",
    createdBy: actorId,
    createdAt: "2026-05-24T09:00:00.000Z",
    updatedAt: "2026-05-24T09:30:00.000Z",
    ...overrides,
  };
}

function adminDnsRecordRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: dnsRecordId,
    orgId,
    domainId,
    recordType: "TXT",
    host: "_helix.example.com",
    expectedValue: "helix-verification=abc",
    observedValue: "helix-verification=abc",
    status: "verified",
    lastCheckedAt: "2026-05-24T09:25:00.000Z",
    createdAt: "2026-05-24T09:00:00.000Z",
    updatedAt: "2026-05-24T09:25:00.000Z",
    ...overrides,
  };
}

function objectRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: objectId,
    orgId,
    ownerActorId: actorId,
    kind: "file",
    storageKey: "drive/report.txt",
    mimeType: "text/plain",
    byteSize: 12,
    sha256: "a".repeat(64),
    classification: "internal",
    metadata: { folderId: driveFolderId, name: "report.txt" },
    deletedAt: null,
    createdAt: "2026-05-24T09:00:00.000Z",
    updatedAt: "2026-05-24T09:30:00.000Z",
    ...overrides,
  };
}

function driveFolderRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: driveFolderId,
    orgId,
    name: "Projects",
    parentFolderId: null,
    ownerActorId: actorId,
    createdByActorId: actorId,
    metadata: { color: "blue" },
    deletedAt: null,
    createdAt: "2026-05-24T09:00:00.000Z",
    updatedAt: "2026-05-24T09:30:00.000Z",
    ...overrides,
  };
}

function driveVersionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: driveVersionId,
    orgId,
    objectId,
    versionNumber: 1,
    storageKey: "drive/report.txt",
    mimeType: "text/plain",
    byteSize: 12,
    sha256: "a".repeat(64),
    metadata: { preview: "ready" },
    createdByActorId: actorId,
    createdAt: "2026-05-24T09:30:00.000Z",
    ...overrides,
  };
}

function permissionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: permissionId,
    orgId,
    actorId,
    resourceType: "object",
    resourceId: objectId,
    role: "viewer",
    grantedByActorId: actorId,
    expiresAt: null,
    createdAt: "2026-05-24T09:00:00.000Z",
    updatedAt: "2026-05-24T09:30:00.000Z",
    ...overrides,
  };
}

function resourceClassificationRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: resourceClassificationId,
    orgId,
    resourceType: "object",
    resourceId: objectId,
    classification: "confidential",
    source: "label",
    reason: "label:HR",
    actorId,
    createdAt: "2026-05-24T09:00:00.000Z",
    updatedAt: "2026-05-24T09:30:00.000Z",
    ...overrides,
  };
}

function withChunkManifest(
  manifest: TenantExportManifest,
  rowDataChunks: TenantExportPostgresDataChunkManifest,
): TenantExportManifest {
  return {
    ...manifest,
    postgres: {
      ...manifest.postgres,
      rowDataChunks,
    },
  };
}

function issueCodes(plan: {
  readonly issues: readonly {
    readonly code: string;
  }[];
}): readonly string[] {
  return plan.issues.map((issue) => issue.code);
}

function tamperTarEntryByte(archive: Buffer, path: string): Buffer {
  const tampered = Buffer.from(archive);
  for (let offset = 0; offset + 512 <= tampered.byteLength; ) {
    const header = tampered.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const entryPath = header.subarray(0, 100).toString("utf8").replace(/\0.*$/u, "");
    const sizeOctal = header.subarray(124, 136).toString("ascii").replace(/\0.*$/u, "").trim();
    const size = Number.parseInt(sizeOctal, 8);
    const bodyStart = offset + 512;
    if (entryPath === path) {
      if (size < 1) {
        throw new Error(`Cannot tamper empty tar entry: ${path}.`);
      }
      tampered[bodyStart] = (tampered[bodyStart] ?? 0) === 0x7b ? 0x5b : 0x7b;
      return tampered;
    }
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  throw new Error(`Tar entry not found: ${path}.`);
}

interface TestStorageObject {
  readonly storageKey: string;
  readonly byteSize?: number | undefined;
  readonly sha256?: string | undefined;
}

function orgRecord(overrides: Partial<OrgRecord> = {}): OrgRecord {
  return {
    id: orgId,
    slug: "acme",
    displayName: "Acme",
    status: "active",
    tier: "business",
    planId: "business",
    region: "us-east-1",
    byoConfig: { storage: { kind: "helix-default" } },
    featureFlags: { byo_storage: true },
    quotas: { export_jobs_per_hour: 1 },
    branding: { display_name_override: "Acme" },
    suspendedAt: null,
    softDeletedAt: null,
    hardDeletedAt: null,
    ...overrides,
  };
}
