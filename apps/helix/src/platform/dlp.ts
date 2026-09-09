import type { Actor } from "@helix/sdk-types";
import type { SecurityPoliciesStore, SecurityPolicyRecord } from "./admin/security-policies.js";
import type { DataClassification, ResourceClassificationService } from "./ai/index.js";
import { sensitivityLabelFor } from "./ai/index.js";

export const dlpBoundaries = [
  "mail_send",
  "drive_upload",
  "drive_share",
  "drive_download",
  "chat_message",
  "chat_attachment",
  "copy_export",
  "api_agent",
  "external_guest",
] as const;

export type DlpBoundary = (typeof dlpBoundaries)[number];
export type DlpDetector = "pii" | "credentials" | "credit_card" | "source_code";
export type DlpAction = "allow" | "audit" | "warn" | "quarantine" | "block";

export interface DlpResourceRef {
  readonly resourceType: string;
  readonly resourceId: string;
}

export interface DlpEvaluationInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly boundary: DlpBoundary;
  readonly content?: unknown;
  readonly resources?: readonly DlpResourceRef[];
  readonly acknowledged?: boolean;
  readonly scanIncomplete?: boolean;
  readonly traceId?: string;
}

export interface DlpFinding {
  readonly detector: DlpDetector | "classification" | "scan_limit";
  readonly classification: "confidential" | "restricted";
}

export interface DlpDecision {
  readonly action: DlpAction;
  readonly boundary: DlpBoundary;
  readonly classification: DataClassification;
  readonly findings: readonly DlpFinding[];
  readonly acknowledged: boolean;
}

export interface DlpGuard {
  evaluate(input: DlpEvaluationInput): Promise<DlpDecision>;
}

export interface DlpAuditSink {
  append(record: {
    readonly orgId: string;
    readonly actorId: string;
    readonly verb: string;
    readonly objectType: string;
    readonly metadata?: Record<string, unknown>;
    readonly trace?: { readonly traceId?: string };
  }): Promise<unknown>;
}

const MAX_SCAN_BYTES = 256 * 1024;
const classificationRank: Record<DataClassification, number> = {
  public: 0,
  standard: 1,
  confidential: 2,
  restricted: 3,
};

/** One tenant-policy-backed detector/evaluator shared by every egress adapter. */
export class TenantDlpGuard implements DlpGuard {
  constructor(
    private readonly policies: Pick<SecurityPoliciesStore, "get">,
    private readonly classifications: Pick<ResourceClassificationService, "get" | "classify">,
    private readonly audit: DlpAuditSink,
  ) {}

  async evaluate(input: DlpEvaluationInput): Promise<DlpDecision> {
    const policy = await this.policies.get(input.orgId, "dlp");
    const settings = dlpSettings(policy);
    const boundaryEnabled = settings?.boundaries.has(input.boundary) === true;
    const findings: DlpFinding[] = [];
    if (boundaryEnabled) {
      const scanned = boundedText(input.content);
      findings.push(...detectDlp(scanned.text, settings.detectors));
      if (scanned.truncated || input.scanIncomplete === true) {
        findings.push({ detector: "scan_limit", classification: "restricted" });
      }
    }
    let labelAction: DlpAction = "allow";
    for (const resource of input.resources ?? []) {
      const stored = await this.classifications.get({
        orgId: input.orgId,
        resourceType: resource.resourceType,
        resourceId: resource.resourceId,
      });
      if (stored?.classification === "confidential" || stored?.classification === "restricted") {
        findings.push({ detector: "classification", classification: stored.classification });
        labelAction = stricterAction(
          labelAction,
          sensitivityLabelFor(stored.classification).boundaryActions[input.boundary] ?? "allow",
        );
      }
    }
    const uniqueFindings = dedupeFindings(findings);
    if (uniqueFindings.length === 0 || (labelAction === "allow" && !boundaryEnabled)) {
      return decision(input, "allow", "standard", []);
    }

    const classification = uniqueFindings.reduce<DataClassification>(
      (highest, finding) =>
        classificationRank[finding.classification] > classificationRank[highest]
          ? finding.classification
          : highest,
      "standard",
    );
    const result = decision(
      input,
      stricterAction(labelAction, boundaryEnabled ? settings.action : "allow"),
      classification,
      uniqueFindings,
    );
    if (uniqueFindings.some((finding) => finding.detector !== "classification")) {
      await Promise.all(
        (input.resources ?? []).map((resource) =>
          this.classifications.classify({
            orgId: input.orgId,
            actorId: input.actorId,
            resourceType: resource.resourceType,
            resourceId: resource.resourceId,
            derivation: { explicit: classification },
          }),
        ),
      );
    }
    await this.audit.append({
      orgId: input.orgId,
      actorId: input.actorId,
      verb: `dlp.${result.action}`,
      objectType: "dlp_decision",
      metadata: {
        boundary: input.boundary,
        classification,
        detectors: uniqueFindings.map((finding) => finding.detector),
        sensitivityLabel: uniqueFindings.some((finding) => finding.detector === "classification"),
        acknowledged: result.acknowledged,
      },
      ...(input.traceId === undefined ? {} : { trace: { traceId: input.traceId } }),
    });
    return result;
  }
}

const actionRank: Record<DlpAction, number> = {
  allow: 0,
  audit: 1,
  warn: 2,
  quarantine: 3,
  block: 4,
};

function stricterAction(left: DlpAction, right: DlpAction): DlpAction {
  return actionRank[left] >= actionRank[right] ? left : right;
}

interface EffectiveDlpSettings {
  readonly action: Exclude<DlpAction, "allow">;
  readonly detectors: ReadonlySet<DlpDetector>;
  readonly boundaries: ReadonlySet<DlpBoundary>;
}

function dlpSettings(policy: SecurityPolicyRecord | null): EffectiveDlpSettings | null {
  if (policy?.enabled !== true || policy.enforcement === "disabled") return null;
  const configuredAction = policy.settings.action;
  const action =
    configuredAction === "audit" ||
    configuredAction === "warn" ||
    configuredAction === "quarantine" ||
    configuredAction === "block"
      ? configuredAction
      : "block";
  const detectors = new Set(
    Array.isArray(policy.settings.detectors)
      ? policy.settings.detectors.filter(isDlpDetector)
      : (["pii", "credentials", "credit_card"] satisfies DlpDetector[]),
  );
  const configuredBoundaries = Array.isArray(policy.settings.boundaries)
    ? policy.settings.boundaries.filter(isDlpBoundary)
    : [...dlpBoundaries];
  return { action, detectors, boundaries: new Set(configuredBoundaries) };
}

function isDlpDetector(value: unknown): value is DlpDetector {
  return (
    value === "pii" || value === "credentials" || value === "credit_card" || value === "source_code"
  );
}

function isDlpBoundary(value: unknown): value is DlpBoundary {
  return typeof value === "string" && (dlpBoundaries as readonly string[]).includes(value);
}

function decision(
  input: DlpEvaluationInput,
  action: DlpAction,
  classification: DataClassification,
  findings: readonly DlpFinding[],
): DlpDecision {
  return {
    action,
    boundary: input.boundary,
    classification,
    findings,
    acknowledged: input.acknowledged === true,
  };
}

function detectDlp(text: string, enabled: ReadonlySet<DlpDetector>): DlpFinding[] {
  const findings: DlpFinding[] = [];
  if (enabled.has("pii") && /\b\d{3}-\d{2}-\d{4}\b/u.test(text)) {
    findings.push({ detector: "pii", classification: "confidential" });
  }
  if (
    enabled.has("credentials") &&
    /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\b(?:api[_-]?key|secret)[ \t]*[:=][ \t]*[A-Za-z0-9_-]{12,})/iu.test(
      text,
    )
  ) {
    findings.push({ detector: "credentials", classification: "restricted" });
  }
  if (enabled.has("credit_card") && paymentCardNumbers(text).some(luhnValid)) {
    findings.push({ detector: "credit_card", classification: "confidential" });
  }
  if (
    enabled.has("source_code") &&
    /(?:\b(?:class|function|interface)\s+[A-Za-z_$][\w$]*\b|\b(?:SELECT|INSERT|UPDATE|DELETE)\s+.+\s+FROM\b)/iu.test(
      text,
    )
  ) {
    findings.push({ detector: "source_code", classification: "confidential" });
  }
  return findings;
}

function paymentCardNumbers(text: string): string[] {
  return [...text.matchAll(/\b(?:\d[ -]?){13,19}\b/gu)]
    .map((match) => match[0].replace(/[^0-9]/gu, ""))
    .filter((value) => value.length >= 13 && value.length <= 19);
}

function luhnValid(value: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    let digit = Number(value[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function boundedText(value: unknown): { readonly text: string; readonly truncated: boolean } {
  const chunks: string[] = [];
  let bytes = 0;
  let truncated = false;
  const visit = (candidate: unknown): void => {
    if (truncated || candidate === null || candidate === undefined) return;
    if (typeof candidate === "string" || candidate instanceof Uint8Array) {
      const text =
        typeof candidate === "string" ? candidate : Buffer.from(candidate).toString("utf8");
      const remaining = MAX_SCAN_BYTES - bytes;
      if (Buffer.byteLength(text) > remaining) {
        chunks.push(Buffer.from(text).subarray(0, Math.max(0, remaining)).toString("utf8"));
        truncated = true;
        return;
      }
      chunks.push(text);
      bytes += Buffer.byteLength(text);
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (typeof candidate === "object") {
      for (const item of Object.values(candidate)) visit(item);
    }
  };
  visit(value);
  return { text: chunks.join("\n"), truncated };
}

function dedupeFindings(findings: readonly DlpFinding[]): DlpFinding[] {
  return [
    ...new Map(
      findings.map((finding) => [`${finding.detector}:${finding.classification}`, finding]),
    ).values(),
  ];
}

export interface DlpToolInvocation {
  readonly boundary: DlpBoundary;
  readonly content: unknown;
  readonly resources: readonly DlpResourceRef[];
}

/** Maps every tool/API egress to the shared evaluator without product-specific rules. */
export function dlpToolInvocation(
  toolId: string,
  input: unknown,
  actor: Pick<Actor, "type">,
): DlpToolInvocation | null {
  const object = objectInput(input);
  if (actor.type === "agent" || actor.type === "service_account") {
    return {
      boundary: "api_agent",
      content: input,
      resources: [
        ...resourceRefs(toolId, object),
        ...driveAttachments(object.attachments),
        ...stringArray(object.attachmentObjectIds).map((resourceId) => ({
          resourceType: "drive.file",
          resourceId,
        })),
      ],
    };
  }
  if (toolId === "mail.send" || toolId === "mail.reply") {
    return {
      boundary: "mail_send",
      content: input,
      resources: driveAttachments(object.attachments),
    };
  }
  if (
    toolId === "drive.upload" ||
    toolId === "drive.finalize" ||
    toolId === "drive.upload.complete"
  ) {
    return { boundary: "drive_upload", content: input, resources: resourceRefs(toolId, object) };
  }
  if (toolId === "drive.link.create") {
    return { boundary: "external_guest", content: input, resources: resourceRefs(toolId, object) };
  }
  if (toolId === "drive.share" || toolId === "drive.access.update") {
    return { boundary: "drive_share", content: input, resources: resourceRefs(toolId, object) };
  }
  if (toolId === "chat.send" || toolId === "chat.reply_in_thread") {
    const attachments = stringArray(object.attachmentObjectIds);
    return {
      boundary: attachments.length === 0 ? "chat_message" : "chat_attachment",
      content: input,
      resources: attachments.map((resourceId) => ({ resourceType: "drive.file", resourceId })),
    };
  }
  if (toolId.includes("copy") || toolId.endsWith(".export")) {
    return { boundary: "copy_export", content: input, resources: resourceRefs(toolId, object) };
  }
  return null;
}

function resourceRefs(toolId: string, input: Record<string, unknown>): DlpResourceRef[] {
  const candidates: readonly [string, string][] = toolId.startsWith("docs.")
    ? [["drive.file", "docId"]]
    : toolId.startsWith("sheets.")
      ? [["drive.file", "sheetId"]]
      : toolId.startsWith("slides.")
        ? [["drive.file", "deckId"]]
        : toolId.startsWith("drive.")
          ? [["drive.file", "objectId"]]
          : [];
  return candidates.flatMap(([resourceType, key]) =>
    typeof input[key] === "string" ? [{ resourceType, resourceId: input[key] }] : [],
  );
}

function driveAttachments(value: unknown): DlpResourceRef[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const object = objectInput(item);
        return typeof object.objectId === "string"
          ? [{ resourceType: "drive.file", resourceId: object.objectId }]
          : [];
      })
    : [];
}

function objectInput(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function dlpDecisionError(decision: DlpDecision): Error & { readonly statusCode: number } {
  const error = new Error(
    decision.action === "quarantine"
      ? `DLP quarantined ${decision.boundary} content.`
      : `DLP blocked ${decision.boundary} content.`,
  ) as Error & { statusCode: number };
  error.statusCode = decision.action === "quarantine" ? 423 : 403;
  return error;
}
