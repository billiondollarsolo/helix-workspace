export const FINAL_ARTIFACT_SCHEMAS = Object.freeze({
  fullGates: "helix.final-release.full-gates.v1",
  migration: "helix.final-release.migration-status.v1",
  productionConfig: "helix.final-release.production-config.v1",
  sloSoak: "helix.final-release.slo-soak.v1",
  securityReview: "helix.final-release.security-review.v1",
  supportReadiness: "helix.final-release.support-readiness.v1",
  businessReadiness: "helix.final-release.business-readiness.v1",
  protectedRepositoryState: "helix.final-release.protected-repository-state.v1",
  productionDecision: "helix.final-release.production-decision.v1",
});

export const REQUIRED_WORKSPACE_GATES = Object.freeze([
  "pnpm format:check",
  "pnpm typecheck",
  "pnpm lint",
  "pnpm test",
  "pnpm build",
  "pnpm quality:editors-boundaries:test",
  "pnpm quality:editors-boundaries",
  "pnpm quality:editors-contract",
  "pnpm --filter @helix/web test:e2e",
  "pnpm quality:a11y",
  "docker compose config",
  "pnpm quality:live-auth-smoke -- --seeded-demo-tools",
  "pnpm quality:live-auth-smoke -- --chat-realtime-smoke",
  "pnpm quality:live-auth-smoke -- --assistant-smoke",
  "pnpm quality:live-auth-smoke -- --audit-runtime-smoke",
]);

export const REQUIRED_EDITORS_GATES = Object.freeze([
  "pnpm format:check",
  "pnpm lint",
  "pnpm typecheck",
  "pnpm test",
  "pnpm build",
]);

export const REQUIRED_PRODUCTION_IMAGES = Object.freeze([
  "application",
  "web",
  "postgres",
  "redis",
  "nats",
  "meilisearch",
  "rustfs",
  "cerbos",
  "spamassassin",
  "clamav",
]);

export const REQUIRED_PRODUCTION_IMAGE_SUBJECTS = Object.freeze({
  application: "ghcr.io/billiondollarsolo/helix-workspace",
  web: "ghcr.io/billiondollarsolo/helix-workspace-web",
  postgres: "ghcr.io/billiondollarsolo/helix-workspace-postgres",
  redis: "docker.io/library/redis",
  nats: "ghcr.io/billiondollarsolo/helix-workspace-nats",
  meilisearch: "ghcr.io/billiondollarsolo/helix-workspace-meilisearch",
  rustfs: "docker.io/rustfs/rustfs",
  cerbos: "ghcr.io/billiondollarsolo/helix-workspace-cerbos",
  spamassassin: "ghcr.io/billiondollarsolo/helix-workspace-spamassassin",
  clamav: "docker.io/clamav/clamav",
});

export const APPROVED_MVP_CORE_APPS = Object.freeze(["assistant", "chat", "drive", "mail"]);
export const APPROVED_MVP_WEB_SURFACES = Object.freeze([
  "admin",
  "assistant",
  "chat",
  "drive",
  "mail",
]);
export const DISABLED_MVP_SURFACES = Object.freeze([
  "calendar",
  "docs",
  "editors",
  "meet",
  "sheets",
  "slides",
]);

export const ARTIFACT_SCHEMAS = Object.freeze({
  commandReport: "helix.evidence.command-report.v1",
  rollbackPlan: "helix.evidence.rollback-plan.v1",
  soakReport: "helix.evidence.slo-soak-report.v1",
  threatModel: "helix.evidence.threat-model.v1",
  repositoryScan: "helix.evidence.repository-scan.v1",
  dependencyAudit: "helix.evidence.dependency-audit.v1",
  sensitiveDataScan: "helix.evidence.sensitive-data-scan.v1",
  containerScan: "helix.evidence.container-scan.v1",
  sbom: "helix.evidence.sbom.v1",
  manualReview: "helix.evidence.manual-security-review.v1",
  findingDisposition: "helix.evidence.finding-disposition.v1",
  runbookIndex: "helix.evidence.runbook-index.v1",
  limitations: "helix.evidence.user-limitations.v1",
  rolloutObservations: "helix.evidence.rollout-observations.v1",
  rolloutExitReview: "helix.evidence.rollout-exit-review.v1",
  independentSecurityReview: "helix.evidence.independent-security-review.v1",
  costModel: "helix.evidence.cost-model.v1",
  riskMitigation: "helix.evidence.risk-mitigation.v1",
  imageProvenance: "helix.evidence.github-sigstore-image-provenance.v1",
  spdxDocument: "spdx-2.3-json",
});

export const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;
export const OCI_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
export const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._+@:/-]{2,127}$/u;
export const SENSITIVE_FIELD_PATTERN =
  /(?:authorization|cookie|credential|password|private.?key|secret|token)/iu;
export const SECRET_VALUE_PATTERN =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api|access|refresh)[_-]?token\s*[:=]|password\s*[:=]|bearer\s+[A-Za-z0-9._~+/=-]{12,})/iu;
export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
export const GITHUB_CERTIFICATE_EXTENSION_OIDS = Object.freeze({
  issuer: "1.3.6.1.4.1.57264.1.1",
  sourceDigest: "1.3.6.1.4.1.57264.1.3",
  sourceRepository: "1.3.6.1.4.1.57264.1.5",
  sourceRef: "1.3.6.1.4.1.57264.1.6",
});
export const SIGSTORE_BUNDLE_MEDIA_TYPE = "application/vnd.dev.sigstore.bundle.v0.3+json";
export const INTOTO_STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
export const HELIX_PAIRED_SOURCE_PROVENANCE_TYPE =
  "https://helix.billiondollarsolo.com/attestations/paired-source/v1";
export const ARTIFACT_MAX_AGE_MS = Object.freeze({
  fullGates: 24 * 60 * 60 * 1_000,
  migration: 24 * 60 * 60 * 1_000,
  productionConfig: 24 * 60 * 60 * 1_000,
  sloSoak: 7 * 24 * 60 * 60 * 1_000,
  securityReview: 7 * 24 * 60 * 60 * 1_000,
  supportReadiness: 7 * 24 * 60 * 60 * 1_000,
  businessReadiness: 7 * 24 * 60 * 60 * 1_000,
  protectedRepositoryState: 60 * 60 * 1_000,
  productionDecision: 24 * 60 * 60 * 1_000,
});
