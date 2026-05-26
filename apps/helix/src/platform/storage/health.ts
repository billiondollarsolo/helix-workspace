import { randomUUID } from "node:crypto";
import type { TenantStorageResolver } from "./tenant-resolver.js";

export interface TenantStorageHealthResult {
  readonly status: "healthy" | "degraded";
  readonly checked_at: string;
  readonly message: string;
  readonly managedBy?: "helix-default" | "byo" | undefined;
  readonly prefix?: string | undefined;
}

export interface PersistedTenantStorageHealth {
  readonly status: "healthy" | "degraded";
  readonly checked_at: string;
  readonly message: string;
}

export async function testTenantStorageConnection(input: {
  readonly orgId: string;
  readonly storageResolver: TenantStorageResolver | undefined;
  readonly refresh?: boolean | undefined;
}): Promise<TenantStorageHealthResult> {
  const checkedAt = new Date().toISOString();
  if (input.storageResolver === undefined) {
    return degradedStorageHealth(checkedAt, "Tenant storage resolver is not configured.");
  }
  try {
    const resolved = await input.storageResolver({
      orgId: input.orgId,
      ...(input.refresh === undefined ? {} : { refresh: input.refresh }),
    });
    if (resolved === undefined) {
      return degradedStorageHealth(checkedAt, "Tenant object storage is not configured.");
    }
    const key = `.helix-health/byo-storage/${randomUUID()}.txt`;
    const body = new TextEncoder().encode("helix-storage-health");
    await resolved.client.put({
      key,
      body,
      contentType: "text/plain",
      metadata: { purpose: "byo-storage-health" },
    });
    try {
      const object = await resolved.client.get(key);
      if (object === null || (await storageObjectBodyText(object.body)) !== "helix-storage-health") {
        return {
          status: "degraded",
          checked_at: checkedAt,
          message: "Tenant object storage probe read did not match the written object.",
          managedBy: resolved.managedBy,
          prefix: resolved.prefix,
        };
      }
      return {
        status: "healthy",
        checked_at: checkedAt,
        message: "Tenant object storage write/read/delete probe succeeded.",
        managedBy: resolved.managedBy,
        prefix: resolved.prefix,
      };
    } finally {
      await resolved.client.delete(key).catch(() => undefined);
    }
  } catch (error) {
    return degradedStorageHealth(checkedAt, storageHealthErrorMessage(error));
  }
}

export function persistedTenantStorageHealth(
  health: TenantStorageHealthResult,
): PersistedTenantStorageHealth {
  return {
    status: health.status,
    checked_at: health.checked_at,
    message: health.message,
  };
}

function degradedStorageHealth(checkedAt: string, message: string): TenantStorageHealthResult {
  return {
    status: "degraded",
    checked_at: checkedAt,
    message,
  };
}

function storageHealthErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "Tenant object storage probe failed.";
}

async function storageObjectBodyText(body: AsyncIterable<Uint8Array> | Uint8Array): Promise<string> {
  if (body instanceof Uint8Array) {
    return new TextDecoder().decode(body);
  }
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) {
    chunks.push(chunk);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
