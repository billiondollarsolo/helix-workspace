/**
 * Byte-identical equivalence proof for the FIPS-optional crypto routing
 * (PRD §14.4, P2-9 Tier-4).
 *
 * The Tier-4 work routed three crypto call-sites through the {@link
 * CryptoProvider} adapter — the audit hash chain, the webhook HMAC, and auth
 * token hashing / secret minting. The hard requirement: when FIPS is OFF (the
 * default) those routed call-sites must produce output BYTE-IDENTICAL to the
 * pre-adapter, direct-`node:crypto` implementation, and no FIPS code path may
 * run.
 *
 * These tests pin that guarantee. They compare the live routed functions
 * against an inline reproduction of the original direct-`node:crypto` form.
 */

import { createHash, createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computeAuditHash, type HashableAuditRecord } from "../audit/hash.js";
import { hashAccessToken } from "../auth/postgres-store.js";
import { signWebhookPayload, verifyWebhookSignature } from "../webhooks/signatures.js";
import { FipsCryptoProvider } from "./fips-provider.js";
import { getCryptoProvider, setCryptoProviderForTesting } from "./index.js";
import { NodeCryptoProvider } from "./node-provider.js";

afterEach(() => {
  setCryptoProviderForTesting(undefined);
  vi.restoreAllMocks();
});

describe("default provider is the non-FIPS Node provider", () => {
  it("getCryptoProvider() returns the Node provider with no FIPS env", () => {
    // The vitest process sets no HELIX_FIPS_* variables, so the opt-in default
    // (non-FIPS) must apply with zero configuration.
    expect(getCryptoProvider().id).toBe("node");
    expect(getCryptoProvider().status().fipsEnforced).toBe(false);
  });
});

describe("audit hash chain — byte-identical with FIPS off", () => {
  const record: HashableAuditRecord = {
    actorId: "actor-1",
    objectType: "thread",
    verb: "create",
    createdAt: "2026-05-21T00:00:00.000Z",
    objectId: "obj-7",
    metadata: { reason: "test", count: 3 },
  };

  /** The pre-adapter implementation: direct createHash over the canonical JSON. */
  function legacyAuditHash(rec: HashableAuditRecord, prevHash: string | null): string {
    const normalized = {
      actorId: rec.actorId,
      createdAt: rec.createdAt ?? null,
      metadata: rec.metadata ?? {},
      objectId: rec.objectId ?? null,
      objectType: rec.objectType,
      onBehalfOfActorId: rec.onBehalfOfActorId ?? null,
      prevHash,
      spanId: rec.trace?.spanId ?? null,
      toolId: rec.toolId ?? null,
      traceId: rec.trace?.traceId ?? null,
      verb: rec.verb,
    };
    return createHash("sha256")
      .update(JSON.stringify(sortKeys(normalized)))
      .digest("hex");
  }

  it("the routed hash equals the direct node:crypto hash (genesis record)", () => {
    expect(computeAuditHash(record, null).thisHash).toBe(legacyAuditHash(record, null));
  });

  it("the routed hash equals the direct node:crypto hash (chained record)", () => {
    const prev = "a".repeat(64);
    expect(computeAuditHash(record, prev).thisHash).toBe(legacyAuditHash(record, prev));
  });

  it("holds explicitly under an injected Node provider", () => {
    setCryptoProviderForTesting(new NodeCryptoProvider());
    expect(computeAuditHash(record, null).thisHash).toBe(legacyAuditHash(record, null));
  });
});

describe("webhook HMAC — byte-identical with FIPS off", () => {
  /** The pre-adapter implementation: direct createHmac over `${ts}.${payload}`. */
  function legacySignature(secret: string, timestamp: number, payload: string): string {
    return createHmac("sha256", secret).update(`${String(timestamp)}.${payload}`).digest("hex");
  }

  it("signWebhookPayload produces the same HMAC as direct node:crypto", () => {
    const secret = "whsec_test";
    const payload = JSON.stringify({ event: "thread.created", id: "t-1" });
    const timestamp = 1_747_000_000;
    const signed = signWebhookPayload({ payload, secret, timestamp });
    expect(signed.signature).toBe(legacySignature(secret, timestamp, payload));
  });

  it("verifyWebhookSignature accepts a signature minted by the legacy form", () => {
    const secret = "whsec_test";
    const payload = "raw-body";
    const timestamp = 1_747_000_000;
    const header = `t=${String(timestamp)},v1=${legacySignature(secret, timestamp, payload)}`;
    expect(
      verifyWebhookSignature({ payload, secret, header, toleranceSeconds: -1 }),
    ).toBe(true);
  });
});

describe("auth token hashing — byte-identical with FIPS off", () => {
  it("hashAccessToken equals the direct node:crypto SHA-256", () => {
    const token = "helix_at_abcdef0123456789";
    expect(hashAccessToken(token)).toBe(createHash("sha256").update(token).digest("hex"));
  });
});

describe("no FIPS path runs when FIPS is off", () => {
  it("the routed call-sites never instantiate a FipsCryptoProvider", () => {
    // Spy the FIPS provider's self-test: if any FIPS instance were built while
    // FIPS is off, the constructor would run and the spy would be hit.
    const selfTest = vi.spyOn(
      FipsCryptoProvider.prototype as unknown as { runSelfTest: () => boolean },
      "runSelfTest",
    );
    setCryptoProviderForTesting(undefined);

    const minimalRecord: HashableAuditRecord = {
      actorId: "a",
      objectType: "thread",
      verb: "create",
    };
    hashAccessToken("tok");
    computeAuditHash(minimalRecord, null);
    signWebhookPayload({ payload: "p", secret: "s", timestamp: 1 });

    expect(getCryptoProvider().id).toBe("node");
    expect(selfTest).not.toHaveBeenCalled();
  });
});

/** Recursively sort object keys — matches the canonical-JSON form of hash.ts. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      output[key] = sortKeys(input[key]);
    }
    return output;
  }
  return value;
}
