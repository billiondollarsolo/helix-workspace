import { createHash } from "node:crypto";
import type { TenantStorageClient } from "../storage/tenant-resolver.js";
import type {
  TenantExportManifest,
  TenantExportSelfFetchManifest,
  TenantExportSelfFetchObject,
} from "./export.js";

export type TenantImportObjectRestoreSource =
  | "included_archive_bytes"
  | "self_fetch"
  | "metadata_only";

export type TenantImportObjectRestoreAction = "restore" | "blocked" | "noop";

export interface TenantImportObjectRestoreOperation {
  readonly order: number;
  readonly source: TenantImportObjectRestoreSource;
  readonly action: TenantImportObjectRestoreAction;
  readonly storageKey: string;
  readonly targetStorageKey: string;
  readonly archivePath: string;
  readonly byteSize?: number | undefined;
  readonly sha256?: string | undefined;
  readonly selfFetchUrl?: string | undefined;
  readonly blockedReason?: string | undefined;
}

export interface TenantImportObjectRestorePlan {
  readonly ok: boolean;
  readonly summary: {
    readonly total: number;
    readonly restorable: number;
    readonly blocked: number;
    readonly noop: number;
    readonly totalKnownBytes: number;
  };
  readonly operations: readonly TenantImportObjectRestoreOperation[];
}

export interface BuildTenantImportObjectRestorePlanInput {
  readonly manifest: TenantExportManifest;
  readonly archiveEntries?: ReadonlyMap<string, Uint8Array> | undefined;
  readonly selfFetchManifest?: TenantExportSelfFetchManifest | undefined;
  readonly targetStorageKeyFor?: ((storageKey: string) => string) | undefined;
}

export interface TenantImportObjectRestoreResult {
  readonly ok: boolean;
  readonly summary: TenantImportObjectRestorePlan["summary"];
  readonly operations: readonly TenantImportObjectRestoreOperation[];
}

export async function buildTenantImportObjectRestorePlan(
  input: BuildTenantImportObjectRestorePlanInput,
): Promise<TenantImportObjectRestorePlan> {
  const selfFetchObjects = new Map(
    input.selfFetchManifest?.objects.map((object) => [object.storageKey, object]) ?? [],
  );
  const operations: TenantImportObjectRestoreOperation[] = [];
  let order = 1;
  for (const object of input.manifest.objectInventory.objects) {
    const storageKey = object.storageKey;
    const targetStorageKey = input.targetStorageKeyFor?.(storageKey) ?? storageKey;
    const archivePath = objectArchivePath(storageKey);
    if (input.manifest.objectInventory.bytesIncluded) {
      operations.push(
        await includedByteOperation({
          order,
          storageKey,
          targetStorageKey,
          archivePath,
          expectedByteSize: object.byteSize,
          expectedSha256: object.sha256,
          archiveEntries: input.archiveEntries,
        }),
      );
    } else {
      operations.push(
        metadataOrSelfFetchOperation({
          order,
          storageKey,
          targetStorageKey,
          archivePath,
          object,
          selfFetchObject: selfFetchObjects.get(storageKey),
        }),
      );
    }
    order += 1;
  }
  return objectRestorePlan(operations);
}

export async function restoreTenantImportObjectBytes(input: {
  readonly plan: TenantImportObjectRestorePlan;
  readonly archiveEntries: ReadonlyMap<string, Uint8Array>;
  readonly storage: TenantStorageClient;
}): Promise<TenantImportObjectRestoreResult> {
  const operations: TenantImportObjectRestoreOperation[] = [];
  for (const operation of input.plan.operations) {
    if (operation.action !== "restore") {
      operations.push(operation);
      continue;
    }
    if (operation.source !== "included_archive_bytes") {
      operations.push({
        ...operation,
        action: "blocked",
        blockedReason: "restore_source_not_local",
      });
      continue;
    }
    const body = input.archiveEntries.get(operation.archivePath);
    if (body === undefined) {
      operations.push({ ...operation, action: "blocked", blockedReason: "archive_object_missing" });
      continue;
    }
    if (operation.byteSize !== undefined && body.byteLength !== operation.byteSize) {
      operations.push({
        ...operation,
        action: "blocked",
        blockedReason: "archive_object_size_mismatch",
      });
      continue;
    }
    if (operation.sha256 !== undefined && sha256Hex(body) !== operation.sha256) {
      operations.push({
        ...operation,
        action: "blocked",
        blockedReason: "archive_object_sha256_mismatch",
      });
      continue;
    }
    await input.storage.put({
      key: operation.targetStorageKey,
      body,
      contentType: "application/octet-stream",
      metadata: {
        "helix-import-source-key": operation.storageKey,
        ...(operation.sha256 === undefined ? {} : { "helix-import-sha256": operation.sha256 }),
      },
    });
    operations.push(operation);
  }
  return objectRestorePlan(operations);
}

async function includedByteOperation(input: {
  readonly order: number;
  readonly storageKey: string;
  readonly targetStorageKey: string;
  readonly archivePath: string;
  readonly expectedByteSize?: number | undefined;
  readonly expectedSha256?: string | undefined;
  readonly archiveEntries: ReadonlyMap<string, Uint8Array> | undefined;
}): Promise<TenantImportObjectRestoreOperation> {
  const body = input.archiveEntries?.get(input.archivePath);
  if (body === undefined) {
    return blockedOperation(input, "archive_object_missing", "included_archive_bytes");
  }
  if (input.expectedByteSize !== undefined && body.byteLength !== input.expectedByteSize) {
    return blockedOperation(input, "archive_object_size_mismatch", "included_archive_bytes");
  }
  if (input.expectedSha256 !== undefined && sha256Hex(body) !== input.expectedSha256) {
    return blockedOperation(input, "archive_object_sha256_mismatch", "included_archive_bytes");
  }
  return {
    order: input.order,
    source: "included_archive_bytes",
    action: "restore",
    storageKey: input.storageKey,
    targetStorageKey: input.targetStorageKey,
    archivePath: input.archivePath,
    ...(input.expectedByteSize === undefined ? {} : { byteSize: input.expectedByteSize }),
    ...(input.expectedSha256 === undefined ? {} : { sha256: input.expectedSha256 }),
  };
}

function metadataOrSelfFetchOperation(input: {
  readonly order: number;
  readonly storageKey: string;
  readonly targetStorageKey: string;
  readonly archivePath: string;
  readonly object: { readonly byteSize?: number | undefined; readonly sha256?: string | undefined };
  readonly selfFetchObject: TenantExportSelfFetchObject | undefined;
}): TenantImportObjectRestoreOperation {
  if (input.selfFetchObject !== undefined) {
    return {
      order: input.order,
      source: "self_fetch",
      action: "restore",
      storageKey: input.storageKey,
      targetStorageKey: input.targetStorageKey,
      archivePath: input.archivePath,
      ...(input.object.byteSize === undefined ? {} : { byteSize: input.object.byteSize }),
      ...(input.object.sha256 === undefined ? {} : { sha256: input.object.sha256 }),
      selfFetchUrl: input.selfFetchObject.url,
    };
  }
  return blockedOperation(input, "object_bytes_not_available", "metadata_only");
}

function blockedOperation(
  input: {
    readonly order: number;
    readonly storageKey: string;
    readonly targetStorageKey: string;
    readonly archivePath: string;
    readonly expectedByteSize?: number | undefined;
    readonly expectedSha256?: string | undefined;
    readonly object?: {
      readonly byteSize?: number | undefined;
      readonly sha256?: string | undefined;
    };
  },
  blockedReason: string,
  source: TenantImportObjectRestoreSource,
): TenantImportObjectRestoreOperation {
  const byteSize = input.expectedByteSize ?? input.object?.byteSize;
  const sha256 = input.expectedSha256 ?? input.object?.sha256;
  return {
    order: input.order,
    source,
    action: "blocked",
    storageKey: input.storageKey,
    targetStorageKey: input.targetStorageKey,
    archivePath: input.archivePath,
    ...(byteSize === undefined ? {} : { byteSize }),
    ...(sha256 === undefined ? {} : { sha256 }),
    blockedReason,
  };
}

function objectRestorePlan(
  operations: readonly TenantImportObjectRestoreOperation[],
): TenantImportObjectRestorePlan {
  return {
    ok: operations.every((operation) => operation.action !== "blocked"),
    summary: {
      total: operations.length,
      restorable: operations.filter((operation) => operation.action === "restore").length,
      blocked: operations.filter((operation) => operation.action === "blocked").length,
      noop: operations.filter((operation) => operation.action === "noop").length,
      totalKnownBytes: operations.reduce(
        (total, operation) => total + (operation.byteSize ?? 0),
        0,
      ),
    },
    operations,
  };
}

function objectArchivePath(storageKey: string): string {
  const normalized = storageKey.replaceAll("\\", "/");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..") ||
    containsControlCharacter(normalized)
  ) {
    throw new Error(`Unsafe tenant import object storage key: ${storageKey}`);
  }
  return `objects/${normalized}`;
}

function containsControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
}

function sha256Hex(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}
