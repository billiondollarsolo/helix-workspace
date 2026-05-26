import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { loadTenantImportTargetStateFromPostgres } from "./import-target-state.js";

const targetOrgId = "33333333-3333-4333-8333-333333333333";
const targetDomainId = "77777777-7777-4777-8777-777777777777";
const targetDnsRecordId = "88888888-8888-4888-8888-888888888888";
const targetResourceClassificationId = "99999999-9999-4999-8999-999999999999";
const targetObjectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const targetDriveVersionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("loadTenantImportTargetStateFromPostgres", () => {
  it("loads deterministic target facts for import dry-run conflict and remap planning", async () => {
    const recording = createRecordingSql([
      [
        {
          id: targetDomainId,
          domain: "Example.COM",
          is_primary: true,
        },
      ],
      [
        {
          id: targetDnsRecordId,
          domain_id: targetDomainId,
          record_type: "TXT",
          host: "_helix.example.com",
        },
      ],
      [
        {
          id: targetObjectId,
          storage_key: "drive/report.txt",
        },
      ],
      [
        {
          id: targetDriveVersionId,
          object_id: targetObjectId,
          version_number: 1,
        },
      ],
      [
        {
          id: targetResourceClassificationId,
          resource_type: "mail.message",
          resource_id: "target-msg-1",
        },
      ],
    ]);

    await expect(
      loadTenantImportTargetStateFromPostgres({
        sql: recording.sql,
        targetOrgId,
      }),
    ).resolves.toEqual({
      existingRowIds: [
        {
          table: "admin_domains",
          id: targetDomainId,
          targetId: targetDomainId,
        },
        {
          table: "admin_dns_records",
          id: targetDnsRecordId,
          targetId: targetDnsRecordId,
        },
        {
          table: "objects",
          id: targetObjectId,
          targetId: targetObjectId,
        },
        {
          table: "drive_versions",
          id: targetDriveVersionId,
          targetId: targetDriveVersionId,
        },
        {
          table: "resource_classifications",
          id: targetResourceClassificationId,
          targetId: targetResourceClassificationId,
        },
      ],
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
          table: "objects",
          naturalKey: ["drive/report.txt"],
          targetId: targetObjectId,
        },
        {
          table: "drive_versions",
          naturalKey: [targetObjectId, "1"],
          targetId: targetDriveVersionId,
        },
        {
          table: "resource_classifications",
          naturalKey: ["mail.message", "target-msg-1"],
          targetId: targetResourceClassificationId,
        },
      ],
      primaryDomain: "example.com",
    });
    expect(recording.calls).toHaveLength(5);
    expect(recording.calls[0]?.text).toContain("from admin_domains");
    expect(recording.calls[0]?.text).toContain("where org_id = ?");
    expect(recording.calls[0]?.text).toContain(
      "order by is_primary desc, lower(domain) asc, id asc",
    );
    expect(recording.calls[1]?.text).toContain("from admin_dns_records");
    expect(recording.calls[1]?.text).toContain("where org_id = ?");
    expect(recording.calls[1]?.text).toContain(
      "order by domain_id asc, record_type asc, host asc, id asc",
    );
    expect(recording.calls[2]?.text).toContain("from objects");
    expect(recording.calls[2]?.text).toContain("where org_id = ?");
    expect(recording.calls[2]?.text).toContain("order by storage_key asc, id asc");
    expect(recording.calls[3]?.text).toContain("from drive_versions");
    expect(recording.calls[3]?.text).toContain("where org_id = ?");
    expect(recording.calls[3]?.text).toContain(
      "order by object_id asc, version_number asc, id asc",
    );
    expect(recording.calls[4]?.text).toContain("from resource_classifications");
    expect(recording.calls[4]?.text).toContain("where org_id = ?");
    expect(recording.calls[4]?.text).toContain(
      "order by resource_type asc, resource_id asc, id asc",
    );
    expect(recording.calls.flatMap((call) => call.values)).toEqual([
      targetOrgId,
      targetOrgId,
      targetOrgId,
      targetOrgId,
      targetOrgId,
    ]);
    const combinedSql = recording.calls.map((call) => call.text).join("\n");
    expect(combinedSql).not.toContain("select *");
    expect(combinedSql).not.toContain("payload");
    expect(combinedSql).not.toContain("body");
    expect(combinedSql).not.toContain("hash");
    expect(combinedSql).not.toContain("secret");
    expect(combinedSql).not.toContain("token");
  });

  it("returns empty target facts when the target tenant has no import-relevant rows", async () => {
    const recording = createRecordingSql([[], [], [], [], []]);

    await expect(
      loadTenantImportTargetStateFromPostgres({
        sql: recording.sql,
        targetOrgId,
      }),
    ).resolves.toEqual({
      existingRowIds: [],
      existingNaturalKeys: [],
      primaryDomain: null,
    });
  });
});

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
  return { sql, calls };
}
