#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, readdir, realpath, unlink } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  MAIL_EXTERNAL_TARGETS,
  MAIL_LIVE_SCENARIOS,
  validateMailLiveEvidence,
} from "./mail-live-evidence-smoke.mjs";
import { AGENT_LIVE_SCENARIOS, validateAgentLiveEvidence } from "./agent-live-evidence-smoke.mjs";
import {
  RESTORE_DRILL_SCENARIOS,
  validateRestoreDrillEvidence,
} from "./restore-drill-evidence.mjs";
import { CHAT_LIVE_SCENARIOS, validateChatLiveEvidence } from "./chat-live-evidence-contract.mjs";
import { DRIVE_EVIDENCE_CASES, validateDriveEvidence } from "./drive-live-evidence-smoke.mjs";
import {
  DATA_PLANE_SCENARIOS,
  validateDataPlaneEvidence,
} from "./data-plane-live-evidence-contract.mjs";
import {
  FAILURE_RECOVERY_SCENARIOS,
  validateFailureRecoveryEvidence,
} from "./failure-recovery-contract.mjs";
import { validateDastEvidence } from "./dast-evidence.mjs";
import { validateReleaseEvidenceBinding } from "./release-evidence-binding.mjs";
import { evidenceSetDigest, validateFinalReleaseArtifacts } from "./final-release-artifacts.mjs";

const SENSITIVE_KEY_PATTERN = /(password|secret|token|authorization|cookie|key|credential)/iu;
const FINAL_RELEASE_GATES = [
  "M7",
  "D7",
  "C6",
  "A7",
  "O2",
  "O4",
  "V4",
  "V5",
  "V6",
  "R0",
  "R1",
  "R2",
  "R3",
];
const FINAL_ARTIFACT_OPTIONS = Object.freeze([
  ["--full-gates-evidence", "fullGatesEvidence", "fullGates"],
  ["--migration-status-evidence", "migrationStatusEvidence", "migration"],
  ["--production-config-evidence", "productionConfigEvidence", "productionConfig"],
  ["--slo-soak-evidence", "sloSoakEvidence", "sloSoak"],
  ["--security-review-evidence", "securityReviewEvidence", "securityReview"],
  ["--support-readiness-evidence", "supportReadinessEvidence", "supportReadiness"],
  ["--business-readiness-evidence", "businessReadinessEvidence", "businessReadiness"],
  [
    "--protected-repository-state-evidence",
    "protectedRepositoryStateEvidence",
    "protectedRepositoryState",
  ],
  ["--production-decision-evidence", "productionDecisionEvidence", "productionDecision"],
]);

const usage = `Usage: infra/scripts/release-readiness-manifest.mjs [options]

Build a redacted, deterministic release-readiness manifest for the paired
helix-workspace and helix-editors revisions.

Options:
  --workspace-dir <path>       Default: current directory
  --editors-dir <path>         Default: ../helix-editors
  --evidence-dir <path>        Required unless HELIX_RELEASE_EVIDENCE_DIR is set
  --require-evidence <path>    Required relative evidence path; repeatable
  --mail-live-evidence <path>  Validate and require passed local M7 Mail evidence
  --agent-live-evidence <path> Validate and require passed A7 Agent evidence
  --chat-live-evidence <path>  Validate and require passed C6/V3 Chat evidence,
                               including the release pilot-load minimums
  --restore-drill-evidence <path>
                               Validate and require passed O4 restore evidence
  --drive-live-evidence <path> Validate and require passed D7 Drive evidence
  --data-plane-live-evidence <path>
                               Validate and require passed O2 data-plane evidence
  --failure-recovery-evidence <path>
                               Validate and require passed V4 failure/recovery evidence
  --dast-evidence <path>       Validate and require passed V5 DAST evidence
  --full-gates-evidence <path> Validate and require exact V6/R0 full-gate evidence
  --migration-status-evidence <path>
                               Validate deployed migration and approved rollback evidence
  --production-config-evidence <path>
                               Validate the resolved, redacted production config digest
  --slo-soak-evidence <path>   Validate SLO objectives and a real 24-hour soak
  --security-review-evidence <path>
                               Validate security scans, SBOMs, and finding dispositions
  --support-readiness-evidence <path>
                               Validate owners, runbooks, rollout periods, and incident history
  --business-readiness-evidence <path>
                               Validate cost model, MVP limits, and accepted risks
  --protected-repository-state-evidence <path>
                               Validate signed protected remote branch/tag observations
  --production-decision-evidence <path>
                               Validate the signed R3 go/conditional-go/no-go decision
  --final-release              Require every M7/D7/C6/A7/O2/O4/V4/V5/V6/R0-R3 gate,
                               supporting artifact, and exact revision/image binding
  --require-external-mail-evidence
                               Also require passed provider/Gmail/Microsoft evidence
  --image-digest <digest>      Application image digest (legacy option name)
  --application-image-digest <digest>
                               Application image digest
  --web-image-digest <digest>  Web edge image digest
  --output <path>              Write JSON to this file as well as stdout
  --timestamp <ISO-8601>       Explicit timestamp for reproducible preflight only;
                               prohibited in final-release mode
  --help                       Show this help

Environment:
  HELIX_RELEASE_EVIDENCE_DIR
  HELIX_EDITORS_DIR
  HELIX_IMAGE_DIGEST
  HELIX_APPLICATION_IMAGE_DIGEST
  HELIX_WEB_IMAGE_DIGEST
  HELIX_RELEASE_TRUSTED_DECISION_PUBLIC_KEY
                               Protected verifier-side Ed25519 public-key path
  HELIX_RELEASE_TRUSTED_DECISION_SIGNER_FINGERPRINT
                               Protected verifier-side sha256 SPKI fingerprint
  HELIX_RELEASE_TRUSTED_GIT_STATE_PUBLIC_KEY
  HELIX_RELEASE_TRUSTED_GIT_STATE_SIGNER_FINGERPRINT
  HELIX_RELEASE_TRUSTED_GIT_STATE_SIGNER
                               Protected remote-state verifier trust
  HELIX_RELEASE_TRUSTED_FULCIO_ISSUER_CERTIFICATE
                               Pinned Fulcio issuer for offline provenance verification
  HELIX_RELEASE_TRUSTED_REKOR_PUBLIC_KEY
  HELIX_RELEASE_TRUSTED_REKOR_LOG_ID
  HELIX_RELEASE_TRUSTED_REKOR_CHECKPOINT_ORIGIN
                               Protected Rekor trust for offline log verification
  HELIX_RELEASE_TRUSTED_GITHUB_REPOSITORY
  HELIX_RELEASE_TRUSTED_EDITORS_REPOSITORY
  HELIX_RELEASE_TRUSTED_GITHUB_WORKFLOW_IDENTITY
  HELIX_RELEASE_TRUSTED_APPLICATION_SUBJECT
  HELIX_RELEASE_TRUSTED_WEB_SUBJECT
                               Protected GitHub/Sigstore provenance identities
  HELIX_RELEASE_PREVIOUS_EDITORS_SHA
                               Trusted previous release editor revision
  HELIX_RELEASE_REQUIRED_BRANCH
                               Protected release branch name; default: main
  HELIX_RELEASE_WORKSPACE_TAG  Protected workspace release tag
  HELIX_RELEASE_EDITORS_TAG    Protected editor release tag
  HELIX_MODE
  HELIX_SECURITY_TIER
  HELIX_ENABLED_APPS           Comma-separated stable app IDs
  HELIX_ENABLED_FEATURES       Comma-separated stable feature IDs
`;

if (isMain()) {
  await main();
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2), process.cwd(), process.env);
    if (options.help) {
      process.stdout.write(usage);
      process.exit(0);
    }
    const manifest = await buildReleaseReadinessManifest(options);
    const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
    if (options.output !== undefined) {
      await writeManifestOutput(options.output, serialized, options.evidenceDir);
    }
    process.stdout.write(serialized);
  } catch (error) {
    process.stderr.write(`release-readiness manifest failed: ${errorMessage(error)}\n`);
    process.exit(1);
  }
}

export async function buildReleaseReadinessManifest(options, dependencies = {}) {
  if (options.applicationImageDigest === undefined) {
    throw new Error(
      "--application-image-digest, --image-digest, HELIX_APPLICATION_IMAGE_DIGEST, or HELIX_IMAGE_DIGEST is required",
    );
  }
  if (options.webImageDigest === undefined) {
    throw new Error("--web-image-digest or HELIX_WEB_IMAGE_DIGEST is required");
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(options.applicationImageDigest)) {
    throw new Error("application image digest must be an OCI sha256 digest");
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(options.webImageDigest)) {
    throw new Error("web image digest must be an OCI sha256 digest");
  }
  validateFinalReleaseOptions(options);
  validateOutputOutsideEvidence(options.evidenceDir, options.output);
  const workspace = collectRepository(options.workspaceDir, "helix-workspace");
  const editors = collectRepository(options.editorsDir, "helix-editors");
  const dirtyRepositories = [workspace, editors].filter((repository) => repository.dirty);
  if (dirtyRepositories.length > 0) {
    throw new Error(
      `repository worktree must be clean: ${dirtyRepositories
        .map((repository) => repository.name)
        .join(", ")}`,
    );
  }
  if (options.finalRelease) {
    if (!gitCommitExists(options.editorsDir, options.previousEditorsSha)) {
      throw new Error(
        "HELIX_RELEASE_PREVIOUS_EDITORS_SHA is not a commit in the trusted editor repository",
      );
    }
  }

  const evidence = await collectEvidence(options.evidenceDir);
  const evidenceFiles = evidence.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));
  const evidenceByPath = new Map(evidence.map((entry) => [entry.path, entry]));
  if (typeof dependencies.afterEvidenceSnapshot === "function") {
    await dependencies.afterEvidenceSnapshot();
  }
  const runtimeOptions = { ...options, evidenceByPath };
  const evidencePaths = new Set(evidence.map((entry) => entry.path));
  const missingEvidence = options.requiredEvidence.filter((path) => !evidencePaths.has(path));
  if (missingEvidence.length > 0) {
    throw new Error(`required evidence missing: ${missingEvidence.join(", ")}`);
  }
  if (evidence.length === 0) {
    throw new Error(`evidence directory contains no files: ${options.evidenceDir}`);
  }
  const expectedBinding = {
    workspaceSha: workspace.sha,
    editorsSha: editors.sha,
    applicationImageDigest: options.applicationImageDigest,
    webImageDigest: options.webImageDigest,
    editorsChanged: options.previousEditorsSha !== editors.sha,
  };
  const now = typeof dependencies.now === "function" ? dependencies.now() : new Date();
  const timestamp = canonicalTimestamp(options.finalRelease ? now : (options.timestamp ?? now));
  if (options.finalRelease) {
    for (const [label, path] of [
      ["Mail live evidence", options.mailLiveEvidence],
      ["Drive live evidence", options.driveLiveEvidence],
      ["Chat live evidence", options.chatLiveEvidence],
      ["Agent live evidence", options.agentLiveEvidence],
      ["data-plane live evidence", options.dataPlaneLiveEvidence],
      ["restore drill evidence", options.restoreDrillEvidence],
      ["failure/recovery evidence", options.failureRecoveryEvidence],
      ["DAST evidence", options.dastEvidence],
    ]) {
      if (evidenceByPath.has(path)) {
        validateLiveEvidenceFreshness(
          parseSnapshotJson(evidenceByPath, path, label),
          label,
          timestamp,
        );
      }
    }
  }
  const mailEvidence = await validateRequiredMailEvidence(
    runtimeOptions,
    evidencePaths,
    expectedBinding,
  );
  const agentEvidence = await validateRequiredAgentEvidence(
    runtimeOptions,
    evidencePaths,
    expectedBinding,
  );
  const restoreEvidence = await validateRequiredRestoreEvidence(
    runtimeOptions,
    evidencePaths,
    expectedBinding,
  );
  const chatEvidence = await validateRequiredChatEvidence(
    runtimeOptions,
    evidencePaths,
    expectedBinding,
  );
  const driveEvidence = await validateRequiredDriveEvidence(
    runtimeOptions,
    evidencePaths,
    expectedBinding,
  );
  const dataPlaneEvidence = await validateRequiredDataPlaneEvidence(
    runtimeOptions,
    evidencePaths,
    expectedBinding,
  );
  const failureRecoveryEvidence = await validateRequiredFailureRecoveryEvidence(
    runtimeOptions,
    evidencePaths,
    expectedBinding,
  );
  const dastEvidence = await validateRequiredDastEvidence(
    runtimeOptions,
    evidencePaths,
    expectedBinding,
  );
  const migrationHead = await discoverMigrationHead(options.workspaceDir);
  const finalArtifacts = options.finalRelease
    ? await loadAndValidateFinalArtifacts(
        runtimeOptions,
        evidence,
        evidencePaths,
        expectedBinding,
        migrationHead,
        timestamp,
      )
    : undefined;

  const raw = {
    schemaVersion: 6,
    generatedAt: timestamp,
    release: {
      mode: options.finalRelease ? "final" : "preflight",
      requiredGates: options.finalRelease ? FINAL_RELEASE_GATES : [],
      ...(options.finalRelease
        ? {
            protectedBranch: options.requiredBranch,
            workspaceTag: options.workspaceReleaseTag,
            editorsTag: options.editorsReleaseTag,
            previousEditorsSha: options.previousEditorsSha,
            editorsChanged: expectedBinding.editorsChanged,
          }
        : {}),
    },
    repositories: { workspace, editors },
    runtime: {
      node: process.version,
      pnpm: commandOutput("pnpm", ["--version"], options.workspaceDir),
    },
    deployment: {
      mode:
        finalArtifacts?.productionConfig.mode ?? options.environment.HELIX_MODE ?? "single-tenant",
      securityTier:
        finalArtifacts?.productionConfig.securityTier ??
        options.environment.HELIX_SECURITY_TIER ??
        "personal",
      enabledApps:
        finalArtifacts?.productionConfig.coreApps ??
        csvList(options.environment.HELIX_ENABLED_APPS),
      enabledFeatures:
        finalArtifacts === undefined
          ? csvList(options.environment.HELIX_ENABLED_FEATURES)
          : Object.entries(finalArtifacts.productionConfig.featureControls)
              .filter(([, enabled]) => enabled)
              .map(([name]) => name)
              .sort(),
      disabledSurfaces: finalArtifacts?.productionConfig.disabledSurfaces ?? [],
      images: finalArtifacts?.productionConfig.productionImages ?? {
        application: options.applicationImageDigest,
        web: options.webImageDigest,
      },
    },
    database: {
      migrationHead,
    },
    evidence: {
      root: basename(options.evidenceDir),
      required: [...options.requiredEvidence].sort(),
      files: evidenceFiles,
      ...(mailEvidence === undefined ? {} : { mail: mailEvidence }),
      ...(agentEvidence === undefined ? {} : { agent: agentEvidence }),
      ...(chatEvidence === undefined ? {} : { chat: chatEvidence }),
      ...(restoreEvidence === undefined ? {} : { restore: restoreEvidence }),
      ...(driveEvidence === undefined ? {} : { drive: driveEvidence }),
      ...(dataPlaneEvidence === undefined ? {} : { dataPlane: dataPlaneEvidence }),
      ...(failureRecoveryEvidence === undefined
        ? {}
        : { failureRecovery: failureRecoveryEvidence }),
      ...(dastEvidence === undefined ? {} : { dast: dastEvidence }),
      ...(finalArtifacts === undefined ? {} : finalArtifacts),
    },
  };
  const manifest = redactSensitive(raw);
  await verifyEvidenceSnapshot(options.evidenceDir, evidence);
  return manifest;
}

export async function writeManifestOutput(output, serialized, evidenceDir) {
  validateOutputOutsideEvidence(evidenceDir, output);
  const outputDirectory = dirname(output);
  await mkdir(outputDirectory, { recursive: true });
  const [resolvedEvidenceRoot, resolvedOutputDirectory] = await Promise.all([
    realpath(evidenceDir),
    realpath(outputDirectory),
  ]);
  validateOutputOutsideEvidence(
    resolvedEvidenceRoot,
    resolve(resolvedOutputDirectory, basename(output)),
  );

  const temporaryPath = resolve(
    outputDirectory,
    `.${basename(output)}.${randomUUID()}.release-readiness.tmp`,
  );
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporaryPath, output);
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw new Error("manifest output must not already exist or be a symbolic/hard link");
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
}

export function parseArgs(args, cwd, environment = process.env) {
  const options = {
    workspaceDir: resolve(cwd),
    editorsDir: resolve(cwd, environment.HELIX_EDITORS_DIR ?? "../helix-editors"),
    evidenceDir:
      environment.HELIX_RELEASE_EVIDENCE_DIR === undefined
        ? undefined
        : resolve(cwd, environment.HELIX_RELEASE_EVIDENCE_DIR),
    requiredEvidence: [],
    mailLiveEvidence: undefined,
    agentLiveEvidence: undefined,
    chatLiveEvidence: undefined,
    restoreDrillEvidence: undefined,
    driveLiveEvidence: undefined,
    dataPlaneLiveEvidence: undefined,
    failureRecoveryEvidence: undefined,
    dastEvidence: undefined,
    fullGatesEvidence: undefined,
    migrationStatusEvidence: undefined,
    productionConfigEvidence: undefined,
    sloSoakEvidence: undefined,
    securityReviewEvidence: undefined,
    supportReadinessEvidence: undefined,
    businessReadinessEvidence: undefined,
    protectedRepositoryStateEvidence: undefined,
    productionDecisionEvidence: undefined,
    decisionPublicKey:
      environment.HELIX_RELEASE_TRUSTED_DECISION_PUBLIC_KEY === undefined
        ? undefined
        : resolve(cwd, environment.HELIX_RELEASE_TRUSTED_DECISION_PUBLIC_KEY),
    decisionSignerFingerprint: environment.HELIX_RELEASE_TRUSTED_DECISION_SIGNER_FINGERPRINT,
    gitStatePublicKey:
      environment.HELIX_RELEASE_TRUSTED_GIT_STATE_PUBLIC_KEY === undefined
        ? undefined
        : resolve(cwd, environment.HELIX_RELEASE_TRUSTED_GIT_STATE_PUBLIC_KEY),
    gitStateSignerFingerprint: environment.HELIX_RELEASE_TRUSTED_GIT_STATE_SIGNER_FINGERPRINT,
    gitStateSigner: environment.HELIX_RELEASE_TRUSTED_GIT_STATE_SIGNER,
    fulcioIssuerCertificate:
      environment.HELIX_RELEASE_TRUSTED_FULCIO_ISSUER_CERTIFICATE === undefined
        ? undefined
        : resolve(cwd, environment.HELIX_RELEASE_TRUSTED_FULCIO_ISSUER_CERTIFICATE),
    rekorPublicKey:
      environment.HELIX_RELEASE_TRUSTED_REKOR_PUBLIC_KEY === undefined
        ? undefined
        : resolve(cwd, environment.HELIX_RELEASE_TRUSTED_REKOR_PUBLIC_KEY),
    rekorLogId: environment.HELIX_RELEASE_TRUSTED_REKOR_LOG_ID,
    rekorCheckpointOrigin: environment.HELIX_RELEASE_TRUSTED_REKOR_CHECKPOINT_ORIGIN,
    trustedGithubRepository: environment.HELIX_RELEASE_TRUSTED_GITHUB_REPOSITORY,
    trustedEditorsRepository: environment.HELIX_RELEASE_TRUSTED_EDITORS_REPOSITORY,
    trustedGithubWorkflowIdentity: environment.HELIX_RELEASE_TRUSTED_GITHUB_WORKFLOW_IDENTITY,
    trustedApplicationSubject: environment.HELIX_RELEASE_TRUSTED_APPLICATION_SUBJECT,
    trustedWebSubject: environment.HELIX_RELEASE_TRUSTED_WEB_SUBJECT,
    previousEditorsSha: environment.HELIX_RELEASE_PREVIOUS_EDITORS_SHA,
    requiredBranch: environment.HELIX_RELEASE_REQUIRED_BRANCH ?? "main",
    workspaceReleaseTag: environment.HELIX_RELEASE_WORKSPACE_TAG,
    editorsReleaseTag: environment.HELIX_RELEASE_EDITORS_TAG,
    finalRelease: false,
    requireExternalMailEvidence: false,
    applicationImageDigest:
      environment.HELIX_APPLICATION_IMAGE_DIGEST ?? environment.HELIX_IMAGE_DIGEST,
    webImageDigest: environment.HELIX_WEB_IMAGE_DIGEST,
    output: undefined,
    timestamp: undefined,
    environment,
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--require-external-mail-evidence") {
      options.requireExternalMailEvidence = true;
      continue;
    }
    if (argument === "--final-release") {
      options.finalRelease = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    index += 1;
    switch (argument) {
      case "--workspace-dir":
        options.workspaceDir = resolve(cwd, value);
        break;
      case "--editors-dir":
        options.editorsDir = resolve(cwd, value);
        break;
      case "--evidence-dir":
        options.evidenceDir = resolve(cwd, value);
        break;
      case "--require-evidence":
        options.requiredEvidence.push(normalizeRelativePath(value));
        break;
      case "--mail-live-evidence":
        options.mailLiveEvidence = normalizeRelativePath(value);
        break;
      case "--agent-live-evidence":
        options.agentLiveEvidence = normalizeRelativePath(value);
        break;
      case "--chat-live-evidence":
        options.chatLiveEvidence = normalizeRelativePath(value);
        break;
      case "--restore-drill-evidence":
        options.restoreDrillEvidence = normalizeRelativePath(value);
        break;
      case "--drive-live-evidence":
        options.driveLiveEvidence = normalizeRelativePath(value);
        break;
      case "--data-plane-live-evidence":
        options.dataPlaneLiveEvidence = normalizeRelativePath(value);
        break;
      case "--failure-recovery-evidence":
        options.failureRecoveryEvidence = normalizeRelativePath(value);
        break;
      case "--dast-evidence":
        options.dastEvidence = normalizeRelativePath(value);
        break;
      case "--full-gates-evidence":
        options.fullGatesEvidence = normalizeRelativePath(value);
        break;
      case "--migration-status-evidence":
        options.migrationStatusEvidence = normalizeRelativePath(value);
        break;
      case "--production-config-evidence":
        options.productionConfigEvidence = normalizeRelativePath(value);
        break;
      case "--slo-soak-evidence":
        options.sloSoakEvidence = normalizeRelativePath(value);
        break;
      case "--security-review-evidence":
        options.securityReviewEvidence = normalizeRelativePath(value);
        break;
      case "--support-readiness-evidence":
        options.supportReadinessEvidence = normalizeRelativePath(value);
        break;
      case "--business-readiness-evidence":
        options.businessReadinessEvidence = normalizeRelativePath(value);
        break;
      case "--protected-repository-state-evidence":
        options.protectedRepositoryStateEvidence = normalizeRelativePath(value);
        break;
      case "--production-decision-evidence":
        options.productionDecisionEvidence = normalizeRelativePath(value);
        break;
      case "--image-digest":
      case "--application-image-digest":
        options.applicationImageDigest = value;
        break;
      case "--web-image-digest":
        options.webImageDigest = value;
        break;
      case "--output":
        options.output = resolve(cwd, value);
        break;
      case "--timestamp":
        options.timestamp = value;
        break;
      default:
        throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!options.help && options.evidenceDir === undefined) {
    throw new Error("--evidence-dir or HELIX_RELEASE_EVIDENCE_DIR is required");
  }
  if (options.requireExternalMailEvidence && options.mailLiveEvidence === undefined) {
    throw new Error("--require-external-mail-evidence requires --mail-live-evidence");
  }
  if (options.finalRelease && options.timestamp !== undefined) {
    throw new Error("--timestamp is prohibited in --final-release mode");
  }
  return options;
}

function validateFinalReleaseOptions(options) {
  if (!options.finalRelease) return;
  const required = [
    ["--mail-live-evidence", options.mailLiveEvidence],
    ["--drive-live-evidence", options.driveLiveEvidence],
    ["--chat-live-evidence", options.chatLiveEvidence],
    ["--agent-live-evidence", options.agentLiveEvidence],
    ["--data-plane-live-evidence", options.dataPlaneLiveEvidence],
    ["--restore-drill-evidence", options.restoreDrillEvidence],
    ["--failure-recovery-evidence", options.failureRecoveryEvidence],
    ["--dast-evidence", options.dastEvidence],
    ...FINAL_ARTIFACT_OPTIONS.map(([flag, option]) => [flag, options[option]]),
    ["HELIX_RELEASE_TRUSTED_DECISION_PUBLIC_KEY", options.decisionPublicKey],
    ["HELIX_RELEASE_TRUSTED_DECISION_SIGNER_FINGERPRINT", options.decisionSignerFingerprint],
    ["HELIX_RELEASE_TRUSTED_GIT_STATE_PUBLIC_KEY", options.gitStatePublicKey],
    ["HELIX_RELEASE_TRUSTED_GIT_STATE_SIGNER_FINGERPRINT", options.gitStateSignerFingerprint],
    ["HELIX_RELEASE_TRUSTED_GIT_STATE_SIGNER", options.gitStateSigner],
    ["HELIX_RELEASE_TRUSTED_FULCIO_ISSUER_CERTIFICATE", options.fulcioIssuerCertificate],
    ["HELIX_RELEASE_TRUSTED_REKOR_PUBLIC_KEY", options.rekorPublicKey],
    ["HELIX_RELEASE_TRUSTED_REKOR_LOG_ID", options.rekorLogId],
    ["HELIX_RELEASE_TRUSTED_REKOR_CHECKPOINT_ORIGIN", options.rekorCheckpointOrigin],
    ["HELIX_RELEASE_TRUSTED_GITHUB_REPOSITORY", options.trustedGithubRepository],
    ["HELIX_RELEASE_TRUSTED_EDITORS_REPOSITORY", options.trustedEditorsRepository],
    ["HELIX_RELEASE_TRUSTED_GITHUB_WORKFLOW_IDENTITY", options.trustedGithubWorkflowIdentity],
    ["HELIX_RELEASE_TRUSTED_APPLICATION_SUBJECT", options.trustedApplicationSubject],
    ["HELIX_RELEASE_TRUSTED_WEB_SUBJECT", options.trustedWebSubject],
    ["HELIX_RELEASE_PREVIOUS_EDITORS_SHA", options.previousEditorsSha],
    ["HELIX_RELEASE_WORKSPACE_TAG", options.workspaceReleaseTag],
    ["HELIX_RELEASE_EDITORS_TAG", options.editorsReleaseTag],
  ];
  const missing = required.filter(([, value]) => value === undefined).map(([flag]) => flag);
  if (missing.length > 0) {
    throw new Error(`--final-release requires all release evidence inputs: ${missing.join(", ")}`);
  }
  if (!/^[a-f0-9]{40}$/u.test(options.previousEditorsSha)) {
    throw new Error("HELIX_RELEASE_PREVIOUS_EDITORS_SHA must be a full Git SHA");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(options.requiredBranch)) {
    throw new Error("HELIX_RELEASE_REQUIRED_BRANCH is invalid");
  }
  for (const [label, value] of [
    ["HELIX_RELEASE_WORKSPACE_TAG", options.workspaceReleaseTag],
    ["HELIX_RELEASE_EDITORS_TAG", options.editorsReleaseTag],
  ]) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(value)) {
      throw new Error(`${label} is invalid`);
    }
  }
}

async function loadAndValidateFinalArtifacts(
  options,
  evidence,
  evidencePaths,
  expectedBinding,
  migrationHead,
  timestamp,
) {
  const reports = {};
  for (const [, option, name] of FINAL_ARTIFACT_OPTIONS) {
    const path = options[option];
    if (!evidencePaths.has(path))
      throw new Error(`required final-release evidence missing: ${path}`);
    try {
      reports[name] = parseSnapshotJson(
        options.evidenceByPath,
        path,
        `${name} final-release evidence`,
      );
    } catch (error) {
      throw new Error(`invalid ${name} final-release evidence: ${errorMessage(error)}`);
    }
  }
  const decisionInputs = evidence
    .map(({ path }) => path)
    .filter((path) => path !== options.productionDecisionEvidence)
    .sort();
  const hashes = new Map(evidence.map((entry) => [entry.path, entry.sha256]));
  const evidenceSetSha256 = evidenceSetDigest(
    decisionInputs.map((path) => ({
      path,
      sha256: `sha256:${hashes.get(path)}`,
    })),
  );
  let summaries;
  try {
    summaries = await validateFinalReleaseArtifacts({
      reports,
      expectedBinding,
      migrationHead,
      decisionPublicKeyPath: options.decisionPublicKey,
      decisionSignerFingerprint: options.decisionSignerFingerprint,
      provenanceTrust: {
        fulcioIssuerCertificatePath: options.fulcioIssuerCertificate,
        rekorPublicKeyPath: options.rekorPublicKey,
        rekorLogId: options.rekorLogId,
        rekorCheckpointOrigin: options.rekorCheckpointOrigin,
        repository: options.trustedGithubRepository,
        editorsRepository: options.trustedEditorsRepository,
        workflowIdentity: options.trustedGithubWorkflowIdentity,
        sourceRef: `refs/heads/${options.requiredBranch}`,
        subjectNames: {
          application: options.trustedApplicationSubject,
          web: options.trustedWebSubject,
        },
      },
      protectedStateTrust: {
        publicKeyPath: options.gitStatePublicKey,
        signerFingerprint: options.gitStateSignerFingerprint,
        signer: options.gitStateSigner,
      },
      expectedRepositoryState: {
        branch: options.requiredBranch,
        workspaceTag: options.workspaceReleaseTag,
        editorsTag: options.editorsReleaseTag,
        repositories: {
          workspace: options.trustedGithubRepository,
          editors: options.trustedEditorsRepository,
        },
      },
      generatedAt: timestamp,
      evidenceSetSha256,
      availableEvidence: new Map(
        evidence.map(({ path, sha256, content }) => [
          path,
          { sha256: `sha256:${sha256}`, content },
        ]),
      ),
    });
  } catch (error) {
    throw new Error(`invalid final-release supporting evidence: ${errorMessage(error)}`);
  }
  return Object.fromEntries(
    FINAL_ARTIFACT_OPTIONS.map(([, option, name]) => [
      name,
      { path: options[option], ...summaries[name] },
    ]),
  );
}

function validateExpectedReleaseBinding(evidence, options, expected, label) {
  if (evidence.releaseBinding === undefined) {
    if (options.finalRelease) {
      throw new Error(`${label} is missing its required release binding`);
    }
    return;
  }
  try {
    validateReleaseEvidenceBinding(evidence.releaseBinding, expected);
  } catch (error) {
    throw new Error(`${label} release binding is invalid: ${errorMessage(error)}`);
  }
}

async function validateRequiredDriveEvidence(options, evidencePaths, expectedBinding) {
  if (options.driveLiveEvidence === undefined) return undefined;
  requireRetainedEvidence(evidencePaths, options.driveLiveEvidence, "Drive live evidence");
  const evidence = withFailurePrefix("invalid or incomplete Drive live evidence", () =>
    validateDriveEvidence(
      parseSnapshotJson(options.evidenceByPath, options.driveLiveEvidence, "Drive live evidence"),
      { requirePass: true },
    ),
  );
  validateExpectedReleaseBinding(evidence, options, expectedBinding, "Drive live evidence");
  return {
    path: options.driveLiveEvidence,
    status: evidence.status,
    durationMs: evidence.durationMs,
    cases: DRIVE_EVIDENCE_CASES.map((name) => {
      const result = evidence.cases.find((entry) => entry.name === name);
      return {
        name,
        status: result.status,
        durationMs: result.durationMs,
        metrics: result.metrics,
      };
    }),
  };
}

async function validateRequiredDataPlaneEvidence(options, evidencePaths, expectedBinding) {
  if (options.dataPlaneLiveEvidence === undefined) return undefined;
  requireRetainedEvidence(evidencePaths, options.dataPlaneLiveEvidence, "data-plane live evidence");
  const evidence = withFailurePrefix("invalid or incomplete data-plane live evidence", () =>
    validateDataPlaneEvidence(
      parseSnapshotJson(
        options.evidenceByPath,
        options.dataPlaneLiveEvidence,
        "data-plane live evidence",
      ),
      true,
    ),
  );
  validateExpectedReleaseBinding(evidence, options, expectedBinding, "data-plane live evidence");
  return {
    path: options.dataPlaneLiveEvidence,
    status: evidence.status,
    durationMs: elapsedMilliseconds(evidence.startedAt, evidence.completedAt),
    scenarios: DATA_PLANE_SCENARIOS.map((name) => ({
      name,
      status: evidence.scenarios[name].status,
      durationMs: evidence.scenarios[name].durationMs,
    })),
  };
}

async function validateRequiredFailureRecoveryEvidence(options, evidencePaths, expectedBinding) {
  if (options.failureRecoveryEvidence === undefined) return undefined;
  requireRetainedEvidence(
    evidencePaths,
    options.failureRecoveryEvidence,
    "failure/recovery evidence",
  );
  const evidence = withFailurePrefix("invalid or incomplete failure/recovery evidence", () =>
    validateFailureRecoveryEvidence(
      parseSnapshotJson(
        options.evidenceByPath,
        options.failureRecoveryEvidence,
        "failure/recovery evidence",
      ),
      { requirePass: true },
    ),
  );
  validateExpectedReleaseBinding(evidence, options, expectedBinding, "failure/recovery evidence");
  return {
    path: options.failureRecoveryEvidence,
    status: evidence.status,
    durationMs: elapsedMilliseconds(evidence.startedAt, evidence.completedAt),
    scenarios: FAILURE_RECOVERY_SCENARIOS.map(({ id }) => {
      const observation = evidence.scenarios[id];
      return {
        name: id,
        status: observation.status,
        durationMs: elapsedMilliseconds(observation.startedAt, observation.completedAt),
        faultToRecoveryMs: elapsedMilliseconds(
          observation.faultInjectedAt,
          observation.recoveredAt,
        ),
        faultInjectionCount: observation.faultInjection.count,
        logicalOperationCount: observation.assertions.noDuplicates.logicalOperationCount,
        attemptCount: observation.assertions.noDuplicates.attemptCount,
        sideEffectCount: observation.assertions.noDuplicates.sideEffectCount,
        duplicateCount: observation.assertions.noDuplicates.duplicateCount,
        alertCount: observation.assertions.alert.rules.length,
      };
    }),
  };
}

async function validateRequiredDastEvidence(options, evidencePaths, expectedBinding) {
  if (options.dastEvidence === undefined) return undefined;
  requireRetainedEvidence(evidencePaths, options.dastEvidence, "V5 DAST evidence");
  const evidence = withFailurePrefix("invalid or incomplete V5 DAST evidence", () =>
    validateDastEvidence(
      parseSnapshotJson(options.evidenceByPath, options.dastEvidence, "DAST evidence"),
      {
        requirePass: true,
        expectedBinding,
      },
    ),
  );
  return {
    path: options.dastEvidence,
    status: evidence.status,
    durationMs: evidence.durationMs,
    scannerImage: evidence.scanner.image,
    targetKind: evidence.target.kind,
    summary: evidence.summary,
    dispositions: evidence.dispositions.length,
  };
}

async function validateRequiredChatEvidence(options, evidencePaths, expectedBinding) {
  if (options.chatLiveEvidence === undefined) return undefined;
  requireRetainedEvidence(evidencePaths, options.chatLiveEvidence, "Chat live evidence");
  const evidence = withFailurePrefix("invalid or incomplete Chat live evidence", () =>
    validateChatLiveEvidence(
      parseSnapshotJson(options.evidenceByPath, options.chatLiveEvidence, "Chat live evidence"),
      {
        requirePass: true,
        requireReleaseLoad: true,
      },
    ),
  );
  validateExpectedReleaseBinding(evidence, options, expectedBinding, "Chat live evidence");
  const load = evidence.scenarios.pilot_load.evidence;
  return {
    path: options.chatLiveEvidence,
    status: evidence.status,
    profile: {
      users: load.actualUsers,
      sockets: load.actualSockets,
      durationSeconds: load.durationSeconds,
      p95LatencyMs: load.p95LatencyMs,
      p99LatencyMs: load.p99LatencyMs,
      errorRate: load.errorRate,
      memoryGrowthBytes: load.memoryGrowthBytes,
      eventLoopLagPeakMs: load.eventLoopLagPeakMs,
      dbPoolPendingPeak: load.dbPoolPendingPeak,
      redisBacklogPeak: load.redisBacklogPeak,
      natsBacklogPeak: load.natsBacklogPeak,
    },
    scenarios: CHAT_LIVE_SCENARIOS.map((scenario) => ({
      name: scenario,
      status: evidence.scenarios[scenario].status,
    })),
  };
}

async function validateRequiredRestoreEvidence(options, evidencePaths, expectedBinding) {
  if (options.restoreDrillEvidence === undefined) return undefined;
  requireRetainedEvidence(evidencePaths, options.restoreDrillEvidence, "restore drill evidence");
  const evidence = withFailurePrefix("invalid restore drill evidence", () =>
    validateRestoreDrillEvidence(
      parseSnapshotJson(
        options.evidenceByPath,
        options.restoreDrillEvidence,
        "restore drill evidence",
      ),
    ),
  );
  const incomplete = RESTORE_DRILL_SCENARIOS.filter(
    (scenario) => evidence.scenarios[scenario].status !== "passed",
  );
  if (evidence.mode !== "live" || evidence.status !== "passed" || incomplete.length > 0) {
    throw new Error(
      `restore drill evidence is incomplete: ${incomplete.join(", ") || evidence.status}`,
    );
  }
  validateExpectedReleaseBinding(evidence, options, expectedBinding, "restore drill evidence");
  return {
    path: options.restoreDrillEvidence,
    status: evidence.status,
    rpoHours: evidence.metrics.rpoHours,
    rtoHours: evidence.metrics.rtoHours,
    scenarios: RESTORE_DRILL_SCENARIOS.map((scenario) => ({
      name: scenario,
      status: evidence.scenarios[scenario].status,
    })),
  };
}

async function validateRequiredAgentEvidence(options, evidencePaths, expectedBinding) {
  if (options.agentLiveEvidence === undefined) return undefined;
  requireRetainedEvidence(evidencePaths, options.agentLiveEvidence, "Agent live evidence");
  const evidence = withFailurePrefix("invalid Agent live evidence", () =>
    validateAgentLiveEvidence(
      parseSnapshotJson(options.evidenceByPath, options.agentLiveEvidence, "Agent live evidence"),
    ),
  );
  const incomplete = AGENT_LIVE_SCENARIOS.filter(
    (scenario) => evidence.scenarios[scenario].status !== "passed",
  );
  if (evidence.mode !== "live" || evidence.status !== "passed" || incomplete.length > 0) {
    throw new Error(
      `Agent live evidence is incomplete: ${incomplete.join(", ") || evidence.status}`,
    );
  }
  validateExpectedReleaseBinding(evidence, options, expectedBinding, "Agent live evidence");
  return {
    path: options.agentLiveEvidence,
    status: evidence.status,
    scenarios: AGENT_LIVE_SCENARIOS.map((scenario) => ({
      name: scenario,
      status: evidence.scenarios[scenario].status,
    })),
  };
}

async function validateRequiredMailEvidence(options, evidencePaths, expectedBinding) {
  if (options.mailLiveEvidence === undefined) return undefined;
  requireRetainedEvidence(evidencePaths, options.mailLiveEvidence, "Mail live evidence");
  const evidence = withFailurePrefix("invalid Mail live evidence", () =>
    validateMailLiveEvidence(
      parseSnapshotJson(options.evidenceByPath, options.mailLiveEvidence, "Mail live evidence"),
    ),
  );
  const failedLocal = MAIL_LIVE_SCENARIOS.filter(
    (scenario) => evidence.local[scenario].status !== "passed",
  );
  if (evidence.mode !== "local" || evidence.status !== "passed" || failedLocal.length > 0) {
    throw new Error(
      `Mail live evidence is incomplete: ${failedLocal.join(", ") || evidence.status}`,
    );
  }
  if (options.requireExternalMailEvidence || options.finalRelease) {
    const incompleteExternal = MAIL_EXTERNAL_TARGETS.filter(
      (target) => evidence.external[target].status !== "passed",
    );
    if (incompleteExternal.length > 0) {
      throw new Error(`external Mail evidence is incomplete: ${incompleteExternal.join(", ")}`);
    }
  }
  validateExpectedReleaseBinding(evidence, options, expectedBinding, "Mail live evidence");
  return {
    path: options.mailLiveEvidence,
    status: evidence.status,
    local: Object.fromEntries(
      MAIL_LIVE_SCENARIOS.map((scenario) => [scenario, evidence.local[scenario].status]),
    ),
    external: Object.fromEntries(
      MAIL_EXTERNAL_TARGETS.map((target) => [target, evidence.external[target].status]),
    ),
  };
}

export function redactSensitive(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitive(entry));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        SENSITIVE_KEY_PATTERN.test(key) ? "[REDACTED]" : redactSensitive(entry),
      ]),
    );
  }
  return value;
}

function collectRepository(directory, name) {
  const sha = commandOutput("git", ["rev-parse", "HEAD"], directory);
  const branch = commandOutput("git", ["rev-parse", "--abbrev-ref", "HEAD"], directory);
  const porcelain = commandOutput(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    directory,
  );
  return {
    name,
    sha,
    branch,
    dirty: porcelain.length > 0,
  };
}

function validateOutputOutsideEvidence(evidenceDir, output) {
  if (output === undefined) return;
  const evidenceRoot = resolve(evidenceDir);
  const outputPath = resolve(output);
  const pathFromEvidence = relative(evidenceRoot, outputPath);
  if (
    pathFromEvidence === "" ||
    (pathFromEvidence !== ".." && !pathFromEvidence.startsWith(`..${sep}`))
  ) {
    throw new Error("manifest output must be outside the source evidence directory");
  }
}

async function collectEvidence(root) {
  const rootStat = await lstat(root).catch(() => null);
  if (rootStat === null || !rootStat.isDirectory()) {
    throw new Error(`evidence directory does not exist: ${root}`);
  }
  const files = [];
  await walk(root, async (absolutePath) => {
    const bytes = await readFile(absolutePath);
    files.push({
      path: normalizeRelativePath(relative(root, absolutePath)),
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      content: bytes,
    });
  });
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function verifyEvidenceSnapshot(root, expected) {
  const current = await collectEvidence(root);
  const changed =
    current.length !== expected.length ||
    current.some(
      (entry, index) =>
        entry.path !== expected[index].path ||
        entry.bytes !== expected[index].bytes ||
        entry.sha256 !== expected[index].sha256,
    );
  if (changed) {
    throw new Error("source evidence changed while the release packet was being validated");
  }
}

async function walk(directory, visit) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(path, visit);
    } else if (entry.isFile()) {
      await visit(path);
    } else {
      throw new Error(`evidence directory contains a symbolic link or non-file entry: ${path}`);
    }
  }
}

async function discoverMigrationHead(workspaceDir) {
  const migrationDir = resolve(workspaceDir, "apps/helix/src/db/migrations");
  const entries = await readdir(migrationDir);
  const migrations = entries
    .filter((entry) => /^\d+_.+\.sql$/u.test(entry))
    .sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
  const head = migrations.at(-1);
  if (head === undefined) {
    throw new Error(`no SQL migrations found in ${migrationDir}`);
  }
  return head;
}

function commandOutput(command, args, cwd) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const detail =
      error !== null && typeof error === "object" && "stderr" in error
        ? String(error.stderr).trim()
        : "";
    throw new Error(
      `command failed in ${cwd}: ${command} ${args.join(" ")}${detail.length > 0 ? ` (${detail})` : ""}`,
    );
  }
}

function csvList(value) {
  if (value === undefined) {
    return [];
  }
  return [
    ...new Set(
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ].sort();
}

function normalizeRelativePath(value) {
  const normalized = value.split(sep).join("/");
  const segments = normalized.split("/");
  if (
    normalized.length === 0 ||
    normalized.length > 512 ||
    normalized.startsWith("/") ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(normalized)
  ) {
    throw new Error(`evidence path must be relative and stay inside the evidence root: ${value}`);
  }
  return normalized;
}

function canonicalTimestamp(value) {
  const date = toDate(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`invalid timestamp: ${value}`);
  }
  return date.toISOString();
}

function toDate(value) {
  if (value instanceof Date) return value;
  if (value === undefined) return new Date();
  return new Date(value);
}

function parseSnapshotJson(evidenceByPath, path, label) {
  const snapshot = evidenceByPath.get(path);
  if (snapshot === undefined) {
    throw new Error(`${label} is not retained in the immutable evidence snapshot`);
  }
  try {
    return JSON.parse(snapshot.content.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${errorMessage(error)}`);
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function requireRetainedEvidence(evidencePaths, path, label) {
  if (!evidencePaths.has(path)) {
    throw new Error(`required ${label} missing: ${path}`);
  }
}

// Every gate validator reports its own failure with a stable, gate-specific
// prefix so operators can tell which release evidence rejected the packet.
function withFailurePrefix(prefix, validate) {
  try {
    return validate();
  } catch (error) {
    throw new Error(`${prefix}: ${errorMessage(error)}`);
  }
}

function validateLiveEvidenceFreshness(evidence, label, manifestTimestamp) {
  const timestamp = evidence.generatedAt ?? evidence.completedAt;
  if (typeof timestamp !== "string") {
    throw new Error(`${label} must contain generatedAt or completedAt`);
  }
  const completed = new Date(timestamp);
  if (!Number.isFinite(completed.getTime()) || completed.toISOString() !== timestamp) {
    throw new Error(`${label} completion must be a canonical ISO-8601 timestamp`);
  }
  const manifest = new Date(manifestTimestamp);
  const age = manifest.getTime() - completed.getTime();
  if (age < 0) throw new Error(`${label} cannot be generated in the future`);
  if (age > 7 * 24 * 60 * 60 * 1_000) {
    throw new Error(`${label} is stale for final release`);
  }
}

function gitCommitExists(directory, sha) {
  return commandSucceeds("git", ["cat-file", "-e", `${sha}^{commit}`], directory);
}

function commandSucceeds(command, args, cwd) {
  try {
    execFileSync(command, args, { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function elapsedMilliseconds(startedAt, completedAt) {
  return Date.parse(completedAt) - Date.parse(startedAt);
}

function isMain() {
  return (
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  );
}
