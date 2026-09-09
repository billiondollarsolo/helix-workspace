import { describe, expect, it } from "vitest";
import { TenantEnvelopeCipher, isTenantSecretEnvelope } from "./envelope.js";

const cipher = new TenantEnvelopeCipher("test-master-secret-with-at-least-thirty-two-bytes");

describe("TenantEnvelopeCipher", () => {
  it("round-trips without exposing plaintext and binds tenant, purpose, and authentication tag", () => {
    const envelope = cipher.seal("org-a", "webhook", "directly-usable-secret");
    expect(isTenantSecretEnvelope(envelope)).toBe(true);
    expect(envelope).not.toContain("directly-usable-secret");
    expect(cipher.open("org-a", "webhook", envelope)).toBe("directly-usable-secret");
    expect(() => cipher.open("org-b", "webhook", envelope)).toThrow(/cannot be decrypted/u);
    expect(() => cipher.open("org-a", "dkim", envelope)).toThrow(/cannot be decrypted/u);
    expect(() => cipher.open("org-a", "webhook", `${envelope.slice(0, -1)}A`)).toThrow(
      /cannot be decrypted/u,
    );
  });
});
