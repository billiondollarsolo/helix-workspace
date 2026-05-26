import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import type { TenantImportPlanOperation } from "./import-plan.js";
import {
  applyTenantImportPlanRows,
  PostgresTenantImportRowApplyStore,
} from "./import-row-apply.js";

const sourceOrgId = "22222222-2222-4222-8222-222222222222";
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

describe("PostgresTenantImportRowApplyStore", () => {
  it("blocks planned blocked operations without issuing SQL", async () => {
    const recording = createRecordingSql([]);
    const store = new PostgresTenantImportRowApplyStore(recording.sql);

    await expect(
      store.applyOperation({
        operation: operation({
          action: "blocked",
        }),
      }),
    ).resolves.toMatchObject({
      action: "blocked",
      blockedReason: "planned_operation_blocked",
      sourceId: domainId,
    });
    expect(recording.calls).toEqual([]);
  });

  it("inserts admin domains for the target org and regenerates verified state by default", async () => {
    const recording = createRecordingSql([[{ id: targetDomainId }]]);
    const store = new PostgresTenantImportRowApplyStore(recording.sql);

    await expect(
      store.applyOperation({
        operation: operation({
          conflictPolicy: {
            rowId: "regenerate",
            references: { createdBy: "null" },
            state: {
              verificationStatus: "regenerate",
              verifiedAt: "regenerate",
              isPrimary: "null",
            },
          },
        }),
      }),
    ).resolves.toMatchObject({
      action: "inserted",
      targetId: targetDomainId,
    });

    expect(recording.calls).toHaveLength(1);
    expect(recording.calls[0]?.text).toContain("insert into admin_domains");
    expect(recording.calls[0]?.text).toContain("(org_id, domain, is_primary");
    expect(recording.calls[0]?.text).not.toContain("(id, org_id");
    expect(recording.calls[0]?.values).toEqual([
      targetOrgId,
      "example.com",
      false,
      "pending",
      null,
      null,
      "2026-05-24T10:00:00.000Z",
      "2026-05-24T10:05:00.000Z",
    ]);
  });

  it("updates matched admin domains by targetId and clears sibling primaries", async () => {
    const recording = createRecordingSql([[{ id: targetDomainId }], []]);
    const store = new PostgresTenantImportRowApplyStore(recording.sql);

    await expect(
      store.applyOperation({
        operation: operation({
          action: "update",
          targetId: targetDomainId,
          row: {
            isPrimary: true,
          },
          conflictPolicy: {
            rowId: "match",
            references: { createdBy: "preserve" },
            state: {
              verificationStatus: "regenerate",
              verifiedAt: "regenerate",
              isPrimary: "preserve",
            },
          },
        }),
      }),
    ).resolves.toMatchObject({
      action: "updated",
      targetId: targetDomainId,
    });

    expect(recording.calls).toHaveLength(2);
    expect(recording.calls[0]?.text).toContain("update admin_domains");
    expect(recording.calls[0]?.text).toContain("where org_id = ? and id = ?");
    expect(recording.calls[0]?.values).toEqual([
      "example.com",
      true,
      "pending",
      null,
      actorId,
      "2026-05-24T10:05:00.000Z",
      targetOrgId,
      targetDomainId,
    ]);
    expect(recording.calls[1]?.text).toContain("update admin_domains set is_primary = false");
    expect(recording.calls[1]?.values).toEqual([targetOrgId, targetDomainId]);
  });

  it("blocks DNS inserts when the required domain row remap is unavailable", async () => {
    const recording = createRecordingSql([]);
    const store = new PostgresTenantImportRowApplyStore(recording.sql);

    await expect(
      store.applyOperation({
        operation: dnsOperation(),
      }),
    ).resolves.toMatchObject({
      action: "blocked",
      blockedReason: "domain_id_remap_missing",
    });
    expect(recording.calls).toEqual([]);
  });

  it("inserts DNS records through defensive natural-key lookup without ON CONFLICT", async () => {
    const recording = createRecordingSql([[], [{ id: targetDnsRecordId }]]);
    const store = new PostgresTenantImportRowApplyStore(recording.sql);

    await expect(
      store.applyOperation({
        operation: dnsOperation({
          conflictPolicy: {
            rowId: "preserve",
            references: { domainId: "match" },
            state: {
              status: "regenerate",
              observedValue: "regenerate",
              lastCheckedAt: "regenerate",
            },
          },
        }),
        rowIdRemaps: new Map([[domainId, targetDomainId]]),
      }),
    ).resolves.toMatchObject({
      action: "inserted",
      targetId: targetDnsRecordId,
    });

    expect(recording.calls).toHaveLength(2);
    expect(recording.calls[0]?.text).toContain("select id");
    expect(recording.calls[0]?.text).toContain("from admin_dns_records");
    expect(recording.calls[0]?.text).toContain("for update");
    expect(recording.calls[1]?.text).toContain("insert into admin_dns_records");
    expect(recording.calls[1]?.text).not.toContain("on conflict");
    expect(recording.calls[1]?.values).toEqual([
      dnsRecordId,
      targetOrgId,
      targetDomainId,
      "TXT",
      "_helix.example.com",
      "helix-verification=source",
      null,
      "pending",
      null,
      "2026-05-24T10:01:00.000Z",
      "2026-05-24T10:06:00.000Z",
    ]);
  });

  it("updates matched DNS records by targetId", async () => {
    const recording = createRecordingSql([[{ id: targetDnsRecordId }]]);
    const store = new PostgresTenantImportRowApplyStore(recording.sql);

    await expect(
      store.applyOperation({
        operation: dnsOperation({
          action: "update",
          targetId: targetDnsRecordId,
          row: {
            domainId: targetDomainId,
          },
          conflictPolicy: {
            rowId: "match",
            references: { domainId: "match" },
            state: {
              status: "regenerate",
              observedValue: "regenerate",
              lastCheckedAt: "regenerate",
            },
          },
        }),
      }),
    ).resolves.toMatchObject({
      action: "updated",
      targetId: targetDnsRecordId,
    });

    expect(recording.calls).toHaveLength(1);
    expect(recording.calls[0]?.text).toContain("update admin_dns_records");
    expect(recording.calls[0]?.text).toContain("where org_id = ? and id = ?");
    expect(recording.calls[0]?.values).toEqual([
      targetDomainId,
      "TXT",
      "_helix.example.com",
      "helix-verification=source",
      null,
      "pending",
      null,
      "2026-05-24T10:06:00.000Z",
      targetOrgId,
      targetDnsRecordId,
    ]);
  });

  it("inserts object metadata and nulls owner principals by policy", async () => {
    const recording = createRecordingSql([[], [{ id: targetObjectId }]]);
    const store = new PostgresTenantImportRowApplyStore(recording.sql);

    await expect(
      store.applyOperation({
        operation: objectOperation({
          conflictPolicy: {
            rowId: "preserve",
            references: { ownerActorId: "null" },
            state: {},
          },
        }),
      }),
    ).resolves.toMatchObject({
      action: "inserted",
      targetId: targetObjectId,
    });

    expect(recording.calls).toHaveLength(2);
    expect(recording.calls[0]?.text).toContain("from objects");
    expect(recording.calls[0]?.text).toContain("storage_key = ?");
    expect(recording.calls[1]?.text).toContain("insert into objects");
    expect(recording.calls[1]?.text).toContain("(id, org_id, owner_actor_id");
    expect(recording.calls[1]?.values).toEqual([
      objectId,
      targetOrgId,
      null,
      "file",
      "drive/report.txt",
      "text/plain",
      12,
      "a".repeat(64),
      "internal",
      { name: "report.txt" },
      null,
      "2026-05-24T10:02:00.000Z",
      "2026-05-24T10:07:00.000Z",
    ]);
  });

  it("inserts Drive folder metadata through parent row remaps", async () => {
    const childFolderId = "abababab-abab-4aba-8aba-abababababab";
    const targetChildFolderId = "cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd";
    const recording = createRecordingSql([[], [{ id: targetChildFolderId }]]);
    const store = new PostgresTenantImportRowApplyStore(recording.sql);

    await expect(
      store.applyOperation({
        operation: driveFolderOperation({
          sourceId: childFolderId,
          row: {
            id: childFolderId,
            parentFolderId: driveFolderId,
            ownerActorId: null,
            createdByActorId: null,
          },
          conflictPolicy: {
            rowId: "preserve",
            references: { folderId: "preserve", ownerActorId: "null", createdByActorId: "null" },
            state: {},
          },
        }),
        rowIdRemaps: new Map([[driveFolderId, targetDriveFolderId]]),
      }),
    ).resolves.toMatchObject({
      action: "inserted",
      targetId: targetChildFolderId,
    });

    expect(recording.calls).toHaveLength(2);
    expect(recording.calls[0]?.text).toContain("from drive_folders");
    expect(recording.calls[0]?.text).toContain("for update");
    expect(recording.calls[1]?.text).toContain("insert into drive_folders");
    expect(recording.calls[1]?.values).toEqual([
      childFolderId,
      targetOrgId,
      "Projects",
      targetDriveFolderId,
      null,
      null,
      { color: "blue" },
      null,
      "2026-05-24T10:02:00.000Z",
      "2026-05-24T10:07:00.000Z",
    ]);
  });

  it("blocks object metadata inserts when a referenced Drive folder remap is unavailable", async () => {
    const recording = createRecordingSql([]);
    const store = new PostgresTenantImportRowApplyStore(recording.sql);

    await expect(
      store.applyOperation({
        operation: objectOperation({
          row: {
            metadata: { folderId: driveFolderId, name: "report.txt" },
          },
          conflictPolicy: {
            rowId: "preserve",
            references: { ownerActorId: "null", folderId: "preserve" },
            state: {},
          },
        }),
      }),
    ).resolves.toMatchObject({
      action: "blocked",
      blockedReason: "folder_id_remap_missing",
    });
    expect(recording.calls).toEqual([]);
  });

  it("remaps object metadata folderId during insert", async () => {
    const recording = createRecordingSql([[], [{ id: targetObjectId }]]);
    const store = new PostgresTenantImportRowApplyStore(recording.sql);

    await expect(
      store.applyOperation({
        operation: objectOperation({
          row: {
            metadata: { folderId: driveFolderId, name: "report.txt" },
          },
          conflictPolicy: {
            rowId: "preserve",
            references: { ownerActorId: "null", folderId: "preserve" },
            state: {},
          },
        }),
        rowIdRemaps: new Map([[driveFolderId, targetDriveFolderId]]),
      }),
    ).resolves.toMatchObject({
      action: "inserted",
      targetId: targetObjectId,
    });

    expect(recording.calls[1]?.values).toContainEqual({
      folderId: targetDriveFolderId,
      name: "report.txt",
    });
  });

  it("updates matched object metadata by targetId", async () => {
    const recording = createRecordingSql([[{ id: targetObjectId }]]);
    const store = new PostgresTenantImportRowApplyStore(recording.sql);

    await expect(
      store.applyOperation({
        operation: objectOperation({
          action: "update",
          targetId: targetObjectId,
          row: {
            ownerActorId: null,
            deletedAt: "2026-05-25T10:00:00.000Z",
          },
          conflictPolicy: {
            rowId: "match",
            references: { ownerActorId: "null" },
            state: {},
          },
        }),
      }),
    ).resolves.toMatchObject({
      action: "updated",
      targetId: targetObjectId,
    });

    expect(recording.calls).toHaveLength(1);
    expect(recording.calls[0]?.text).toContain("update objects");
    expect(recording.calls[0]?.text).toContain("where org_id = ? and id = ?");
    expect(recording.calls[0]?.values).toEqual([
      null,
      "file",
      "drive/report.txt",
      "text/plain",
      12,
      "a".repeat(64),
      "internal",
      { name: "report.txt" },
      "2026-05-25T10:00:00.000Z",
      "2026-05-24T10:07:00.000Z",
      targetOrgId,
      targetObjectId,
    ]);
  });

  it("blocks Drive version inserts when the required object row remap is unavailable", async () => {
    const recording = createRecordingSql([]);
    const store = new PostgresTenantImportRowApplyStore(recording.sql);

    await expect(
      store.applyOperation({
        operation: driveVersionOperation(),
      }),
    ).resolves.toMatchObject({
      action: "blocked",
      blockedReason: "object_id_remap_missing",
    });
    expect(recording.calls).toEqual([]);
  });

  it("inserts Drive version metadata through object row remaps", async () => {
    const recording = createRecordingSql([[], [{ id: targetDriveVersionId }]]);
    const store = new PostgresTenantImportRowApplyStore(recording.sql);

    await expect(
      store.applyOperation({
        operation: driveVersionOperation({
          conflictPolicy: {
            rowId: "preserve",
            references: { objectId: "preserve", createdByActorId: "null" },
            state: {},
          },
        }),
        rowIdRemaps: new Map([[objectId, targetObjectId]]),
      }),
    ).resolves.toMatchObject({
      action: "inserted",
      targetId: targetDriveVersionId,
    });

    expect(recording.calls).toHaveLength(2);
    expect(recording.calls[0]?.text).toContain("from drive_versions");
    expect(recording.calls[0]?.text).toContain("object_id = ?");
    expect(recording.calls[0]?.text).toContain("version_number = ?");
    expect(recording.calls[1]?.text).toContain("insert into drive_versions");
    expect(recording.calls[1]?.values).toEqual([
      driveVersionId,
      targetOrgId,
      targetObjectId,
      1,
      "drive/report.txt",
      "text/plain",
      12,
      "a".repeat(64),
      { preview: "ready" },
      null,
      "2026-05-24T10:08:00.000Z",
    ]);
  });

  it("updates matched Drive version metadata by targetId", async () => {
    const recording = createRecordingSql([[{ id: targetDriveVersionId }]]);
    const store = new PostgresTenantImportRowApplyStore(recording.sql);

    await expect(
      store.applyOperation({
        operation: driveVersionOperation({
          action: "update",
          targetId: targetDriveVersionId,
          row: {
            objectId: targetObjectId,
            createdByActorId: null,
          },
          conflictPolicy: {
            rowId: "match",
            references: { objectId: "match", createdByActorId: "null" },
            state: {},
          },
        }),
      }),
    ).resolves.toMatchObject({
      action: "updated",
      targetId: targetDriveVersionId,
    });

    expect(recording.calls).toHaveLength(1);
    expect(recording.calls[0]?.text).toContain("update drive_versions");
    expect(recording.calls[0]?.text).toContain("where org_id = ? and id = ?");
    expect(recording.calls[0]?.values).toEqual([
      targetObjectId,
      1,
      "drive/report.txt",
      "text/plain",
      12,
      "a".repeat(64),
      { preview: "ready" },
      null,
      "2026-05-24T10:08:00.000Z",
      targetOrgId,
      targetDriveVersionId,
    ]);
  });

  it("upserts resource classifications on their tenant natural key", async () => {
    const recording = createRecordingSql([[{ id: targetResourceClassificationId }]]);
    const store = new PostgresTenantImportRowApplyStore(recording.sql);

    await expect(
      store.applyOperation({
        operation: resourceClassificationOperation({
          row: {
            actorId: null,
            resourceId: "target-msg-1",
          },
          conflictPolicy: {
            rowId: "preserve",
            references: {
              actorId: "null",
              resourceId: "match",
            },
            state: {},
          },
        }),
      }),
    ).resolves.toMatchObject({
      action: "inserted",
      targetId: targetResourceClassificationId,
    });

    expect(recording.calls).toHaveLength(1);
    expect(recording.calls[0]?.text).toContain("insert into resource_classifications");
    expect(recording.calls[0]?.text).toContain(
      "on conflict (org_id, resource_type, resource_id) do update",
    );
    expect(recording.calls[0]?.values).toEqual([
      resourceClassificationId,
      targetOrgId,
      "mail.message",
      "target-msg-1",
      "confidential",
      "explicit",
      "Imported label",
      null,
      "2026-05-24T10:02:00.000Z",
      "2026-05-24T10:07:00.000Z",
    ]);
  });

  it("inserts permission rows through object row remaps and keeps actor references non-null", async () => {
    const recording = createRecordingSql([[], [{ id: targetPermissionId }]]);
    const store = new PostgresTenantImportRowApplyStore(recording.sql);

    await expect(
      store.applyOperation({
        operation: permissionOperation({
          row: {
            resourceId: targetObjectId,
          },
          conflictPolicy: {
            rowId: "preserve",
            references: {
              resourceId: "match",
              actorId: "preserve",
              grantedByActorId: "null",
            },
            state: {},
          },
        }),
        rowIdRemaps: new Map([[objectId, targetObjectId]]),
      }),
    ).resolves.toMatchObject({
      action: "inserted",
      targetId: targetPermissionId,
    });

    expect(recording.calls).toHaveLength(2);
    expect(recording.calls[0]?.text).toContain("from permissions");
    expect(recording.calls[0]?.text).toContain("for update");
    expect(recording.calls[1]?.text).toContain("insert into permissions");
    expect(recording.calls[1]?.values).toEqual([
      permissionId,
      targetOrgId,
      actorId,
      "object",
      targetObjectId,
      "viewer",
      null,
      null,
      "2026-05-24T10:02:00.000Z",
      "2026-05-24T10:07:00.000Z",
    ]);
  });

  it("blocks permission inserts when resource or non-null actor remaps are unavailable", async () => {
    const recording = createRecordingSql([]);
    const store = new PostgresTenantImportRowApplyStore(recording.sql);

    await expect(
      store.applyOperation({
        operation: permissionOperation(),
      }),
    ).resolves.toMatchObject({
      action: "blocked",
      blockedReason: "resource_id_remap_missing",
    });

    await expect(
      store.applyOperation({
        operation: permissionOperation({
          conflictPolicy: {
            rowId: "preserve",
            references: {
              resourceId: "match",
              actorId: "null",
            },
            state: {},
          },
        }),
        rowIdRemaps: new Map([[objectId, targetObjectId]]),
      }),
    ).resolves.toMatchObject({
      action: "blocked",
      blockedReason: "actor_id_remap_missing",
    });
    expect(recording.calls).toEqual([]);
  });

  it("rejects unsupported table/kind combinations without issuing SQL", async () => {
    const recording = createRecordingSql([]);
    const store = new PostgresTenantImportRowApplyStore(recording.sql);

    await expect(
      store.applyOperation({
        operation: {
          ...operation(),
          kind: "upsert_admin_dns_record",
        },
      }),
    ).resolves.toMatchObject({
      action: "blocked",
      blockedReason: "unsupported_operation",
    });
    expect(recording.calls).toEqual([]);
  });
});

describe("applyTenantImportPlanRows", () => {
  it("applies operations in plan order and carries generated row IDs into dependent rows", async () => {
    const recording = createRecordingSql([
      [{ id: targetDomainId }],
      [],
      [{ id: targetDnsRecordId }],
    ]);
    const store = new PostgresTenantImportRowApplyStore(recording.sql);

    await expect(
      applyTenantImportPlanRows({
        store,
        plan: {
          operations: [
            dnsOperation({
              order: 2,
              conflictPolicy: {
                rowId: "preserve",
                references: { domainId: "preserve" },
                state: {
                  status: "regenerate",
                  observedValue: "regenerate",
                  lastCheckedAt: "regenerate",
                },
              },
            }),
            operation({
              order: 1,
              conflictPolicy: {
                rowId: "regenerate",
                references: { createdBy: "null" },
                state: {
                  verificationStatus: "regenerate",
                  verifiedAt: "regenerate",
                  isPrimary: "null",
                },
              },
            }),
          ],
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      summary: {
        total: 2,
        inserted: 2,
        updated: 0,
        blocked: 0,
        noop: 0,
      },
    });

    expect(recording.calls[2]?.text).toContain("insert into admin_dns_records");
    expect(recording.calls[2]?.values).toContain(targetDomainId);
  });

  it("carries restored Drive folder IDs into object metadata for Drive list visibility", async () => {
    const recording = createRecordingSql([
      [],
      [{ id: targetDriveFolderId }],
      [],
      [{ id: targetObjectId }],
      [],
      [{ id: targetPermissionId }],
    ]);
    const store = new PostgresTenantImportRowApplyStore(recording.sql);

    await expect(
      applyTenantImportPlanRows({
        store,
        plan: {
          operations: [
            objectOperation({
              order: 2,
              row: {
                metadata: { folderId: driveFolderId, name: "report.txt" },
              },
              conflictPolicy: {
                rowId: "preserve",
                references: { ownerActorId: "null", folderId: "preserve" },
                state: {},
              },
            }),
            driveFolderOperation({
              order: 1,
              conflictPolicy: {
                rowId: "regenerate",
                references: { ownerActorId: "null", createdByActorId: "null" },
                state: {},
              },
            }),
            permissionOperation({
              order: 3,
              conflictPolicy: {
                rowId: "regenerate",
                references: {
                  resourceId: "preserve",
                  actorId: "preserve",
                  grantedByActorId: "null",
                },
                state: {},
              },
            }),
          ],
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      summary: {
        total: 3,
        inserted: 3,
        blocked: 0,
      },
    });

    expect(recording.calls[3]?.text).toContain("insert into objects");
    expect(recording.calls[3]?.values).toContainEqual({
      folderId: targetDriveFolderId,
      name: "report.txt",
    });
    expect(recording.calls[5]?.text).toContain("insert into permissions");
    expect(recording.calls[5]?.values).toContain(targetObjectId);
  });
});

function operation(
  overrides: Partial<TenantImportPlanOperation> & {
    readonly row?: Partial<TenantImportPlanOperation["row"]>;
    readonly conflictPolicy?: Partial<TenantImportPlanOperation["conflictPolicy"]>;
  } = {},
): TenantImportPlanOperation {
  const base: TenantImportPlanOperation = {
    order: 1,
    kind: "upsert_admin_domain",
    table: "admin_domains",
    path: "postgres/data/chunks/admin_domains/000000.jsonl",
    line: 1,
    action: "insert",
    sourceId: domainId,
    targetId: null,
    sourceOrgId,
    targetOrgId,
    naturalKey: ["example.com"],
    dependsOn: [],
    remappedFields: {
      orgId: targetOrgId,
    },
    conflictPolicy: {
      rowId: "preserve",
      references: {
        createdBy: "preserve",
      },
      state: {
        verificationStatus: "regenerate",
        verifiedAt: "regenerate",
        isPrimary: "preserve",
      },
    },
    row: {
      id: domainId,
      orgId: targetOrgId,
      domain: "example.com",
      isPrimary: false,
      verificationStatus: "verified",
      verifiedAt: "2026-05-24T10:03:00.000Z",
      createdBy: actorId,
      createdAt: "2026-05-24T10:00:00.000Z",
      updatedAt: "2026-05-24T10:05:00.000Z",
    },
  };
  return {
    ...base,
    ...overrides,
    conflictPolicy: {
      ...base.conflictPolicy,
      ...overrides.conflictPolicy,
      references: {
        ...base.conflictPolicy.references,
        ...overrides.conflictPolicy?.references,
      },
      state: {
        ...base.conflictPolicy.state,
        ...overrides.conflictPolicy?.state,
      },
    },
    row: {
      ...base.row,
      ...overrides.row,
    },
  };
}

function dnsOperation(
  overrides: Partial<TenantImportPlanOperation> & {
    readonly row?: Partial<TenantImportPlanOperation["row"]>;
    readonly conflictPolicy?: Partial<TenantImportPlanOperation["conflictPolicy"]>;
  } = {},
): TenantImportPlanOperation {
  return operation({
    order: 2,
    kind: "upsert_admin_dns_record",
    table: "admin_dns_records",
    path: "postgres/data/chunks/admin_dns_records/000000.jsonl",
    sourceId: dnsRecordId,
    naturalKey: [domainId, "TXT", "_helix.example.com"],
    dependsOn: [`admin_domains:${domainId}`],
    ...overrides,
    conflictPolicy: {
      rowId: overrides.conflictPolicy?.rowId ?? "preserve",
      references: {
        domainId: "preserve",
        ...overrides.conflictPolicy?.references,
      },
      state: {
        status: "regenerate",
        observedValue: "regenerate",
        lastCheckedAt: "regenerate",
        ...overrides.conflictPolicy?.state,
      },
    },
    row: {
      id: dnsRecordId,
      orgId: targetOrgId,
      domainId,
      recordType: "TXT",
      host: "_helix.example.com",
      expectedValue: "helix-verification=source",
      observedValue: "helix-verification=old",
      status: "verified",
      lastCheckedAt: "2026-05-24T10:04:00.000Z",
      createdAt: "2026-05-24T10:01:00.000Z",
      updatedAt: "2026-05-24T10:06:00.000Z",
      ...overrides.row,
    },
  });
}

function resourceClassificationOperation(
  overrides: Partial<TenantImportPlanOperation> & {
    readonly row?: Partial<TenantImportPlanOperation["row"]>;
    readonly conflictPolicy?: Partial<TenantImportPlanOperation["conflictPolicy"]>;
  } = {},
): TenantImportPlanOperation {
  return operation({
    order: 3,
    kind: "upsert_resource_classification",
    table: "resource_classifications",
    path: "postgres/data/chunks/resource_classifications/000000.jsonl",
    sourceId: resourceClassificationId,
    naturalKey: ["mail.message", "msg-1"],
    ...overrides,
    conflictPolicy: {
      rowId: overrides.conflictPolicy?.rowId ?? "preserve",
      references: {
        actorId: "preserve",
        resourceId: "preserve",
        ...overrides.conflictPolicy?.references,
      },
      state: {
        ...overrides.conflictPolicy?.state,
      },
    },
    row: {
      id: resourceClassificationId,
      orgId: targetOrgId,
      resourceType: "mail.message",
      resourceId: "msg-1",
      classification: "confidential",
      source: "explicit",
      reason: "Imported label",
      actorId,
      createdAt: "2026-05-24T10:02:00.000Z",
      updatedAt: "2026-05-24T10:07:00.000Z",
      ...overrides.row,
    },
  });
}

function permissionOperation(
  overrides: Partial<TenantImportPlanOperation> & {
    readonly row?: Partial<TenantImportPlanOperation["row"]>;
    readonly conflictPolicy?: Partial<TenantImportPlanOperation["conflictPolicy"]>;
  } = {},
): TenantImportPlanOperation {
  return operation({
    order: 4,
    kind: "upsert_permission",
    table: "permissions",
    path: "postgres/data/chunks/permissions/000000.jsonl",
    sourceId: permissionId,
    naturalKey: ["object", objectId, actorId, "viewer"],
    dependsOn: [`objects:${objectId}`],
    ...overrides,
    conflictPolicy: {
      rowId: overrides.conflictPolicy?.rowId ?? "preserve",
      references: {
        resourceId: "preserve",
        actorId: "preserve",
        grantedByActorId: "preserve",
        ...overrides.conflictPolicy?.references,
      },
      state: {
        ...overrides.conflictPolicy?.state,
      },
    },
    row: {
      id: permissionId,
      orgId: targetOrgId,
      actorId,
      resourceType: "object",
      resourceId: objectId,
      role: "viewer",
      grantedByActorId: actorId,
      expiresAt: null,
      createdAt: "2026-05-24T10:02:00.000Z",
      updatedAt: "2026-05-24T10:07:00.000Z",
      ...overrides.row,
    },
  });
}

function objectOperation(
  overrides: Partial<TenantImportPlanOperation> & {
    readonly row?: Partial<TenantImportPlanOperation["row"]>;
    readonly conflictPolicy?: Partial<TenantImportPlanOperation["conflictPolicy"]>;
  } = {},
): TenantImportPlanOperation {
  return operation({
    order: 3,
    kind: "upsert_object",
    table: "objects",
    path: "postgres/data/chunks/objects/000000.jsonl",
    sourceId: objectId,
    naturalKey: ["drive/report.txt"],
    ...overrides,
    conflictPolicy: {
      rowId: overrides.conflictPolicy?.rowId ?? "preserve",
      references: {
        ownerActorId: "preserve",
        ...overrides.conflictPolicy?.references,
      },
      state: {
        ...overrides.conflictPolicy?.state,
      },
    },
    row: {
      id: objectId,
      orgId: targetOrgId,
      ownerActorId: actorId,
      kind: "file",
      storageKey: "drive/report.txt",
      mimeType: "text/plain",
      byteSize: 12,
      sha256: "a".repeat(64),
      classification: "internal",
      metadata: { name: "report.txt" },
      deletedAt: null,
      createdAt: "2026-05-24T10:02:00.000Z",
      updatedAt: "2026-05-24T10:07:00.000Z",
      ...overrides.row,
    },
  });
}

function driveFolderOperation(
  overrides: Partial<TenantImportPlanOperation> & {
    readonly row?: Partial<TenantImportPlanOperation["row"]>;
    readonly conflictPolicy?: Partial<TenantImportPlanOperation["conflictPolicy"]>;
  } = {},
): TenantImportPlanOperation {
  return operation({
    order: 3,
    kind: "upsert_drive_folder",
    table: "drive_folders",
    path: "postgres/data/chunks/drive_folders/000000.jsonl",
    sourceId: driveFolderId,
    naturalKey: ["", "Projects"],
    ...overrides,
    conflictPolicy: {
      rowId: overrides.conflictPolicy?.rowId ?? "preserve",
      references: {
        ownerActorId: "preserve",
        createdByActorId: "preserve",
        ...overrides.conflictPolicy?.references,
      },
      state: {
        ...overrides.conflictPolicy?.state,
      },
    },
    row: {
      id: driveFolderId,
      orgId: targetOrgId,
      name: "Projects",
      parentFolderId: null,
      ownerActorId: actorId,
      createdByActorId: actorId,
      metadata: { color: "blue" },
      deletedAt: null,
      createdAt: "2026-05-24T10:02:00.000Z",
      updatedAt: "2026-05-24T10:07:00.000Z",
      ...overrides.row,
    },
  });
}

function driveVersionOperation(
  overrides: Partial<TenantImportPlanOperation> & {
    readonly row?: Partial<TenantImportPlanOperation["row"]>;
    readonly conflictPolicy?: Partial<TenantImportPlanOperation["conflictPolicy"]>;
  } = {},
): TenantImportPlanOperation {
  return operation({
    order: 4,
    kind: "upsert_drive_version",
    table: "drive_versions",
    path: "postgres/data/chunks/drive_versions/000000.jsonl",
    sourceId: driveVersionId,
    naturalKey: [objectId, "1"],
    dependsOn: [`objects:${objectId}`],
    ...overrides,
    conflictPolicy: {
      rowId: overrides.conflictPolicy?.rowId ?? "preserve",
      references: {
        objectId: "preserve",
        createdByActorId: "preserve",
        ...overrides.conflictPolicy?.references,
      },
      state: {
        ...overrides.conflictPolicy?.state,
      },
    },
    row: {
      id: driveVersionId,
      orgId: targetOrgId,
      objectId,
      versionNumber: 1,
      storageKey: "drive/report.txt",
      mimeType: "text/plain",
      byteSize: 12,
      sha256: "a".repeat(64),
      metadata: { preview: "ready" },
      createdByActorId: actorId,
      createdAt: "2026-05-24T10:08:00.000Z",
      ...overrides.row,
    },
  });
}

function createRecordingSql(results: readonly unknown[][]): {
  readonly sql: postgres.Sql;
  readonly calls: readonly { readonly text: string; readonly values: readonly unknown[] }[];
} {
  const calls: { readonly text: string; readonly values: readonly unknown[] }[] = [];
  let index = 0;
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("?"), values });
    const result = results[index] ?? [];
    index += 1;
    return Promise.resolve(result);
  }) as unknown as postgres.Sql;
  (sql as unknown as { json: (value: unknown) => unknown }).json = (value) => value;
  return { sql, calls };
}
