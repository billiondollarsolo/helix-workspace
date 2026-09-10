# ADR-0026: Ed25519 for License Key Signing

> Historical cross-product proposal. Retained for context; the [1.0 scope](../release/1.0-scope.md) is authoritative. This record does not enable features or impose a commercial license.

## Status

Proposed (gates Commercial Phase B.6)

## Context

License keys (per ADR-0010) need cryptographic signatures to prevent forgery. Options:

1. **Ed25519** — modern elliptic curve; 64-byte signatures; fast verify; libraries ubiquitous.
2. **RS256** (RSA 2048+) — JWT standard; bigger signatures; slower verify; broader legacy compat.
3. **ES256** (ECDSA P-256) — common in JWT; 64-byte sigs; well-established.

## Decision

We will use **Ed25519** for license key JWT signing.

Format: standard JWT with `alg: EdDSA, crv: Ed25519`. Key generation via HSM (or Vault Transit). Public key embedded in helix binary + verifiable via JWKS endpoint (online) or hardcoded fingerprint (air-gap).

## Consequences

### Positive

- Fastest signature verification (<1 ms typical).
- Smallest signature (64 bytes) — keys fit in QR codes for air-gap delivery.
- Resistant to common ECDSA implementation bugs (deterministic by spec).
- Modern best-practice; no nonce-reuse vulnerability class.
- Library support universal in TS (`jose`, `@noble/curves`).

### Negative

- Older JWT libraries may lack EdDSA support (modern libs all have it).
- Java enterprise compatibility marginally worse than RS256 (irrelevant for helix self-host = customer ops, not their code integration).

### Neutral

- Key rotation strategy: per-year keys; old keys retained in JWKS for verification of existing licenses; revocation list separately.

## Implementation

- Ed25519 keypair generation in HSM (commercial backend).
- Sign license JWT with private key on issuance.
- Public key shipped in helix binary at `/Users/mj/mjcode/helix-all/helix-workspace/apps/helix/src/platform/licensing/public-key.ts` (compile-time constant).
- Verification: `jose.jwtVerify(token, publicKey, { algorithms: ['EdDSA'] })`.
- JWKS endpoint at `https://licenses.helix.app/.well-known/jwks.json` for renewal validation.

## Alternatives Considered

### Alt 2: RS256

**Rejected**. Bigger signatures; slower; nothing gained for this use case.

### Alt 3: ES256

**Rejected** for license keys specifically. Ed25519's deterministic signatures + modern provenance better fit; ES256 has implementation pitfalls.

## References

- `02-commercial/license-management.md`
- ADR-0010
- `decisions-owed.md` C5
