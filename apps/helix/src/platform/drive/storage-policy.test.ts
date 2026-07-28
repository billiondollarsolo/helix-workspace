import { describe, expect, it } from "vitest";
import { assertDriveStorageEncryption } from "./storage-policy.js";

describe("Drive storage encryption policy", () => {
  it("accepts matching SSE-S3 and tenant KMS evidence", () => {
    expect(() => {
      assertDriveStorageEncryption(
        { mode: "AES256" },
        {
          byteSize: 1,
          serverSideEncryption: "AES256",
          serverSideEncryptionAwsKmsKeyId: null,
        },
      );
    }).not.toThrow();
    expect(() => {
      assertDriveStorageEncryption(
        { mode: "aws:kms", kmsKeyId: "kms-tenant-a" },
        {
          byteSize: 1,
          serverSideEncryption: "aws:kms",
          serverSideEncryptionAwsKmsKeyId: "kms-tenant-a",
        },
      );
    }).not.toThrow();
  });

  it("rejects missing encryption and cross-tenant KMS evidence", () => {
    expect(() => {
      assertDriveStorageEncryption({ mode: "AES256" }, null);
    }).toThrow(/no post-finalize/u);
    expect(() => {
      assertDriveStorageEncryption(
        { mode: "aws:kms", kmsKeyId: "kms-tenant-a" },
        {
          byteSize: 1,
          serverSideEncryption: "aws:kms",
          serverSideEncryptionAwsKmsKeyId: "kms-tenant-b",
        },
      );
    }).toThrow(/tenant policy/u);
  });
});
