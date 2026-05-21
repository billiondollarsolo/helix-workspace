import { describe, expect, it } from "vitest";
import {
  authenticateApiKey,
  authenticateMtlsCertificate,
  createApiKeyMaterial,
  enforceCredentialPolicy,
  hashApiKey,
  ipMatchesAllowlist,
  ipMatchesCidr,
  isApiKey,
  isWithinAllowedHours,
  normalizeCertFingerprint,
  type AgentCredentialPolicy,
  type AgentCredentialRecord,
  type AgentCredentialStore,
  EMPTY_CREDENTIAL_POLICY,
} from "./credentials.js";

function credential(
  overrides: Omit<Partial<AgentCredentialRecord>, "policy"> & {
    readonly policy?: Partial<AgentCredentialPolicy>;
  },
): AgentCredentialRecord {
  const { policy, ...rest } = overrides;
  return {
    id: "cred-1",
    credentialType: "api_key",
    actorId: "actor-1",
    orgId: "org-1",
    scopes: ["mail.read"],
    clientId: null,
    secretHash: null,
    apiKeyHash: null,
    certFingerprint: null,
    label: null,
    expiresAt: null,
    revokedAt: null,
    ...rest,
    policy: { ...EMPTY_CREDENTIAL_POLICY, ...policy },
  };
}

class FakeCredentialStore implements AgentCredentialStore {
  readonly #byApiKey = new Map<string, AgentCredentialRecord>();
  readonly #byCert = new Map<string, AgentCredentialRecord>();

  addApiKey(hash: string, record: AgentCredentialRecord): void {
    this.#byApiKey.set(hash, record);
  }

  addCert(fingerprint: string, record: AgentCredentialRecord): void {
    this.#byCert.set(fingerprint, record);
  }

  async findByApiKeyHash(hash: string): Promise<AgentCredentialRecord | null> {
    return this.#byApiKey.get(hash) ?? null;
  }

  async findByCertFingerprint(fingerprint: string): Promise<AgentCredentialRecord | null> {
    return this.#byCert.get(fingerprint) ?? null;
  }
}

describe("API key material", () => {
  it("generates a recognisable key whose hash is stable", () => {
    const { apiKey, apiKeyHash } = createApiKeyMaterial();
    expect(isApiKey(apiKey)).toBe(true);
    expect(apiKeyHash).toBe(hashApiKey(apiKey));
    expect(apiKeyHash).not.toBe(apiKey);
  });

  it("does not recognise non-Helix keys", () => {
    expect(isApiKey("bearer-token")).toBe(false);
  });
});

describe("certificate fingerprint normalization", () => {
  it("normalizes colon-separated, prefixed and upper-case fingerprints equally", () => {
    expect(normalizeCertFingerprint("AA:BB:CC")).toBe("aabbcc");
    expect(normalizeCertFingerprint("sha256:AaBbCc")).toBe("aabbcc");
    expect(normalizeCertFingerprint("aabbcc")).toBe("aabbcc");
  });
});

describe("IP allowlist matching", () => {
  it("matches plain IPv4 and IPv4 CIDR", () => {
    expect(ipMatchesCidr("10.1.2.3", "10.1.2.3")).toBe(true);
    expect(ipMatchesCidr("10.1.2.3", "10.0.0.0/8")).toBe(true);
    expect(ipMatchesCidr("11.1.2.3", "10.0.0.0/8")).toBe(false);
  });

  it("matches IPv6 CIDR", () => {
    expect(ipMatchesCidr("2001:db8::1", "2001:db8::/32")).toBe(true);
    expect(ipMatchesCidr("2001:dead::1", "2001:db8::/32")).toBe(false);
  });

  it("matches any entry of an allowlist", () => {
    expect(ipMatchesAllowlist("192.168.1.5", ["10.0.0.0/8", "192.168.0.0/16"])).toBe(true);
    expect(ipMatchesAllowlist("8.8.8.8", ["10.0.0.0/8", "192.168.0.0/16"])).toBe(false);
  });
});

describe("allowed-hours window", () => {
  it("matches a same-day window", () => {
    const window = { startHour: 9, endHour: 17 };
    expect(isWithinAllowedHours(window, new Date("2026-05-21T10:00:00Z"))).toBe(true);
    expect(isWithinAllowedHours(window, new Date("2026-05-21T18:00:00Z"))).toBe(false);
  });

  it("matches a window that wraps past midnight", () => {
    const window = { startHour: 22, endHour: 6 };
    expect(isWithinAllowedHours(window, new Date("2026-05-21T23:00:00Z"))).toBe(true);
    expect(isWithinAllowedHours(window, new Date("2026-05-21T03:00:00Z"))).toBe(true);
    expect(isWithinAllowedHours(window, new Date("2026-05-21T12:00:00Z"))).toBe(false);
  });

  it("respects day-of-week restrictions", () => {
    // 2026-05-21 is a Thursday (day 4).
    const window = { startHour: 0, endHour: 23, days: [1, 2, 3, 4, 5] };
    expect(isWithinAllowedHours(window, new Date("2026-05-21T10:00:00Z"))).toBe(true);
    // 2026-05-23 is a Saturday (day 6).
    expect(isWithinAllowedHours(window, new Date("2026-05-23T10:00:00Z"))).toBe(false);
  });
});

describe("enforceCredentialPolicy", () => {
  const at = new Date("2026-05-21T10:00:00Z");

  it("allows a credential with no policy restrictions", () => {
    expect(enforceCredentialPolicy(credential({}), { ip: "8.8.8.8", at })).toEqual({ ok: true });
  });

  it("rejects a revoked credential", () => {
    const result = enforceCredentialPolicy(credential({ revokedAt: at }), { at });
    expect(result).toMatchObject({ ok: false, code: "credential_revoked" });
  });

  it("rejects an expired credential", () => {
    const result = enforceCredentialPolicy(
      credential({ expiresAt: new Date("2026-05-20T00:00:00Z") }),
      { at },
    );
    expect(result).toMatchObject({ ok: false, code: "credential_expired" });
  });

  it("rejects an IP outside the allowlist", () => {
    const cred = credential({ policy: { ipAllowlist: ["10.0.0.0/8"] } });
    expect(enforceCredentialPolicy(cred, { ip: "10.1.2.3", at })).toEqual({ ok: true });
    expect(enforceCredentialPolicy(cred, { ip: "8.8.8.8", at })).toMatchObject({
      ok: false,
      code: "ip_not_allowed",
    });
    expect(enforceCredentialPolicy(cred, { at })).toMatchObject({
      ok: false,
      code: "ip_not_allowed",
    });
  });

  it("rejects a request outside the allowed-hours window", () => {
    const cred = credential({ policy: { allowedHours: { startHour: 9, endHour: 17 } } });
    expect(enforceCredentialPolicy(cred, { at })).toEqual({ ok: true });
    expect(
      enforceCredentialPolicy(cred, { at: new Date("2026-05-21T20:00:00Z") }),
    ).toMatchObject({ ok: false, code: "outside_allowed_hours" });
  });

  it("rejects an mTLS credential when the presented fingerprint mismatches", () => {
    const cred = credential({ credentialType: "mtls_cert", certFingerprint: "aabbcc" });
    expect(
      enforceCredentialPolicy(cred, { certFingerprint: "AA:BB:CC", at }),
    ).toEqual({ ok: true });
    expect(
      enforceCredentialPolicy(cred, { certFingerprint: "deadbeef", at }),
    ).toMatchObject({ ok: false, code: "cert_fingerprint_mismatch" });
    expect(enforceCredentialPolicy(cred, { at })).toMatchObject({
      ok: false,
      code: "cert_fingerprint_mismatch",
    });
  });
});

describe("authenticateApiKey", () => {
  it("authenticates a valid API key and enforces policy", async () => {
    const store = new FakeCredentialStore();
    const { apiKey, apiKeyHash } = createApiKeyMaterial();
    store.addApiKey(
      apiKeyHash,
      credential({ apiKeyHash, policy: { ipAllowlist: ["10.0.0.0/8"] } }),
    );

    await expect(
      authenticateApiKey(store, apiKey, { ip: "10.1.1.1" }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      authenticateApiKey(store, apiKey, { ip: "8.8.8.8" }),
    ).resolves.toMatchObject({ ok: false, code: "ip_not_allowed" });
  });

  it("rejects an unknown API key", async () => {
    const store = new FakeCredentialStore();
    const { apiKey } = createApiKeyMaterial();
    await expect(authenticateApiKey(store, apiKey, {})).resolves.toMatchObject({
      ok: false,
      code: "invalid_api_key",
    });
  });
});

describe("authenticateMtlsCertificate", () => {
  it("authenticates a registered certificate fingerprint", async () => {
    const store = new FakeCredentialStore();
    store.addCert(
      "aabbcc",
      credential({ credentialType: "mtls_cert", certFingerprint: "aabbcc" }),
    );
    await expect(
      authenticateMtlsCertificate(store, "AA:BB:CC", {}),
    ).resolves.toMatchObject({ ok: true });
  });

  it("rejects an unregistered certificate", async () => {
    const store = new FakeCredentialStore();
    await expect(
      authenticateMtlsCertificate(store, "deadbeef", {}),
    ).resolves.toMatchObject({ ok: false, code: "invalid_certificate" });
  });

  it("rejects when no certificate is presented", async () => {
    const store = new FakeCredentialStore();
    await expect(authenticateMtlsCertificate(store, "", {})).resolves.toMatchObject({
      ok: false,
      code: "invalid_certificate",
    });
  });
});
