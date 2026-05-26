import { createHash } from "node:crypto";
import type { StorageObject } from "@helix/sdk-types";
import { describe, expect, it } from "vitest";
import type { TenantStorageClient } from "../storage/tenant-resolver.js";
import type { TenantExportManifest, TenantExportSelfFetchManifest } from "./export.js";
import {
  buildTenantImportObjectRestorePlan,
  createTenantImportSelfFetchDownloader,
  restoreTenantImportObjectBytes,
} from "./import-object-restore.js";

const orgId = "22222222-2222-4222-8222-222222222222";

describe("buildTenantImportObjectRestorePlan", () => {
  it("plans included archive object bytes after byte size and hash verification", async () => {
    const body = Buffer.from("hello world", "utf8");
    const manifest = manifestWithObjects({
      bytesIncluded: true,
      objects: [
        {
          storageKey: "docs/source-org/doc-1",
          byteSize: body.byteLength,
          sha256: sha256Hex(body),
        },
      ],
    });

    await expect(
      buildTenantImportObjectRestorePlan({
        manifest,
        archiveEntries: new Map([["objects/docs/source-org/doc-1", body]]),
        targetStorageKeyFor: (storageKey) => storageKey.replace("source-org", "target-org"),
      }),
    ).resolves.toEqual({
      ok: true,
      summary: {
        total: 1,
        restorable: 1,
        blocked: 0,
        noop: 0,
        totalKnownBytes: body.byteLength,
      },
      operations: [
        {
          order: 1,
          source: "included_archive_bytes",
          action: "restore",
          storageKey: "docs/source-org/doc-1",
          targetStorageKey: "docs/target-org/doc-1",
          archivePath: "objects/docs/source-org/doc-1",
          byteSize: body.byteLength,
          sha256: sha256Hex(body),
        },
      ],
    });
  });

  it("blocks included object bytes when archive entries are missing or corrupted", async () => {
    const body = Buffer.from("hello world", "utf8");
    const manifest = manifestWithObjects({
      bytesIncluded: true,
      objects: [
        {
          storageKey: "docs/doc-1",
          byteSize: body.byteLength + 1,
          sha256: sha256Hex(body),
        },
        {
          storageKey: "sheets/sheet-1",
          byteSize: body.byteLength,
          sha256: sha256Hex(Buffer.from("different", "utf8")),
        },
        {
          storageKey: "slides/slide-1",
          byteSize: 10,
        },
      ],
    });

    const plan = await buildTenantImportObjectRestorePlan({
      manifest,
      archiveEntries: new Map([
        ["objects/docs/doc-1", body],
        ["objects/sheets/sheet-1", body],
      ]),
    });

    expect(plan.ok).toBe(false);
    expect(plan.summary).toEqual({
      total: 3,
      restorable: 0,
      blocked: 3,
      noop: 0,
      totalKnownBytes: body.byteLength + 1 + body.byteLength + 10,
    });
    expect(plan.operations.map((operation) => operation.blockedReason)).toEqual([
      "archive_object_size_mismatch",
      "archive_object_sha256_mismatch",
      "archive_object_missing",
    ]);
  });

  it("plans self-fetch restores when object bytes are not embedded but presigned URLs exist", async () => {
    const manifest = manifestWithObjects({
      bytesIncluded: false,
      objects: [
        {
          storageKey: "docs/doc-1",
          byteSize: 11,
          sha256: "a".repeat(64),
        },
      ],
    });
    const selfFetchManifest: TenantExportSelfFetchManifest = {
      version: 1,
      generatedAt: "2026-05-24T10:00:00.000Z",
      org: {
        id: orgId,
        slug: "acme",
      },
      delivery: "self-fetch",
      expiresAt: "2026-05-24T11:00:00.000Z",
      expiresSeconds: 3600,
      objects: [
        {
          storageKey: "docs/doc-1",
          byteSize: 11,
          sha256: "a".repeat(64),
          url: "https://example.test/docs/doc-1",
          expiresAt: "2026-05-24T11:00:00.000Z",
        },
      ],
    };

    await expect(
      buildTenantImportObjectRestorePlan({
        manifest,
        selfFetchManifest,
      }),
    ).resolves.toMatchObject({
      ok: true,
      operations: [
        {
          source: "self_fetch",
          action: "restore",
          selfFetchUrl: "https://example.test/docs/doc-1",
        },
      ],
    });
  });

  it("blocks metadata-only inventories without embedded bytes or self-fetch URLs", async () => {
    const manifest = manifestWithObjects({
      bytesIncluded: false,
      objects: [
        {
          storageKey: "docs/doc-1",
          byteSize: 11,
        },
      ],
    });

    await expect(buildTenantImportObjectRestorePlan({ manifest })).resolves.toMatchObject({
      ok: false,
      summary: {
        total: 1,
        restorable: 0,
        blocked: 1,
        noop: 0,
        totalKnownBytes: 11,
      },
      operations: [
        {
          source: "metadata_only",
          action: "blocked",
          blockedReason: "object_bytes_not_available",
        },
      ],
    });
  });

  it("rejects unsafe object storage keys before planning archive paths", async () => {
    const manifest = manifestWithObjects({
      bytesIncluded: true,
      objects: [
        {
          storageKey: "../secret",
          byteSize: 1,
        },
      ],
    });

    await expect(buildTenantImportObjectRestorePlan({ manifest })).rejects.toThrow(
      "Unsafe tenant import object storage key",
    );
  });
});

describe("restoreTenantImportObjectBytes", () => {
  it("writes included object bytes to the resolved target storage key", async () => {
    const body = Buffer.from("hello world", "utf8");
    const manifest = manifestWithObjects({
      bytesIncluded: true,
      objects: [
        {
          storageKey: "docs/source-org/doc-1",
          byteSize: body.byteLength,
          sha256: sha256Hex(body),
        },
      ],
    });
    const archiveEntries = new Map([["objects/docs/source-org/doc-1", body]]);
    const plan = await buildTenantImportObjectRestorePlan({
      manifest,
      archiveEntries,
      targetStorageKeyFor: (storageKey) => storageKey.replace("source-org", "target-org"),
    });
    const storage = new RecordingStorageClient();

    await expect(
      restoreTenantImportObjectBytes({
        plan,
        archiveEntries,
        storage,
      }),
    ).resolves.toMatchObject({
      ok: true,
      summary: {
        total: 1,
        restorable: 1,
        blocked: 0,
      },
    });

    expect(storage.puts).toEqual([
      {
        key: "docs/target-org/doc-1",
        body,
        contentType: "application/octet-stream",
        metadata: {
          "helix-import-source-key": "docs/source-org/doc-1",
          "helix-import-source": "included-archive-bytes",
          "helix-import-sha256": sha256Hex(body),
        },
      },
    ]);
  });

  it("writes self-fetch object bytes after downloader size and hash verification", async () => {
    const body = Buffer.from("hello world", "utf8");
    const manifest = manifestWithObjects({
      bytesIncluded: false,
      objects: [
        {
          storageKey: "docs/doc-1",
          byteSize: body.byteLength,
          sha256: sha256Hex(body),
        },
      ],
    });
    const plan = await buildTenantImportObjectRestorePlan({
      manifest,
      selfFetchManifest: {
        version: 1,
        generatedAt: "2026-05-24T10:00:00.000Z",
        org: {
          id: orgId,
          slug: "acme",
        },
        delivery: "self-fetch",
        expiresAt: "2026-05-24T11:00:00.000Z",
        expiresSeconds: 3600,
        objects: [
          {
            storageKey: "docs/doc-1",
            byteSize: body.byteLength,
            sha256: sha256Hex(body),
            url: "https://example.test/docs/doc-1",
            expiresAt: "2026-05-24T11:00:00.000Z",
          },
        ],
      },
    });
    const storage = new RecordingStorageClient();

    await expect(
      restoreTenantImportObjectBytes({
        plan,
        archiveEntries: new Map(),
        storage,
        selfFetchDownloader: createTenantImportSelfFetchDownloader({
          fetchImpl: async (url, init) => {
            const requestUrl =
              url instanceof URL ? url.href : typeof url === "string" ? url : url.url;
            expect(requestUrl).toBe("https://example.test/docs/doc-1");
            expect(init?.method).toBe("GET");
            expect(init?.signal).toBeDefined();
            return new Response(body, {
              status: 200,
              headers: {
                "content-length": String(body.byteLength),
                "content-type": "text/plain",
              },
            });
          },
          maxBytes: body.byteLength,
        }),
      }),
    ).resolves.toMatchObject({
      ok: true,
      operations: [
        {
          action: "restore",
        },
      ],
    });

    expect(storage.puts).toHaveLength(1);
    expect(storage.puts[0]).toMatchObject({
      key: "docs/doc-1",
      contentType: "text/plain",
      metadata: {
        "helix-import-source-key": "docs/doc-1",
        "helix-import-source": "self-fetch",
        "helix-import-sha256": sha256Hex(body),
      },
    });
    expect(Buffer.from(storage.puts[0]?.body as Uint8Array)).toEqual(body);
    expect(storage.puts[0]?.metadata?.["helix-import-self-fetch-url-sha256"]).toHaveLength(64);
    expect(storage.puts[0]?.metadata).not.toHaveProperty("helix-import-self-fetch-url");
  });

  it("keeps self-fetch restore execution blocked when no downloader is provided", async () => {
    const manifest = manifestWithObjects({
      bytesIncluded: false,
      objects: [
        {
          storageKey: "docs/doc-1",
          byteSize: 11,
        },
      ],
    });
    const plan = await buildTenantImportObjectRestorePlan({
      manifest,
      selfFetchManifest: {
        version: 1,
        generatedAt: "2026-05-24T10:00:00.000Z",
        org: {
          id: orgId,
          slug: "acme",
        },
        delivery: "self-fetch",
        expiresAt: "2026-05-24T11:00:00.000Z",
        expiresSeconds: 3600,
        objects: [
          {
            storageKey: "docs/doc-1",
            url: "https://example.test/docs/doc-1",
            expiresAt: "2026-05-24T11:00:00.000Z",
          },
        ],
      },
    });
    const storage = new RecordingStorageClient();

    await expect(
      restoreTenantImportObjectBytes({
        plan,
        archiveEntries: new Map(),
        storage,
      }),
    ).resolves.toMatchObject({
      ok: false,
      operations: [
        {
          action: "blocked",
          blockedReason: "self_fetch_downloader_missing",
        },
      ],
    });
    expect(storage.puts).toEqual([]);
  });

  it("fails self-fetch downloads on unsafe scheme, HTTP failure, size mismatch, or hash mismatch", async () => {
    const body = Buffer.from("hello world", "utf8");

    await expect(
      createTenantImportSelfFetchDownloader({
        fetchImpl: async () => new Response(body),
      })({
        storageKey: "docs/doc-1",
        targetStorageKey: "docs/doc-1",
        url: "http://example.test/docs/doc-1",
      }),
    ).rejects.toThrow("Tenant import self-fetch URL must use HTTPS.");

    await expect(
      createTenantImportSelfFetchDownloader({
        fetchImpl: async () => new Response("nope", { status: 403 }),
      })({
        storageKey: "docs/doc-1",
        targetStorageKey: "docs/doc-1",
        url: "https://example.test/docs/doc-1",
      }),
    ).rejects.toThrow("Tenant import self-fetch failed with HTTP 403.");

    await expect(
      createTenantImportSelfFetchDownloader({
        fetchImpl: async () =>
          new Response(body, {
            headers: {
              "content-length": String(body.byteLength + 1),
            },
          }),
      })({
        storageKey: "docs/doc-1",
        targetStorageKey: "docs/doc-1",
        url: "https://example.test/docs/doc-1",
        expectedByteSize: body.byteLength,
      }),
    ).rejects.toThrow("Tenant import self-fetch content-length did not match the manifest.");

    await expect(
      createTenantImportSelfFetchDownloader({
        fetchImpl: async () => new Response(body),
      })({
        storageKey: "docs/doc-1",
        targetStorageKey: "docs/doc-1",
        url: "https://example.test/docs/doc-1",
        expectedSha256: sha256Hex(Buffer.from("different", "utf8")),
      }),
    ).rejects.toThrow("Tenant import self-fetch object sha256 did not match the manifest.");
  });
});

function manifestWithObjects(input: {
  readonly bytesIncluded: boolean;
  readonly objects: TenantExportManifest["objectInventory"]["objects"];
}): TenantExportManifest {
  return {
    version: 1,
    generatedAt: "2026-05-24T10:00:00.000Z",
    org: {
      id: orgId,
      slug: "acme",
      displayName: "Acme",
      status: "active",
      tier: "enterprise",
      planId: "enterprise",
      region: "us-east-1",
    },
    configSnapshot: {
      byoConfig: {},
      featureFlags: {},
      quotas: {},
      branding: {},
    },
    objectInventory: {
      bytesIncluded: input.bytesIncluded,
      objectCount: input.objects.length,
      totalKnownBytes: input.objects.reduce((total, object) => total + (object.byteSize ?? 0), 0),
      objects: input.objects,
    },
    postgres: {
      rowCounts: [],
      rowDataChunks: {
        version: 1,
        format: "jsonl",
        chunks: [],
        includedTables: [],
        excludedTables: [],
        notes: [],
      },
    },
    auditLog: {
      rowCount: 0,
      firstEntryAt: null,
      lastEntryAt: null,
    },
  };
}

function sha256Hex(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

class RecordingStorageClient implements TenantStorageClient {
  readonly puts: StorageObject[] = [];

  async put(object: StorageObject): Promise<void> {
    this.puts.push(object);
  }

  async get(): Promise<StorageObject | null> {
    return null;
  }

  async delete(): Promise<void> {}
}
