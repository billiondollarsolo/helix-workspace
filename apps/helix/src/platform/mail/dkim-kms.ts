import { DecryptCommand, EncryptCommand, type KMSClient } from "@aws-sdk/client-kms";

const PURPOSE = "mail-dkim";

export interface ProtectedDkimPrivateKey {
  readonly ciphertext: string;
  readonly kmsKeyId: string;
}

/**
 * Keeps DKIM private keys outside database backups by wrapping them with a
 * tenant-owned KMS/HSM key. The encryption context prevents ciphertext from
 * being replayed across tenants or sending domains.
 */
export class KmsDkimPrivateKeyProtector {
  constructor(
    private readonly kms: Pick<KMSClient, "send">,
    private readonly defaultKeyId?: string,
  ) {}

  async protect(input: {
    readonly orgId: string;
    readonly domainId: string;
    readonly privateKeyPem: string;
    readonly kmsKeyId?: string;
  }): Promise<ProtectedDkimPrivateKey> {
    const keyId = input.kmsKeyId ?? this.defaultKeyId;
    if (keyId === undefined || keyId.trim() === "") {
      throw new TypeError("A tenant-owned MAIL_DKIM_KMS_KEY_ID is required.");
    }
    const result = await this.kms.send(
      new EncryptCommand({
        KeyId: keyId,
        Plaintext: Buffer.from(input.privateKeyPem, "utf8"),
        EncryptionContext: encryptionContext(input.orgId, input.domainId),
      }),
    );
    if (result.CiphertextBlob === undefined || result.KeyId === undefined) {
      throw new Error("KMS did not return encrypted DKIM key material.");
    }
    return {
      ciphertext: Buffer.from(result.CiphertextBlob).toString("base64"),
      kmsKeyId: result.KeyId,
    };
  }

  async open(input: {
    readonly orgId: string;
    readonly domainId: string;
    readonly ciphertext: string;
    readonly kmsKeyId: string;
  }): Promise<string> {
    const result = await this.kms.send(
      new DecryptCommand({
        KeyId: input.kmsKeyId,
        CiphertextBlob: Buffer.from(input.ciphertext, "base64"),
        EncryptionContext: encryptionContext(input.orgId, input.domainId),
      }),
    );
    if (result.Plaintext === undefined) {
      throw new Error("KMS did not return DKIM key material.");
    }
    return Buffer.from(result.Plaintext).toString("utf8");
  }
}

function encryptionContext(orgId: string, domainId: string): Record<string, string> {
  return {
    "helix:purpose": PURPOSE,
    "helix:org-id": orgId,
    "helix:domain-id": domainId,
  };
}
