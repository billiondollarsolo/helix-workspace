import type { JsonObject } from "@helix/sdk-types";
import type { DlpAction, DlpBoundary } from "../../dlp.js";
import type { DataClassification } from "./types.js";

export interface SensitivityLabel {
  readonly key: DataClassification;
  readonly rank: number;
  readonly displayName: string;
  readonly description: string;
  readonly color: string;
  readonly marking: string;
  readonly retentionDays: number;
  readonly encryption: "platform" | "tenant_kms";
  readonly externalSharing: "allow" | "block";
  readonly recordingExport: boolean;
  readonly boundaryActions: Readonly<Partial<Record<DlpBoundary, DlpAction>>>;
}

/** One product-independent label vocabulary and its mandatory policy floor. */
export const sensitivityLabels = {
  public: {
    key: "public",
    rank: 0,
    displayName: "Public",
    description: "Approved for public distribution.",
    color: "#16A34A",
    marking: "PUBLIC",
    retentionDays: 0,
    encryption: "platform",
    externalSharing: "allow",
    recordingExport: true,
    boundaryActions: {},
  },
  standard: {
    key: "standard",
    rank: 1,
    displayName: "Standard",
    description: "Internal workspace content.",
    color: "#2563EB",
    marking: "INTERNAL",
    retentionDays: 0,
    encryption: "platform",
    externalSharing: "allow",
    recordingExport: true,
    boundaryActions: {},
  },
  confidential: {
    key: "confidential",
    rank: 2,
    displayName: "Confidential",
    description: "Sensitive business data limited to approved collaborators.",
    color: "#D97706",
    marking: "CONFIDENTIAL",
    retentionDays: 365,
    encryption: "tenant_kms",
    externalSharing: "block",
    recordingExport: false,
    boundaryActions: {
      drive_share: "audit",
      drive_download: "warn",
      copy_export: "block",
      api_agent: "block",
      external_guest: "block",
    },
  },
  restricted: {
    key: "restricted",
    rank: 3,
    displayName: "Restricted",
    description: "Highest-sensitivity content limited to explicitly authorized users.",
    color: "#DC2626",
    marking: "RESTRICTED",
    retentionDays: 2_555,
    encryption: "tenant_kms",
    externalSharing: "block",
    recordingExport: false,
    boundaryActions: {
      drive_share: "block",
      drive_download: "block",
      copy_export: "block",
      api_agent: "block",
      external_guest: "block",
    },
  },
} as const satisfies Record<DataClassification, SensitivityLabel>;

export function sensitivityLabelFor(classification: DataClassification): SensitivityLabel {
  return sensitivityLabels[classification];
}

export function sensitivityClassificationFromMetadata(
  metadata: JsonObject | undefined,
): DataClassification | undefined {
  const label = metadata?.sensitivityLabel;
  if (label === null || typeof label !== "object" || Array.isArray(label)) return undefined;
  const key = (label as JsonObject).key;
  return key === "public" ||
    key === "standard" ||
    key === "confidential" ||
    key === "restricted"
    ? key
    : undefined;
}

export function canonicalClassificationResourceType(resourceType: string): string {
  return resourceType === "docs.document" ||
    resourceType === "sheets.sheet" ||
    resourceType === "slides.deck" ||
    resourceType === "object"
    ? "drive.file"
    : resourceType;
}
