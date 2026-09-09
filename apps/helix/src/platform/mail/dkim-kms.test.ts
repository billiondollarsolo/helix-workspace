import { DecryptCommand, EncryptCommand } from "@aws-sdk/client-kms";
import { describe, expect, it, vi } from "vitest";
import { KmsDkimPrivateKeyProtector } from "./dkim-kms.js";

describe("KmsDkimPrivateKeyProtector", () => {
  it("binds encryption and decryption to the tenant and domain context", async () => {
    const send = vi.fn(async (command: EncryptCommand | DecryptCommand) => {
      if (command instanceof EncryptCommand) {
        return { CiphertextBlob: Buffer.from("wrapped"), KeyId: "kms-key-arn" };
      }
      return { Plaintext: Buffer.from("private-pem") };
    });
    const protector = new KmsDkimPrivateKeyProtector({ send }, "alias/tenant-dkim");

    const protectedKey = await protector.protect({
      orgId: "org-1",
      domainId: "domain-1",
      privateKeyPem: "private-pem",
    });
    expect(protectedKey).toEqual({
      ciphertext: Buffer.from("wrapped").toString("base64"),
      kmsKeyId: "kms-key-arn",
    });
    const encrypt = send.mock.calls[0]?.[0];
    expect(encrypt).toBeInstanceOf(EncryptCommand);
    expect(encrypt?.input).toMatchObject({
      KeyId: "alias/tenant-dkim",
      EncryptionContext: {
        "helix:purpose": "mail-dkim",
        "helix:org-id": "org-1",
        "helix:domain-id": "domain-1",
      },
    });

    await expect(
      protector.open({
        orgId: "org-1",
        domainId: "domain-1",
        ciphertext: protectedKey.ciphertext,
        kmsKeyId: protectedKey.kmsKeyId,
      }),
    ).resolves.toBe("private-pem");
    const decrypt = send.mock.calls[1]?.[0];
    expect(decrypt).toBeInstanceOf(DecryptCommand);
    expect(decrypt?.input).toMatchObject({
      KeyId: "kms-key-arn",
      EncryptionContext: {
        "helix:purpose": "mail-dkim",
        "helix:org-id": "org-1",
        "helix:domain-id": "domain-1",
      },
    });
  });

  it("fails closed without a configured tenant key", async () => {
    const protector = new KmsDkimPrivateKeyProtector({
      send: vi.fn(),
    });
    await expect(
      protector.protect({ orgId: "org-1", domainId: "domain-1", privateKeyPem: "pem" }),
    ).rejects.toThrow(/MAIL_DKIM_KMS_KEY_ID/u);
  });
});
