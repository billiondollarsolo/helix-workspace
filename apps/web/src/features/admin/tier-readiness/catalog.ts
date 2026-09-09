/* Security tier readiness — the static catalogue.
 *
 * Tier definitions, the services and readiness gates each tier expects, the
 * control matrix, and the lookup maps derived from them. Pure data: no React,
 * no fetching. The backend supplies live status; this describes what "ready"
 * means for each tier. */

import {
  ArchiveRestore,
  Cloud,
  Database,
  KeyRound,
  LockKeyhole,
  RadioTower,
  ServerCog,
  ShieldCheck,
  ShieldQuestion,
} from "lucide-react";
import type {
  AIConfigStatus,
  BackendRequirement,
  CheckStatus,
  ControlRow,
  ReadinessCheck,
  RequiredService,
  ServiceStatus,
  TierDefinition,
  TierId,
} from "@/features/admin/tier-readiness/types";

export const tiers: readonly TierDefinition[] = [
  {
    id: "personal",
    shortName: "Tier 1",
    title: "Personal",
    target: "Single VPS or small team",
    serviceSummary: "7 core services",
    requiredServiceIds: ["postgres", "rustfs", "nats", "meilisearch", "cerbos", "redis", "caddy"],
  },
  {
    id: "business",
    shortName: "Tier 2",
    title: "Business",
    target: "Professional single-region deployment",
    serviceSummary: "Tier 1 plus secrets and audit shipping",
    requiredServiceIds: [
      "postgres",
      "rustfs",
      "nats",
      "meilisearch",
      "cerbos",
      "redis",
      "caddy",
      "secrets",
      "audit-shipper",
    ],
  },
  {
    id: "enterprise",
    shortName: "Tier 3",
    title: "Enterprise",
    target: "Regulated and high-availability deployments",
    serviceSummary: "Vault, SPIRE, CloudNativePG, and SIEM bridge",
    requiredServiceIds: [
      "postgres",
      "rustfs",
      "nats",
      "meilisearch",
      "cerbos",
      "redis",
      "caddy",
      "vault",
      "audit-shipper",
      "spire",
      "cloudnativepg",
      "siem",
    ],
  },
  {
    id: "sovereign",
    shortName: "Tier 4",
    title: "Sovereign",
    target: "Air-gapped, FIPS, ATO-track environments",
    serviceSummary: "Full Tier 3 plus FIPS, STIG, HSM, and air-gap tooling",
    requiredServiceIds: [
      "postgres",
      "rustfs",
      "nats",
      "meilisearch",
      "cerbos",
      "redis",
      "caddy",
      "vault",
      "audit-shipper",
      "spire",
      "cloudnativepg",
      "siem",
      "fips",
      "stig",
      "airgap",
      "hsm",
    ],
  },
];

export const requiredServices: readonly RequiredService[] = [
  {
    id: "postgres",
    name: "Postgres",
    description: "Platform metadata, auth, documents, audit chain",
    icon: Database,
    status: "online",
  },
  {
    id: "rustfs",
    name: "RustFS / S3",
    description: "Object storage with versioning and backup target hooks",
    icon: Cloud,
    status: "online",
  },
  {
    id: "nats",
    name: "NATS JetStream",
    description: "Durable events, plugin broadcasts, activity fanout",
    icon: RadioTower,
    status: "online",
  },
  {
    id: "meilisearch",
    name: "Meilisearch",
    description: "Derived unified search index",
    icon: ServerCog,
    status: "online",
  },
  {
    id: "cerbos",
    name: "Cerbos",
    description: "Policy decision point for platform permissions",
    icon: ShieldCheck,
    status: "online",
  },
  {
    id: "redis",
    name: "Redis",
    description: "Sessions, rate limits, and ephemeral presence",
    icon: Database,
    status: "online",
  },
  {
    id: "caddy",
    name: "Caddy edge",
    description: "TLS 1.3 edge, reverse proxy, readiness handoff",
    icon: ShieldCheck,
    status: "configured",
  },
  {
    id: "secrets",
    name: "SOPS or Vault",
    description: "Tier 2 secrets backend selection",
    icon: KeyRound,
    status: "configured",
  },
  {
    id: "audit-shipper",
    name: "Audit shipper",
    description: "Immutable S3 Object Lock delivery",
    icon: ArchiveRestore,
    status: "configured",
  },
  {
    id: "vault",
    name: "HashiCorp Vault",
    description: "Mandatory Tier 3+ secrets backend and rotation source",
    icon: KeyRound,
    status: "pending",
  },
  {
    id: "spire",
    name: "SPIRE",
    description: "SPIFFE workload identity and internal mTLS",
    icon: ShieldQuestion,
    status: "pending",
  },
  {
    id: "cloudnativepg",
    name: "CloudNativePG",
    description: "HA Postgres operator and PITR workflow",
    icon: Database,
    status: "missing",
  },
  {
    id: "siem",
    name: "SIEM bridge",
    description: "CEF/LEEF or syslog delivery for immutable audit",
    icon: RadioTower,
    status: "missing",
  },
  {
    id: "fips",
    name: "FIPS adapters",
    description: "Validated crypto module integration points",
    icon: LockKeyhole,
    status: "missing",
  },
  {
    id: "stig",
    name: "STIG images",
    description: "Hardened image family and checklist evidence",
    icon: ServerCog,
    status: "missing",
  },
  {
    id: "airgap",
    name: "Air-gap tooling",
    description: "Offline plugin bundle and registry import workflow",
    icon: ArchiveRestore,
    status: "missing",
  },
  {
    id: "hsm",
    name: "HSM / KMS",
    description: "HSM-backed keys for backups and protected stores",
    icon: LockKeyhole,
    status: "missing",
  },
];

export const readinessChecks: readonly ReadinessCheck[] = [
  {
    id: "backup-encryption",
    title: "Backup encryption",
    detail:
      "Business upgrades require a successful encrypted backup before the tier engine can apply the change.",
    statusByTier: {
      personal: "not-required",
      business: "ready",
      enterprise: "warning",
      sovereign: "blocked",
    },
  },
  {
    id: "audit-destinations",
    title: "Audit destinations",
    detail:
      "Postgres audit is local; higher tiers require immutable object storage, SIEM, or WORM destinations.",
    statusByTier: {
      personal: "ready",
      business: "ready",
      enterprise: "blocked",
      sovereign: "blocked",
    },
  },
  {
    id: "mfa-policy",
    title: "MFA policy",
    detail:
      "Admin MFA is set for Business; Enterprise and Sovereign need org-wide enforcement or CAC/PIV.",
    statusByTier: {
      personal: "not-required",
      business: "ready",
      enterprise: "warning",
      sovereign: "blocked",
    },
  },
  {
    id: "secrets-backend",
    title: "Secrets backend",
    detail: "SOPS satisfies Tier 2; Tier 3+ requires Vault health and rotation evidence.",
    statusByTier: {
      personal: "not-required",
      business: "ready",
      enterprise: "warning",
      sovereign: "warning",
    },
  },
  {
    id: "workload-identity",
    title: "Workload identity",
    detail: "Tier 3+ requires SPIRE/SPIFFE internal identity and mTLS certificates.",
    statusByTier: {
      personal: "not-required",
      business: "not-required",
      enterprise: "warning",
      sovereign: "warning",
    },
  },
  {
    id: "ha-postgres",
    title: "HA Postgres",
    detail: "Tier 3+ requires CloudNativePG HA Postgres evidence before readiness is complete.",
    statusByTier: {
      personal: "not-required",
      business: "not-required",
      enterprise: "blocked",
      sovereign: "blocked",
    },
  },
];

export const controls: readonly ControlRow[] = [
  {
    id: "backup",
    label: "Backup encryption",
    icon: ArchiveRestore,
    currentValue: "age encrypted backup to S3 with versioning",
    valuesByTier: {
      personal: "none or optional gpg",
      business: "age encryption before upload",
      enterprise: "KMS-backed envelope encryption",
      sovereign: "HSM-backed encryption to WORM destination",
    },
  },
  {
    id: "audit",
    label: "Audit destinations",
    icon: RadioTower,
    currentValue: "Postgres plus immutable S3",
    valuesByTier: {
      personal: "Postgres only",
      business: "immutable S3 Object Lock",
      enterprise: "immutable S3 plus SIEM",
      sovereign: "WORM storage plus SIEM in CEF/LEEF",
    },
  },
  {
    id: "mfa",
    label: "MFA",
    icon: ShieldCheck,
    currentValue: "admins required, passkeys enabled",
    valuesByTier: {
      personal: "optional TOTP",
      business: "admins required",
      enterprise: "org-wide required, SAML/OIDC plugin",
      sovereign: "CAC/PIV smartcard",
    },
  },
  {
    id: "secrets",
    label: "Secrets",
    icon: KeyRound,
    currentValue: "SOPS with age keys",
    valuesByTier: {
      personal: "environment variables",
      business: "SOPS or Vault",
      enterprise: "Vault mandatory, 90-day rotation",
      sovereign: "Vault plus HSM-backed keys",
    },
  },
  {
    id: "ha",
    label: "Availability",
    icon: Database,
    currentValue: "single Postgres instance",
    valuesByTier: {
      personal: "single instance",
      business: "single region",
      enterprise: "CloudNativePG, 3-replica NATS",
      sovereign: "Tier 3 HA with air-gap evidence",
    },
  },
];

export const aiCostDefaultsByTier: Readonly<Record<TierId, AIConfigStatus["costLimits"]>> = {
  personal: {},
  business: {
    perUserPerDayUSD: 10,
    perOrgPerDayUSD: 500,
    perAgentPerDayUSD: 10,
  },
  enterprise: {
    perUserPerDayUSD: 50,
    perAgentPerDayUSD: 50,
  },
  sovereign: {
    perUserPerDayUSD: 0,
    perOrgPerDayUSD: 0,
    perAgentPerDayUSD: 0,
  },
};

export const statusText: Readonly<Record<CheckStatus, string>> = {
  ready: "Ready",
  warning: "Needs evidence",
  blocked: "Blocked",
  "not-required": "Not required",
};

export const serviceStatusText: Readonly<Record<ServiceStatus, string>> = {
  online: "Online",
  configured: "Configured",
  pending: "Pending",
  missing: "Missing",
};

export const serviceById = new Map(requiredServices.map((service) => [service.id, service]));
export const readinessRequirementKeyByCheckId: Readonly<
  Partial<Record<string, BackendRequirement["key"]>>
> = {
  "backup-encryption": "encryptedBackups",
  "audit-destinations": "auditDestinations",
  "mfa-policy": "mfa",
  "secrets-backend": "vault",
  "workload-identity": "spire",
  "ha-postgres": "cloudNativePg",
};
export const serviceRequirementKeyById: Readonly<
  Partial<Record<string, BackendRequirement["key"]>>
> = {
  vault: "vault",
  spire: "spire",
  siem: "siem",
  cloudnativepg: "cloudNativePg",
};
