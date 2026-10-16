import { describe, expect, it, vi } from "vitest";
import type { DecryptCommand, EncryptCommand } from "@aws-sdk/client-kms";
import { createRecordingSql } from "../../test-support/recording-sql.js";
import { PostgresMailDkimKeyStore } from "./admin-store.js";
import { KmsDkimPrivateKeyProtector } from "./dkim-kms.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const domainId = "22222222-2222-4222-8222-222222222222";
const missingKey = {
  domain_name: "example.com",
  domain_id: domainId,
  selector: null,
  private_key_ciphertext: null,
  kms_key_id: null,
};

describe("outbound DKIM key resolution", () => {
  it("requires a tenant key when the transport does not provide signing", async () => {
    const sql = createRecordingSql([[missingKey]]);
    const send = vi.fn();
    const store = new PostgresMailDkimKeyStore(sql.sql, new KmsDkimPrivateKeyProtector({ send }));
    await expect(store.resolveSigningKey(orgId, "alice@example.com")).rejects.toThrow(
      "has no active DKIM key",
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("allows provider signing without asking KMS for a missing tenant key", async () => {
    const sql = createRecordingSql([[missingKey]]);
    const send = vi.fn();
    const store = new PostgresMailDkimKeyStore(sql.sql, new KmsDkimPrivateKeyProtector({ send }));
    await expect(store.resolveSigningKey(orgId, "alice@example.com", false)).resolves.toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it("preserves an active tenant signature alongside provider signing", async () => {
    const sql = createRecordingSql([
      [
        {
          ...missingKey,
          selector: "tenant-key",
          private_key_ciphertext: Buffer.from("wrapped").toString("base64"),
          kms_key_id: "tenant-kms-key",
        },
      ],
    ]);
    const send = vi.fn(async (_command: EncryptCommand | DecryptCommand) => ({
      Plaintext: Buffer.from("private-pem"),
    }));
    const store = new PostgresMailDkimKeyStore(sql.sql, new KmsDkimPrivateKeyProtector({ send }));
    await expect(store.resolveSigningKey(orgId, "alice@example.com", false)).resolves.toEqual({
      domainName: "example.com",
      keySelector: "tenant-key",
      privateKey: "private-pem",
    });
    expect(send.mock.calls[0]?.[0].input).toMatchObject({
      KeyId: "tenant-kms-key",
      EncryptionContext: { "helix:org-id": orgId, "helix:domain-id": domainId },
    });
  });
});
