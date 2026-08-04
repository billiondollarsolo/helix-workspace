import {
  ARTIFACT_SCHEMAS,
  REQUIRED_EDITORS_GATES,
  REQUIRED_WORKSPACE_GATES,
} from "./constants.mjs";
import { validateArtifactReference } from "./retained-artifacts.mjs";
import {
  exactKeys,
  exactObject,
  freshTimestamp,
  hash,
  isoDate,
  nonEmptyString,
  notAfter,
  object,
  orderedWindow,
  owner,
  passed,
  truth,
} from "./validation-primitives.mjs";

// Gate runs and migration deployments must both be from the last day.
const GATE_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export function validateFullGates(report, expectedBinding, artifactContext, referenceTime) {
  exactKeys(report, [
    "schema",
    "generatedAt",
    "releaseBinding",
    "status",
    "implementationTasksComplete",
    "reviewedPullRequestsMerged",
    "workspace",
    "editors",
  ]);
  passed(report.status, "full-gates status");
  truth(report.implementationTasksComplete, "implementation tasks");
  truth(report.reviewedPullRequestsMerged, "reviewed pull requests");
  validateGateGroup(
    report.workspace,
    REQUIRED_WORKSPACE_GATES,
    "workspace",
    expectedBinding.workspaceSha,
    report.generatedAt,
    artifactContext,
    referenceTime,
  );
  object(report.editors, "editors gates");
  exactKeys(report.editors, ["changed", "revision", "commands"]);
  if (typeof report.editors.changed !== "boolean") {
    throw new Error("editors.changed must be boolean");
  }
  if (report.editors.changed !== expectedBinding.editorsChanged) {
    throw new Error("editors.changed does not match the trusted previous release revision");
  }
  if (report.editors.revision !== expectedBinding.editorsSha) {
    throw new Error("editors gate revision does not match the promoted release");
  }
  if (report.editors.changed) {
    validateGateCommands(
      report.editors.commands,
      REQUIRED_EDITORS_GATES,
      "editors",
      report.generatedAt,
      artifactContext,
      referenceTime,
      expectedBinding.editorsSha,
    );
  } else if (!Array.isArray(report.editors.commands) || report.editors.commands.length !== 0) {
    throw new Error("unchanged editors evidence must contain an empty commands array");
  }
  return {
    status: report.status,
    workspaceGateCount: report.workspace.commands.length,
    editorsChanged: report.editors.changed,
    editorsGateCount: report.editors.commands.length,
  };
}

function validateGateGroup(
  group,
  required,
  label,
  expectedRevision,
  generatedAt,
  artifactContext,
  referenceTime,
) {
  object(group, `${label} gates`);
  exactKeys(group, ["revision", "commands"]);
  if (!/^[a-f0-9]{40}$/u.test(group.revision)) {
    throw new Error(`${label} gate revision must be a Git SHA`);
  }
  if (group.revision !== expectedRevision) {
    throw new Error(`${label} gate revision does not match the promoted release`);
  }
  validateGateCommands(
    group.commands,
    required,
    label,
    generatedAt,
    artifactContext,
    referenceTime,
    expectedRevision,
  );
}

function validateGateCommands(
  commands,
  required,
  label,
  generatedAt,
  artifactContext,
  referenceTime,
  expectedRevision,
) {
  if (!Array.isArray(commands)) throw new Error(`${label} commands must be an array`);
  const byCommand = new Map();
  for (const result of commands) {
    object(result, `${label} command result`);
    exactKeys(result, ["command", "status", "startedAt", "completedAt", "report"]);
    nonEmptyString(result.command, `${label} command`);
    if (byCommand.has(result.command)) throw new Error(`${label} gate command is duplicated`);
    passed(result.status, `${label} command ${result.command}`);
    orderedWindow(result.startedAt, result.completedAt, `${label} command ${result.command}`);
    notAfter(result.completedAt, generatedAt, `${label} command completion`);
    freshTimestamp(
      result.completedAt,
      referenceTime,
      GATE_EVIDENCE_MAX_AGE_MS,
      `${label} command completion`,
    );
    validateArtifactReference(
      result.report,
      ARTIFACT_SCHEMAS.commandReport,
      `${label} command ${result.command} report`,
      artifactContext,
      {
        command: result.command,
        revision: expectedRevision,
        completedAt: result.completedAt,
      },
    );
    byCommand.set(result.command, result);
  }
  const missing = required.filter((command) => !byCommand.has(command));
  const extra = [...byCommand.keys()].filter((command) => !required.includes(command));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`${label} gate commands do not match the required V6 command set`);
  }
}

export function validateMigration(
  report,
  migrationHead,
  expectedBinding,
  artifactContext,
  referenceTime,
) {
  exactKeys(report, [
    "schema",
    "generatedAt",
    "releaseBinding",
    "status",
    "migrationHead",
    "deployedAt",
    "environmentSha256",
    "migrator",
    "rollbackPlan",
  ]);
  if (report.status !== "deployed") throw new Error("migration status must be deployed");
  if (report.migrationHead !== migrationHead) {
    throw new Error("deployed migration head does not match the repository migration head");
  }
  isoDate(report.deployedAt, "migration deployedAt");
  notAfter(report.deployedAt, report.generatedAt, "migration deployment");
  freshTimestamp(
    report.deployedAt,
    referenceTime,
    GATE_EVIDENCE_MAX_AGE_MS,
    "migration deployment",
  );
  hash(report.environmentSha256, "migration environment digest");
  exactObject(report.migrator, ["replicas", "advisoryLock", "completedAt"], "migrator");
  if (report.migrator.replicas !== 1 || report.migrator.advisoryLock !== true) {
    throw new Error("migration must use one completed advisory-locked migrator");
  }
  isoDate(report.migrator.completedAt, "migrator completedAt");
  notAfter(report.migrator.completedAt, report.generatedAt, "migrator completion");
  freshTimestamp(
    report.migrator.completedAt,
    referenceTime,
    GATE_EVIDENCE_MAX_AGE_MS,
    "migrator completion",
  );
  exactObject(report.rollbackPlan, ["status", "owner", "approvedAt", "artifact"], "rollback plan");
  if (report.rollbackPlan.status !== "approved") throw new Error("rollback plan is not approved");
  owner(report.rollbackPlan.owner, "rollback plan owner");
  isoDate(report.rollbackPlan.approvedAt, "rollback plan approvedAt");
  notAfter(report.rollbackPlan.approvedAt, report.generatedAt, "rollback approval");
  validateArtifactReference(
    report.rollbackPlan.artifact,
    ARTIFACT_SCHEMAS.rollbackPlan,
    "rollback plan artifact",
    artifactContext,
    { releaseBinding: expectedBinding, role: "migration-rollback-plan" },
  );
  return {
    status: report.status,
    migrationHead: report.migrationHead,
    deployedAt: report.deployedAt,
  };
}
