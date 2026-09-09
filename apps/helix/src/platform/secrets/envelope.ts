import { getCryptoProvider, type CryptoProvider } from "../crypto/index.js";

const prefix = "helix$1$";
const purposePattern = /^[a-z][a-z0-9.-]{0,63}$/u;

/** AES-256-GCM envelope encryption with a distinct KEK for each tenant and purpose. */
export class TenantEnvelopeCipher {
  constructor(
    private readonly masterSecret: string,
    private readonly crypto: CryptoProvider = getCryptoProvider(),
  ) {
    if (Buffer.byteLength(masterSecret) < 32) {
      throw new Error("Tenant envelope master secret must be at least 32 bytes.");
    }
  }

  seal(orgId: string, purpose: string, plaintext: string): string {
    const aad = envelopeAad(orgId, purpose);
    const kek = this.tenantKey(orgId, purpose);
    const dek = this.crypto.randomBytes(32);
    const wrapIv = this.crypto.randomBytes(12);
    const dataIv = this.crypto.randomBytes(12);
    try {
      const wrapped = this.crypto.aes256GcmEncrypt({
        key: kek,
        iv: wrapIv,
        plaintext: dek,
        aad,
      });
      const encrypted = this.crypto.aes256GcmEncrypt({
        key: dek,
        iv: dataIv,
        plaintext,
        aad,
      });
      return `${prefix}${[
        wrapped.ciphertext,
        wrapped.tag,
        encrypted.ciphertext,
        encrypted.tag,
        wrapIv,
        dataIv,
      ]
        .map((part) => part.toString("base64url"))
        .join("$")}`;
    } finally {
      dek.fill(0);
      kek.fill(0);
    }
  }

  open(orgId: string, purpose: string, envelope: string): string {
    const fields = envelope.startsWith(prefix) ? envelope.slice(prefix.length).split("$") : [];
    if (fields.length !== 6 || fields.some((field) => !/^[A-Za-z0-9_-]+$/u.test(field))) {
      throw new Error("Invalid encrypted secret envelope.");
    }
    const [wrappedData, wrappedTag, data, dataTag, wrapIv, dataIv] = fields.map((field) =>
      Buffer.from(field, "base64url"),
    ) as [Buffer, Buffer, Buffer, Buffer, Buffer, Buffer];
    const aad = envelopeAad(orgId, purpose);
    const kek = this.tenantKey(orgId, purpose);
    let dek: Buffer | undefined;
    try {
      dek = this.crypto.aes256GcmDecrypt({
        key: kek,
        iv: wrapIv,
        ciphertext: wrappedData,
        tag: wrappedTag,
        aad,
      });
      return this.crypto
        .aes256GcmDecrypt({ key: dek, iv: dataIv, ciphertext: data, tag: dataTag, aad })
        .toString("utf8");
    } catch {
      throw new Error("Encrypted secret cannot be decrypted for this tenant and purpose.");
    } finally {
      dek?.fill(0);
      kek.fill(0);
    }
  }

  private tenantKey(orgId: string, purpose: string): Buffer {
    assertEnvelopeContext(orgId, purpose);
    return this.crypto.hkdf({
      digest: "sha256",
      ikm: this.masterSecret,
      salt: "helix-tenant-envelope-v1",
      info: `${orgId}\0${purpose}`,
      keyLength: 32,
    });
  }
}

function envelopeAad(orgId: string, purpose: string): Buffer {
  assertEnvelopeContext(orgId, purpose);
  return Buffer.from(`helix$1$${orgId}\0${purpose}`, "utf8");
}

function assertEnvelopeContext(orgId: string, purpose: string): void {
  if (orgId.trim().length === 0 || !purposePattern.test(purpose)) {
    throw new Error("Encrypted secret tenant and purpose are required.");
  }
}

export function isTenantSecretEnvelope(value: string): boolean {
  return value.startsWith(prefix);
}
