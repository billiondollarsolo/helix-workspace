import { describe, expect, it } from "vitest";
import {
  provisionAuditBucket,
  provisionPlatformBucket,
  type BucketProvisionClient,
} from "./provision-bucket.js";

interface FakeBucket {
  exists: boolean;
  lockEnabled: boolean;
  retention?: { Mode: string; Days: number };
}

function fakeClient(bucket: FakeBucket): BucketProvisionClient & { readonly sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    send(command: object) {
      const name = command.constructor.name;
      const input = (command as { input: Record<string, unknown> }).input;
      sent.push(name);
      switch (name) {
        case "HeadBucketCommand":
          if (!bucket.exists) {
            return Promise.reject(Object.assign(new Error("missing"), { name: "NotFound" }));
          }
          return Promise.resolve({});
        case "CreateBucketCommand":
          bucket.exists = true;
          bucket.lockEnabled = input.ObjectLockEnabledForBucket === true;
          return Promise.resolve({});
        case "GetObjectLockConfigurationCommand":
          if (!bucket.lockEnabled) {
            return Promise.reject(
              Object.assign(new Error("no lock"), { name: "ObjectLockConfigurationNotFoundError" }),
            );
          }
          return Promise.resolve({
            ObjectLockConfiguration: {
              ObjectLockEnabled: "Enabled",
              ...(bucket.retention === undefined
                ? {}
                : { Rule: { DefaultRetention: bucket.retention } }),
            },
          });
        case "PutObjectLockConfigurationCommand": {
          const rule = (
            input.ObjectLockConfiguration as { Rule: { DefaultRetention: FakeBucket["retention"] } }
          ).Rule.DefaultRetention;
          if (rule !== undefined) bucket.retention = rule;
          return Promise.resolve({});
        }
        default:
          return Promise.resolve({});
      }
    },
  };
}

const policy = {
  bucket: "helix-objects",
  kmsKeyId: "helix-default",
  objectLockMode: "GOVERNANCE",
  retentionDays: 30,
} as const;

describe("provisionPlatformBucket", () => {
  it("creates a missing bucket with object lock, versioning, SSE-KMS and retention", async () => {
    const bucket: FakeBucket = { exists: false, lockEnabled: false };
    const client = fakeClient(bucket);
    await expect(provisionPlatformBucket(client, policy)).resolves.toEqual({
      created: true,
      retentionDays: 30,
    });
    expect(client.sent).toEqual([
      "HeadBucketCommand",
      "CreateBucketCommand",
      "PutBucketVersioningCommand",
      "PutBucketEncryptionCommand",
      "GetObjectLockConfigurationCommand",
      "PutObjectLockConfigurationCommand",
    ]);
    expect(bucket).toMatchObject({
      lockEnabled: true,
      retention: { Mode: "GOVERNANCE", Days: 30 },
    });
  });

  it("is idempotent and never lowers a longer retention", async () => {
    const bucket: FakeBucket = {
      exists: true,
      lockEnabled: true,
      retention: { Mode: "GOVERNANCE", Days: 90 },
    };
    const client = fakeClient(bucket);
    await expect(provisionPlatformBucket(client, policy)).resolves.toEqual({
      created: false,
      retentionDays: 90,
    });
    expect(client.sent).not.toContain("PutObjectLockConfigurationCommand");
    expect(bucket.retention).toEqual({ Mode: "GOVERNANCE", Days: 90 });
  });

  it("raises a shorter retention and refuses to weaken COMPLIANCE", async () => {
    const shorter: FakeBucket = {
      exists: true,
      lockEnabled: true,
      retention: { Mode: "GOVERNANCE", Days: 7 },
    };
    await provisionPlatformBucket(fakeClient(shorter), policy);
    expect(shorter.retention).toEqual({ Mode: "GOVERNANCE", Days: 30 });

    const compliance: FakeBucket = {
      exists: true,
      lockEnabled: true,
      retention: { Mode: "COMPLIANCE", Days: 30 },
    };
    await expect(provisionPlatformBucket(fakeClient(compliance), policy)).rejects.toThrow(
      "RUSTFS_OBJECT_LOCK_MODE=COMPLIANCE",
    );
  });

  it("explains that an existing bucket without object lock cannot be fixed in place", async () => {
    const bucket: FakeBucket = { exists: true, lockEnabled: false };
    await expect(provisionPlatformBucket(fakeClient(bucket), policy)).rejects.toThrow(
      "cannot be enabled after creation",
    );
  });
});

describe("provisionAuditBucket", () => {
  it("creates the audit bucket with object lock and the SSE-KMS default, without a default retention", async () => {
    const bucket: FakeBucket = { exists: false, lockEnabled: false };
    const client = fakeClient(bucket);
    await expect(
      provisionAuditBucket(client, { bucket: "helix-audit", kmsKeyId: "helix-default" }),
    ).resolves.toEqual({ created: true });
    expect(client.sent).toContain("PutBucketEncryptionCommand");
    expect(client.sent).not.toContain("PutObjectLockConfigurationCommand");
    expect(bucket.lockEnabled).toBe(true);
  });

  it("refuses an existing audit bucket that has no object lock", async () => {
    await expect(
      provisionAuditBucket(fakeClient({ exists: true, lockEnabled: false }), {
        bucket: "helix-audit",
        kmsKeyId: "helix-default",
      }),
    ).rejects.toThrow("without object lock");
  });
});
