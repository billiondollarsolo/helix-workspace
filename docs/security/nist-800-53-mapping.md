# Helix NIST SP 800-53 Rev. 5 Control Mapping

This document maps the security controls **implemented in Helix** to NIST SP
800-53 Rev. 5 control families. It is an *implementation* mapping intended to
seed a System Security Plan (SSP) and to give assessors a direct line from a
control to the code, configuration, or infrastructure artifact that satisfies
it. It is **not** an authorization package and makes no accreditation claim.

Scope: the Helix application (`apps/helix`), the Helm chart
(`infra/helm/helix`), the Tier 4 sovereign overlay, and the Tier 4 hardening
artifacts under `infra/security/tier4`.

## How to read this document

- **Helix control** — the concrete mechanism Helix ships.
- **Primary artifact** — the file(s) that implement or configure it.
- **NIST families** — the 800-53 families the control contributes to.
- **Tier** — the lowest Helix security tier at which the control is active
  (`all` = every install; `T3` = enterprise overlay; `T4` = sovereign overlay).

A single Helix control commonly satisfies parts of several controls across
families; the mapping is many-to-many by design.

---

## 1. Cerbos policy authorization (access control engine)

Helix delegates every authorization decision to Cerbos policies. Resource
access, verb gating, and attribute conditions are evaluated centrally rather
than scattered through handlers, so the policy set is the single, auditable
source of truth for "who may do what."

| NIST control | Contribution |
| ------------ | ------------ |
| AC-2 Account Management | Principal attributes (actor type, org, scopes) drive policy decisions. |
| AC-3 Access Enforcement | Cerbos is the mandatory decision point for resource/verb access. |
| AC-6 Least Privilege | Default-deny policies; a principal gets only explicitly granted verbs. |
| AC-24 Access Control Decisions | Decisions are computed by a dedicated engine and are reproducible from policy + request context. |
| CM-5 Access Restrictions for Change | Policy changes are version-controlled and reviewable as code. |

Primary artifacts: `apps/helix/src/platform/policy/**`, the Cerbos policy
bundle, the policy-decision middleware on the API layer.

## 2. Audit hash chain (tamper-evident audit log)

Every audit record carries a SHA-256 hash over its canonicalized content plus
the previous record's hash, forming a chain. `verifyAuditHashChain` recomputes
the chain and reports the first divergence, so any insertion, deletion, or edit
of a historical record is detectable.

| NIST control | Contribution |
| ------------ | ------------ |
| AU-9 Protection of Audit Information | Hash chaining makes undetected tampering of stored audit records infeasible. |
| AU-10 Non-repudiation | Each record is bound to its actor and to chain position. |
| AU-12 Audit Record Generation | Records are generated for security-relevant events with actor/object/verb/trace fields. |
| SI-7 Software, Firmware, and Information Integrity | Chain verification is an integrity check over the audit dataset. |
| AU-2 / AU-3 Event Logging / Content of Records | Canonical record content includes actor, object, verb, trace, and timestamp. |

Primary artifacts: `apps/helix/src/platform/audit/hash.ts` (chain compute +
verify, routed through the crypto adapter), `immutable-postgres.ts`,
`immutable-s3.ts` (WORM destinations).

## 3. Data classification gating

Resources carry a classification label; Helix gates read/write/export paths on
that label so higher-classified data cannot flow to a principal or destination
not cleared for it.

| NIST control | Contribution |
| ------------ | ------------ |
| AC-4 Information Flow Enforcement | Classification labels constrain where data may move. |
| AC-3 Access Enforcement | Classification is an input to the access decision. |
| AC-16 Security and Privacy Attributes | Classification is a first-class attribute bound to resources. |
| SC-7 Boundary Protection | Export paths enforce classification before data leaves a boundary. |
| MP-3 Media Marking (analogue) | Records and exports carry their classification marking. |

Primary artifacts: classification metadata on resources, the gating checks in
the API and export paths, Cerbos conditions referencing classification.

## 4. Rate limiting

Helix enforces per-actor and per-org rate limits (Redis-backed in production,
in-memory for single-node) on API and AI-cost paths to bound abuse and resource
exhaustion.

| NIST control | Contribution |
| ------------ | ------------ |
| SC-5 Denial-of-Service Protection | Limits cap request and cost rates per principal. |
| AC-7 Unsuccessful Logon Attempts (analogue) | Repeated-failure throttling on auth paths. |
| SI-4 System Monitoring | Limiter rejections are observable signals of abuse. |
| SC-6 Resource Availability | Per-tenant quotas protect shared capacity. |

Primary artifacts: `apps/helix/src/platform/limits/redis-limiter.ts`,
`apps/helix/src/platform/ai/costs/*-limiter.ts`.

## 5. Scope composition (token scopes)

OAuth access tokens carry explicit scopes. Granted scopes must be a subset of
the client's allowed scopes, and authorization-code grants are further
constrained to the code's bound scopes — scopes only ever narrow, never widen.

| NIST control | Contribution |
| ------------ | ------------ |
| AC-3 Access Enforcement | Scopes constrain what an authenticated token may invoke. |
| AC-6 Least Privilege | Default grant is the minimal requested subset. |
| IA-2 Identification and Authentication | Tokens bind a verified client/actor to a scope set. |
| IA-5 Authenticator Management | Token lifetime, rotation, and revocation are managed (RFC 7009). |

Primary artifacts: `apps/helix/src/platform/auth/oauth.ts` (scope parsing,
subset enforcement, issuance, revocation, introspection).

## 6. Signature verification (webhook integrity)

Outbound webhooks are signed with HMAC-SHA-256 over `timestamp.payload`;
receivers verify the signature and timestamp window with a constant-time
comparison. Inbound verification follows the same scheme.

| NIST control | Contribution |
| ------------ | ------------ |
| SC-8 Transmission Confidentiality and Integrity | Signed payloads detect in-transit tampering. |
| SI-7 Information Integrity | HMAC verification rejects modified payloads. |
| AU-10 Non-repudiation | A valid signature attests origin from the shared-secret holder. |
| IA-9 Service Identification and Authentication | The shared secret authenticates the sending service. |
| SC-23 Session Authenticity | Timestamp window plus signature resist replay. |

Primary artifacts: `apps/helix/src/platform/webhooks/signatures.ts` (sign /
verify, routed through the crypto adapter), `webhooks/store.ts` (secret
minting).

## 7. mTLS / workload identity (service-to-service authentication)

In-cluster traffic uses mutual TLS. At Tier 2 this is configured at the proxy
(Caddy upstream mTLS); at Tier 3/4 workload identities are issued by SPIRE so
each service presents a short-lived, attested identity.

| NIST control | Contribution |
| ------------ | ------------ |
| SC-8 Transmission Confidentiality and Integrity | All internal traffic is encrypted and integrity-protected. |
| IA-3 Device Identification and Authentication | Each workload authenticates with a certificate identity. |
| IA-9 Service Identification and Authentication | SPIRE-issued SVIDs identify services to each other. |
| SC-23 Session Authenticity | Mutual authentication binds both ends of every session. |
| AC-4 Information Flow Enforcement | mTLS plus NetworkPolicy restrict which services may talk. |

Primary artifacts: Caddy mTLS example (`pnpm infra:caddy:validate`), SPIRE
toggles in `values-enterprise.yaml` / `values-sovereign.yaml`, chart
NetworkPolicy.

## 8. FIPS-validated cryptography (Tier 4, opt-in)

The crypto adapter (`apps/helix/src/platform/crypto`) routes every Helix crypto
primitive through a `CryptoProvider`. The default provider is byte-identical to
direct `node:crypto`; the **opt-in** `FipsCryptoProvider` restricts the
algorithm set to FIPS-approved primitives and fails closed on a non-FIPS
runtime. Activation requires three explicit, default-off switches: the STIG
image, the sovereign Helm overlay, and the `HELIX_FIPS_MODE` config flag.

| NIST control | Contribution |
| ------------ | ------------ |
| SC-13 Cryptographic Protection | FIPS-approved algorithms enforced by an allow-list; non-approved primitives rejected. |
| SC-12 Cryptographic Key Establishment and Management | KDF parameters (PBKDF2 iteration/length floors) policed; keys sourced from KMS. |
| SC-17 PKI Certificates (supports) | TLS policy pins approved versions and cipher suites. |
| CM-6 Configuration Settings | FIPS mode, adapter, and TLS policy are explicit, rendered configuration. |
| SA-9 External System Services | The FIPS OpenSSL module is supplied by the STIG base image (a procurement control). |

Primary artifacts: `apps/helix/src/platform/crypto/**`,
`infra/docker/Dockerfile.stig`, `infra/security/tier4/fips-stig-adapter.yaml`,
`infra/helm/helix/values-sovereign.yaml`.

## 9. Supporting infrastructure controls

| Helix control | Primary artifact | NIST families |
| ------------- | ---------------- | ------------- |
| Non-root, read-only-rootfs, cap-drop pod security | Deployment `securityContext`, STIG profile | AC-6, CM-6, CM-7, SI-16 |
| Default-deny network egress | `values-sovereign.yaml` `networkPolicy.egress` | AC-4, SC-7 |
| Digest-pinned, signed, SBOM-bearing images | `stig.imagePolicy`, `Dockerfile.stig` | CM-2, CM-5, SR-3, SR-4, SR-11, SI-2 |
| Secret externalization to Vault / CSI | `external.vault`, `vault.csi` | IA-5, SC-12, SC-28 |
| Immutable / WORM audit storage + KMS | S3 immutable store, `external.kms` | AU-9, AU-11, SC-28 |
| SIEM audit routing | `siem.enabled`, audit destinations | AU-6, SI-4, IR-4, IR-5 |
| HA replicas, PDB, backups (PITR/WAL) | `autoscaling`, `podDisruptionBudget`, CloudNativePG | CP-9, CP-10, SC-5, SC-6 |
| Air-gapped install with verified bundle | `tier4-airgap-install.md`, `airgap-manifest.yaml` | CM-2, SI-2, SR-3, SR-11 |
| Runtime attestation of FIPS posture | `fips-stig-adapter.yaml` `runtimeAttestation` | CA-7, SI-4, SI-6 |

## Control family coverage summary

| Family | Covered by |
| ------ | ---------- |
| AC — Access Control | Cerbos, classification gating, scope composition, NetworkPolicy, pod security |
| AU — Audit and Accountability | Audit hash chain, WORM storage, SIEM routing |
| CA — Assessment, Authorization, Monitoring | Runtime attestation, acceptance gates |
| CM — Configuration Management | Tier overlays, image policy, FIPS configuration |
| CP — Contingency Planning | HA replicas, PDB, CloudNativePG backups |
| IA — Identification and Authentication | OAuth/scopes, mTLS/SPIRE, Vault authenticators |
| IR — Incident Response | SIEM ingestion of audit events |
| MP — Media Protection (analogue) | Classification marking on records/exports |
| SA — System and Services Acquisition | FIPS base image, signed-provenance procurement |
| SC — System and Communications Protection | Crypto adapter/FIPS, mTLS, webhook signatures, rate limiting, boundary policy |
| SI — System and Information Integrity | Hash-chain verification, signature verification, monitoring, flaw remediation |
| SR — Supply Chain Risk Management | Digest pinning, SBOMs, signature verification, air-gap bundle integrity |

## Inheritance and shared responsibility

The following are **not** implemented by Helix and must be inherited from the
hosting environment or provided by the operator:

- Physical and environmental controls (PE family).
- Personnel security (PS family) and most program-management (PM) controls.
- The FIPS 140-3 *module validation* itself — Helix consumes a validated
  OpenSSL supplied by the STIG base image; module certification is a
  procurement/ops responsibility (see SA-9 above).
- Cluster-level STIG enforcement (admission control via Kyverno/Gatekeeper) —
  Helix supplies the policy *contract* in `values-sovereign.yaml` and
  `fips-stig-adapter.yaml`; the operator must run an enforcing admission
  controller.
- Backup media protection and offsite rotation for CP-9.
