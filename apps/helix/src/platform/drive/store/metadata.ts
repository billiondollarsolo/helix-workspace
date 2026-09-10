import type { JsonObject } from "@helix/sdk-types";
import { sensitivityClassificationFromMetadata } from "../../ai/classification/index.js";
import type { DriveSearchRecord } from "../types.js";
export function withoutVirusScanFailureMetadata(metadata: JsonObject): JsonObject {
  const failureKeys = new Set(["avScanAttempts", "avScanLastError", "avScanNextAttemptAt"]);
  return Object.fromEntries(Object.entries(metadata).filter(([key]) => !failureKeys.has(key)));
}

export function withoutMetadataKey(metadata: JsonObject, key: string): JsonObject {
  return Object.fromEntries(Object.entries(metadata).filter(([candidate]) => candidate !== key));
}

export function withoutDriveFinalizationMetadata(metadata: JsonObject): JsonObject {
  const transientKeys = new Set([
    "scanActorId",
    "scanLeaseExpiresAt",
    "scanPreviousStatus",
    "scanToken",
  ]);
  return Object.fromEntries(Object.entries(metadata).filter(([key]) => !transientKeys.has(key)));
}

export function withoutDriveUploadLifecycleMetadata(metadata: JsonObject): JsonObject {
  const lifecycleKeys = new Set([
    "uploadCleanupError",
    "uploadCleanupLeaseExpiresAt",
    "uploadExpiresAt",
  ]);
  return Object.fromEntries(Object.entries(metadata).filter(([key]) => !lifecycleKeys.has(key)));
}

export function withoutDriveDerivedContentMetadata(metadata: JsonObject): JsonObject {
  const derivedKeys = new Set([
    "autoTag",
    "contentUrl",
    "description",
    "enrichments",
    "preview",
    "previewText",
    "previewUrl",
    "summary",
    "tags",
    "textContent",
  ]);
  return Object.fromEntries(Object.entries(metadata).filter(([key]) => !derivedKeys.has(key)));
}

export function driveObjectMetadata(value: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

export function metadataStringProperty(metadata: JsonObject, key: string): Record<string, string> {
  const value = metadata[key];
  return typeof value === "string" ? { [key]: value } : {};
}

export function metadataStringArrayProperty(
  metadata: JsonObject,
  key: string,
): {
  readonly tags?: readonly string[];
} {
  const value = metadata[key];
  return Array.isArray(value) && value.every((entry): entry is string => typeof entry === "string")
    ? { tags: value }
    : {};
}

export function metadataClassificationProperty(
  metadata: JsonObject,
): Pick<DriveSearchRecord, "classification"> {
  const classification = sensitivityClassificationFromMetadata(metadata);
  return classification === undefined ? {} : { classification };
}
