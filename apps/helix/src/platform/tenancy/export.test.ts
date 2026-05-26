import { createHash } from "node:crypto";
import fastify from "fastify";
import type postgres from "postgres";
import type { Actor, StorageObject } from "@helix/sdk-types";
import { describe, expect, it, vi } from "vitest";
import { InMemoryTenantHourlyQuotaLimiter } from "../limits/index.js";
import type { TenantStorageClient, TenantStorageResolver } from "../storage/index.js";
import {
  buildTenantExportArchive,
  buildTenantExportManifest,
  buildTenantExportPostgresDataChunkFiles,
  countTenantExportRows,
  materializeTenantExportArchiveArtifact,
  PostgresTenantExportJobStore,
  TenantExportMaterializationWorker,
  streamTenantExportArchive,
  summarizeTenantExportAudit,
  type TenantExportJobRecord,
  type TenantExportJobObservabilitySnapshot,
  type TenantExportJobStore,
  type TenantExportManifest,
  type TenantExportMetrics,
  type TenantExportPostgresDataChunkFile,
  type TenantExportPostgresDataChunkManifest,
} from "./export.js";
import { registerTenantExportRoutes } from "./export-routes.js";
import type { OrgRecord, OrgStore } from "./orgs.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const otherOrgId = "33333333-3333-4333-8333-333333333333";
const actorId = "11111111-1111-4111-8111-111111111111";

describe("tenant export archive", () => {
  it("builds a portable metadata archive without object bytes by default", async () => {
    const manifest = tenantExportManifest();

    const archive = await buildTenantExportArchive(manifest);
    const entries = parseTarEntries(archive.bytes);

    expect(archive).toMatchObject({
      filename: "helix-export-acme-20260524T100000Z.tar",
      contentType: "application/x-tar",
    });
    expect(Object.keys(entries).sort()).toEqual([
      "README.md",
      "audit-log/summary.json",
      "config-snapshot.json",
      "manifest.json",
      "objects/inventory.json",
      "postgres/data/chunks/manifest.json",
      "postgres/data/row-counts.json",
      "postgres/schema.sql",
      "secrets-public.json",
    ]);
    expect(JSON.parse(entries["manifest.json"] ?? "{}")).toMatchObject({
      version: 1,
      org: { slug: "acme" },
      objectInventory: { bytesIncluded: false, objectCount: 2 },
    });
    const rowChunkManifest = JSON.parse(
      entries["postgres/data/chunks/manifest.json"] ?? "{}",
    ) as TenantExportPostgresDataChunkManifest;
    expect(rowChunkManifest).toMatchObject({
      version: 1,
      format: "jsonl",
      chunks: [],
      includedTables: [],
    });
    expect(
      Object.fromEntries(
        rowChunkManifest.excludedTables.map((entry) => [entry.table, entry.reason]),
      ),
    ).toMatchObject({
      app_passwords: "credential_material",
      agent_credentials: "credential_material",
      oauth_access_tokens: "token_material",
      oauth_authorization_codes: "token_material",
      webhook_deliveries: "webhook_payload",
      docs_documents: "content_body",
      mail_outbound_messages: "content_body",
    });
    expect(
      Object.keys(entries).some(
        (path) => path.startsWith("postgres/data/chunks/") && path.endsWith(".jsonl"),
      ),
    ).toBe(false);
    expect(entries["README.md"]).toContain("does not include object bytes");
    expect(entries["README.md"]).toContain("postgres/data/chunks/manifest.json");
    const serialized = archive.bytes.toString("utf8");
    expect(serialized).not.toContain("plaintext-secret");
    expect(serialized).not.toContain("report bytes");
  });

  it("packs allowlisted PostgreSQL metadata row chunks", async () => {
    const rowDataChunkFiles = await tenantExportAdminDomainChunkFiles();
    const manifest = tenantExportManifest({ rowDataChunkFiles });

    const archive = await buildTenantExportArchive(manifest);
    const entries = parseTarEntries(archive.bytes);
    const rowChunkManifest = JSON.parse(
      entries["postgres/data/chunks/manifest.json"] ?? "{}",
    ) as TenantExportPostgresDataChunkManifest;

    expect(Object.keys(entries).sort()).toContain(
      "postgres/data/chunks/admin_domains/000000.jsonl",
    );
    expect(Object.keys(entries).sort()).toContain(
      "postgres/data/chunks/admin_dns_records/000000.jsonl",
    );
    expect(rowChunkManifest.includedTables).toEqual(["admin_domains", "admin_dns_records"]);
    expect(rowChunkManifest.chunks).toEqual([
      expect.objectContaining({
        table: "admin_domains",
        path: "postgres/data/chunks/admin_domains/000000.jsonl",
        rowCount: 1,
        orderBy: ["lower(domain)", "created_at", "id"],
      }),
      expect.objectContaining({
        table: "admin_dns_records",
        path: "postgres/data/chunks/admin_dns_records/000000.jsonl",
        rowCount: 1,
        orderBy: ["domain_id", "record_type", "host", "id"],
      }),
    ]);

    for (const chunk of rowChunkManifest.chunks) {
      const body = entries[chunk.path] ?? "";
      expect(chunk.byteSize).toBe(Buffer.byteLength(body, "utf8"));
      expect(chunk.sha256).toBe(createHash("sha256").update(body).digest("hex"));
    }

    expect(parseJsonl(entries["postgres/data/chunks/admin_domains/000000.jsonl"] ?? "")).toEqual([
      {
        id: "44444444-4444-4444-8444-444444444444",
        orgId,
        domain: "example.com",
        isPrimary: true,
        verificationStatus: "verified",
        verifiedAt: "2026-05-24T09:30:00.000Z",
        createdBy: actorId,
        createdAt: "2026-05-24T09:00:00.000Z",
        updatedAt: "2026-05-24T09:30:00.000Z",
      },
    ]);
    expect(
      parseJsonl(entries["postgres/data/chunks/admin_dns_records/000000.jsonl"] ?? ""),
    ).toEqual([
      {
        id: "55555555-5555-4555-8555-555555555555",
        orgId,
        domainId: "44444444-4444-4444-8444-444444444444",
        recordType: "TXT",
        host: "_helix.example.com",
        expectedValue: "helix-verification=abc",
        observedValue: "helix-verification=abc",
        status: "verified",
        lastCheckedAt: "2026-05-24T09:25:00.000Z",
        createdAt: "2026-05-24T09:00:00.000Z",
        updatedAt: "2026-05-24T09:25:00.000Z",
      },
    ]);
    expect(entries["manifest.json"]).not.toContain("expectedValue");
    expect(entries["README.md"]).toContain("allowlisted PostgreSQL metadata row-data chunks");
  });

  it("packs object bytes from tenant-resolved storage when explicitly requested", async () => {
    const storage = new MemoryStorageClient([
      { key: "drive/report.txt", body: Buffer.from("report bytes", "utf8") },
      { key: "slides/deck-1/versions/2", body: asyncBytes("deck bytes") },
    ]);

    const archive = await buildTenantExportArchive(tenantExportManifest(), {
      includeObjectBytes: true,
      storageResolver: storageResolverFor(storage),
    });
    const entries = parseTarEntries(archive.bytes);

    expect(JSON.parse(entries["manifest.json"] ?? "{}")).toMatchObject({
      objectInventory: { bytesIncluded: true, objectCount: 2 },
    });
    expect(entries["objects/drive/report.txt"]).toBe("report bytes");
    expect(entries["objects/slides/deck-1/versions/2"]).toBe("deck bytes");
  });

  it("streams object-byte archives without consuming object bodies during setup", async () => {
    let consumed = false;
    async function* trackedBytes(): AsyncIterable<Uint8Array> {
      consumed = true;
      yield Buffer.from("deck bytes from storage", "utf8");
    }
    const storage = new MemoryStorageClient([
      { key: "drive/report.txt", body: Buffer.from("report bytes", "utf8") },
      { key: "slides/deck-1/versions/2", body: trackedBytes() },
    ]);

    const archive = await streamTenantExportArchive(tenantExportManifest(), {
      includeObjectBytes: true,
      storageResolver: storageResolverFor(storage),
    });

    expect(archive.filename).toBe("helix-export-acme-20260524T100000Z.tar");
    expect(storage.gets).toEqual(["drive/report.txt", "slides/deck-1/versions/2"]);
    expect(consumed).toBe(false);

    const bytes = await collectBytes(archive.body);
    const entries = parseTarEntries(bytes);

    expect(consumed).toBe(true);
    expect(archive.byteSize).toBe(bytes.byteLength);
    expect(entries["objects/drive/report.txt"]).toBe("report bytes");
    expect(entries["objects/slides/deck-1/versions/2"]).toBe("deck bytes from storage");
  });

  it("emits a self-fetch manifest with presigned object URLs when requested", async () => {
    const storage = new MemoryStorageClient([
      { key: "drive/report.txt", body: Buffer.from("report bytes", "utf8") },
      { key: "slides/deck-1/versions/2", body: Buffer.from("deck bytes", "utf8") },
    ]);

    const archive = await buildTenantExportArchive(tenantExportManifest(), {
      includeObjectBytes: true,
      objectByteDelivery: "self-fetch",
      presignedUrlExpiresSeconds: 600,
      storageResolver: storageResolverFor(storage),
      now: () => new Date("2026-05-24T10:30:00.000Z"),
    });
    const entries = parseTarEntries(archive.bytes);
    const manifest = JSON.parse(entries["objects/self-fetch-manifest.json"] ?? "{}") as {
      readonly delivery: string;
      readonly expiresAt: string;
      readonly expiresSeconds: number;
      readonly objects: readonly {
        readonly storageKey: string;
        readonly byteSize?: number;
        readonly sha256?: string;
        readonly url: string;
        readonly expiresAt: string;
      }[];
    };

    expect(JSON.parse(entries["manifest.json"] ?? "{}")).toMatchObject({
      objectInventory: { bytesIncluded: false, objectCount: 2 },
    });
    expect(entries["objects/drive/report.txt"]).toBeUndefined();
    expect(manifest).toMatchObject({
      delivery: "self-fetch",
      expiresAt: "2026-05-24T10:40:00.000Z",
      expiresSeconds: 600,
      objects: [
        {
          storageKey: "drive/report.txt",
          byteSize: 12,
          sha256: "abc",
          url: "https://storage.example/drive%2Freport.txt?expires=600",
          expiresAt: "2026-05-24T10:40:00.000Z",
        },
        {
          storageKey: "slides/deck-1/versions/2",
          byteSize: 23,
          sha256: "def",
          url: "https://storage.example/slides%2Fdeck-1%2Fversions%2F2?expires=600",
          expiresAt: "2026-05-24T10:40:00.000Z",
        },
      ],
    });
    expect(storage.gets).toEqual([]);
    expect(storage.presignedGets).toEqual([
      { key: "drive/report.txt", expiresSeconds: 600 },
      { key: "slides/deck-1/versions/2", expiresSeconds: 600 },
    ]);
  });

  it("materializes an archive artifact into tenant storage and returns a presigned download URL", async () => {
    const storage = new MemoryStorageClient([
      { key: "drive/report.txt", body: Buffer.from("report bytes", "utf8") },
      { key: "slides/deck-1/versions/2", body: Buffer.from("deck bytes", "utf8") },
    ]);

    const artifact = await materializeTenantExportArchiveArtifact(tenantExportManifest(), {
      includeObjectBytes: true,
      presignedUrlExpiresSeconds: 900,
      storageResolver: storageResolverFor(storage),
      now: () => new Date("2026-05-24T11:00:00.000Z"),
    });
    const stored = storage.objects.get(artifact.storageKey);
    const entries = parseTarEntries(await collectBytesFromStorageObject(stored));

    expect(artifact).toMatchObject({
      filename: "helix-export-acme-20260524T100000Z.tar",
      contentType: "application/x-tar",
      storageKey: "tenant-exports/acme/helix-export-acme-20260524T100000Z.tar",
      downloadUrl:
        "https://storage.example/tenant-exports%2Facme%2Fhelix-export-acme-20260524T100000Z.tar?expires=900",
      expiresAt: "2026-05-24T11:15:00.000Z",
      expiresSeconds: 900,
    });
    expect(artifact.byteSize).toBeGreaterThan(0);
    expect(stored).toMatchObject({
      key: artifact.storageKey,
      contentType: "application/x-tar",
      metadata: {
        "helix-org-id": orgId,
        "helix-export-generated-at": "2026-05-24T10:00:00.000Z",
        "helix-export-filename": "helix-export-acme-20260524T100000Z.tar",
      },
    });
    expect(entries["objects/drive/report.txt"]).toBe("report bytes");
    expect(entries["objects/slides/deck-1/versions/2"]).toBe("deck bytes");
    expect(storage.presignedGets).toEqual([{ key: artifact.storageKey, expiresSeconds: 900 }]);
  });
});

describe("tenant export SQL helpers", () => {
  it("builds allowlisted PostgreSQL metadata row chunks with deterministic queries", async () => {
    const recording = createRecordingSql(adminDomainChunkSqlResults());

    const chunks = await buildTenantExportPostgresDataChunkFiles(recording.sql, orgId);

    expect(chunks.map((chunk) => chunk.metadata)).toEqual([
      expect.objectContaining({
        table: "admin_domains",
        path: "postgres/data/chunks/admin_domains/000000.jsonl",
        rowCount: 1,
        orderBy: ["lower(domain)", "created_at", "id"],
      }),
      expect.objectContaining({
        table: "admin_dns_records",
        path: "postgres/data/chunks/admin_dns_records/000000.jsonl",
        rowCount: 1,
        orderBy: ["domain_id", "record_type", "host", "id"],
      }),
    ]);
    expect(recording.calls[0]?.text).toContain(
      "select id, org_id, domain, is_primary, verification_status, verified_at",
    );
    expect(recording.calls[0]?.text).toContain("from admin_domains");
    expect(recording.calls[0]?.text).toContain("where org_id = ?");
    expect(recording.calls[0]?.text).toContain(
      "order by lower(domain) asc, created_at asc, id asc",
    );
    expect(recording.calls[1]?.text).toContain(
      "select id, org_id, domain_id, record_type, host, expected_value, observed_value",
    );
    expect(recording.calls[1]?.text).toContain("from admin_dns_records");
    expect(recording.calls[1]?.text).toContain("where org_id = ?");
    expect(recording.calls[1]?.text).toContain(
      "order by domain_id asc, record_type asc, host asc, id asc",
    );
    expect(recording.calls.flatMap((call) => call.values).every((value) => value === orgId)).toBe(
      true,
    );
    const combinedSql = recording.calls.map((call) => call.text).join("\n");
    expect(combinedSql).not.toContain("select *");
    expect(combinedSql).not.toContain("payload");
    expect(combinedSql).not.toContain("body");
    expect(combinedSql).not.toContain("hash");
    expect(combinedSql).not.toContain("secret_ref");
    expect(combinedSql).not.toContain("private_key_pem");
    expect(combinedSql).not.toContain("token");
    expect(combinedSql).not.toContain("webhook");
  });

  it("counts tenant rows through committed org-scoped tables only", async () => {
    const recording = createRecordingSql([
      [
        { table_name: "activity", row_count: 4 },
        { table_name: "objects", row_count: 2 },
      ],
    ]);

    await expect(countTenantExportRows(recording.sql, orgId)).resolves.toEqual([
      { table: "activity", rowCount: 4 },
      { table: "objects", rowCount: 2 },
    ]);
    expect(recording.calls[0]?.text).toContain("from objects where org_id = ?");
    expect(recording.calls[0]?.text).toContain("from activity where org_id = ?");
    expect(recording.calls[0]?.text).toContain("from admin_domains where org_id = ?");
    expect(recording.calls[0]?.text).toContain("from admin_dns_records where org_id = ?");
    expect(recording.calls[0]?.text).toContain(
      "from message_attachments join messages on messages.id = message_attachments.message_id where messages.org_id = ?",
    );
    expect(recording.calls[0]?.text).toContain(
      "from app_passwords join actors on actors.id = app_passwords.actor_id where actors.org_id = ?",
    );
    expect(recording.calls[0]?.text).toContain(
      "from agent_credentials join actors on actors.id = agent_credentials.actor_id where actors.org_id = ?",
    );
    expect(recording.calls[0]?.text).toContain(
      "from tenant_storage_migration_jobs where org_id = ?",
    );
    expect(recording.calls[0]?.text).not.toContain("select *");
    expect(recording.calls[0]?.text).not.toContain("payload ");
    expect(recording.calls[0]?.text).not.toContain("body ");
    expect(recording.calls[0]?.text).not.toContain("hash ");
    expect(recording.calls[0]?.text).not.toContain("secret_ref");
    expect(recording.calls[0]?.text).not.toContain("signup_email_verifications");
    expect(recording.calls[0]?.text).not.toContain("metering_events");
    expect(recording.calls[0]?.values.every((value) => value === orgId)).toBe(true);
  });

  it("summarizes tenant audit range without exposing activity payloads", async () => {
    const recording = createRecordingSql([
      [
        {
          row_count: 2,
          first_entry_at: new Date("2026-05-24T09:00:00.000Z"),
          last_entry_at: new Date("2026-05-24T09:30:00.000Z"),
        },
      ],
    ]);

    await expect(summarizeTenantExportAudit(recording.sql, orgId)).resolves.toEqual({
      rowCount: 2,
      firstEntryAt: "2026-05-24T09:00:00.000Z",
      lastEntryAt: "2026-05-24T09:30:00.000Z",
    });
    expect(recording.calls[0]?.text).toContain("from activity");
    expect(recording.calls[0]?.text).not.toContain("payload");
  });
});

describe("PostgresTenantExportJobStore", () => {
  it("creates, lists, claims, and completes durable tenant export jobs", async () => {
    const startedAt = new Date("2026-05-24T10:01:00.000Z");
    const recording = createRecordingSql([
      [exportJobRow({ id: "job-1", status: "queued", presigned_url_expires_seconds: 86_400 })],
      [
        exportJobRow({ id: "job-new", created_at: new Date("2026-05-24T10:05:00.000Z") }),
        exportJobRow({ id: "job-old", created_at: new Date("2026-05-24T10:00:00.000Z") }),
      ],
      [exportJobRow({ id: "job-1", status: "running", attempt_count: 1, started_at: startedAt })],
      [
        exportJobRow({
          id: "job-1",
          status: "succeeded",
          storage_key: "tenant-exports/jobs/org/job/archive.tar",
          filename: "helix-export-acme.tar",
          content_type: "application/x-tar",
          byte_size: "4096",
          started_at: startedAt,
          completed_at: new Date("2026-05-24T10:02:00.000Z"),
        }),
      ],
      [
        { status: "queued", count: 2 },
        { status: "running", count: "1" },
        { status: "failed", count: 1 },
      ],
      [{ count: "1", oldest_age_seconds: "1900" }],
    ]);
    const store = new PostgresTenantExportJobStore(recording.sql);

    const created = await store.create({
      orgId,
      includeObjectBytes: true,
      presignedUrlExpiresSeconds: 86_400,
      requestedByActorId: actorId,
    });
    const listed = await store.listForOrg({
      orgId,
      limit: 25,
      cursor: { createdAt: new Date("2026-05-24T10:10:00.000Z"), id: jobId(9) },
      status: "queued",
    });
    const claimed = await store.claimPending({ limit: 1 });
    const completed = await store.markCompleted({
      id: "job-1",
      artifact: {
        byteSize: 4096,
        contentType: "application/x-tar",
        filename: "helix-export-acme.tar",
        storageKey: "tenant-exports/jobs/org/job/archive.tar",
      },
    });
    const snapshot = await store.getObservabilitySnapshot({
      stalledBefore: new Date("2026-05-24T10:10:00.000Z"),
      now: new Date("2026-05-24T10:40:00.000Z"),
    });

    expect(created).toMatchObject({
      id: "job-1",
      status: "queued",
      includeObjectBytes: true,
      presignedUrlExpiresSeconds: 86_400,
      requestedByActorId: actorId,
    });
    expect(listed.map((job) => job.id)).toEqual(["job-new", "job-old"]);
    expect(claimed[0]).toMatchObject({ id: "job-1", status: "running", attemptCount: 1 });
    expect(completed).toMatchObject({
      id: "job-1",
      status: "succeeded",
      storageKey: "tenant-exports/jobs/org/job/archive.tar",
      filename: "helix-export-acme.tar",
      byteSize: 4096,
    });
    expect(snapshot).toEqual({
      activeJobs: [
        { status: "queued", count: 2 },
        { status: "running", count: 1 },
        { status: "failed", count: 1 },
      ],
      stalledJobs: { count: 1, oldestAgeSeconds: 1900 },
    });
    expect(recording.calls[1]?.text).toContain("(created_at, id) <");
    expect(recording.calls[2]?.text).toContain("for update skip locked");
    expect(recording.calls[3]?.text).toContain("storage_key = ?");
    expect(recording.calls[4]?.text).toContain("group by status");
    expect(recording.calls[5]?.text).toContain("status = 'running'");
  });
});

describe("registerTenantExportRoutes", () => {
  it("returns a tenant export manifest and audits the planning event", async () => {
    const auditRecords: unknown[] = [];
    const app = fastify();
    await registerTenantExportRoutes(app, {
      orgs: new InMemoryOrgStore([orgRecord()]),
      actorFromRequest: () => actor(),
      exportPlanner: () => tenantExportManifest(),
      auditSink: auditSink(auditRecords),
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/tenants/acme/export/manifest",
      headers: { "user-agent": "test-agent" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ manifest: tenantExportManifest() });
    expect(auditRecords).toContainEqual(
      expect.objectContaining({
        verb: "tenant.export.planned",
        objectType: "tenant",
        objectId: orgId,
        metadata: expect.objectContaining({
          slug: "acme",
          objectCount: 2,
          totalKnownBytes: 35,
          tableCount: 1,
          auditRowCount: 2,
        }) as unknown,
      }),
    );
    await app.close();
  });

  it("returns a tenant export manifest with presigned self-fetch object delivery", async () => {
    const storage = new MemoryStorageClient([
      { key: "drive/report.txt", body: Buffer.from("report bytes", "utf8") },
      { key: "slides/deck-1/versions/2", body: Buffer.from("deck bytes", "utf8") },
    ]);
    const auditRecords: unknown[] = [];
    const app = fastify();
    await registerTenantExportRoutes(app, {
      orgs: new InMemoryOrgStore([orgRecord()]),
      actorFromRequest: () => actor(),
      exportPlanner: () => tenantExportManifest(),
      storageResolver: storageResolverFor(storage),
      auditSink: auditSink(auditRecords),
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/tenants/acme/export/manifest?objectByteDelivery=self-fetch&presignedUrlExpiresSeconds=300",
      headers: { "user-agent": "test-agent" },
    });
    const body: {
      readonly manifest: TenantExportManifest;
      readonly delivery: {
        readonly delivery: string;
        readonly expiresSeconds: number;
        readonly objects: readonly { readonly storageKey: string; readonly url: string }[];
      };
    } = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.manifest).toEqual(tenantExportManifest());
    expect(body.delivery).toMatchObject({
      delivery: "self-fetch",
      expiresSeconds: 300,
      objects: [
        {
          storageKey: "drive/report.txt",
          url: "https://storage.example/drive%2Freport.txt?expires=300",
        },
        {
          storageKey: "slides/deck-1/versions/2",
          url: "https://storage.example/slides%2Fdeck-1%2Fversions%2F2?expires=300",
        },
      ],
    });
    expect(storage.gets).toEqual([]);
    expect(auditRecords).toContainEqual(
      expect.objectContaining({
        verb: "tenant.export.planned",
        metadata: expect.objectContaining({
          objectByteDelivery: "self-fetch",
          objectCount: 2,
          totalKnownBytes: 35,
        }) as unknown,
      }),
    );
    await app.close();
  });

  it("returns a clear service error when self-fetch delivery cannot be presigned", async () => {
    const auditRecords: unknown[] = [];
    const app = fastify();
    await registerTenantExportRoutes(app, {
      orgs: new InMemoryOrgStore([orgRecord()]),
      actorFromRequest: () => actor(),
      exportPlanner: () => tenantExportManifest(),
      storageResolver: storageResolverFor(new NoPresignStorageClient()),
      auditSink: auditSink(auditRecords),
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/tenants/acme/export/manifest?objectByteDelivery=self-fetch",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: "Tenant export storage does not support presigned object fetch.",
      code: "tenant_export_delivery_unavailable",
    });
    expect(auditRecords).toEqual([]);
    await app.close();
  });

  it("returns a tenant export tar archive with BYO/default object bytes when requested", async () => {
    const storage = new MemoryStorageClient([
      { key: "drive/report.txt", body: Buffer.from("report bytes", "utf8") },
      { key: "slides/deck-1/versions/2", body: asyncBytes("deck bytes from storage") },
    ]);
    const auditRecords: unknown[] = [];
    const app = fastify();
    await registerTenantExportRoutes(app, {
      orgs: new InMemoryOrgStore([orgRecord()]),
      actorFromRequest: () => actor(),
      exportPlanner: () => tenantExportManifest(),
      storageResolver: storageResolverFor(storage),
      auditSink: auditSink(auditRecords),
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/tenants/acme/export?includeObjectBytes=true",
    });
    const entries = parseTarEntries(rawPayload(response));

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/x-tar");
    expect(response.headers["accept-ranges"]).toBe("bytes");
    expect(response.headers["content-length"]).toBe(String(rawPayload(response).byteLength));
    expect(response.headers["content-disposition"]).toBe(
      'attachment; filename="helix-export-acme-20260524T100000Z.tar"',
    );
    expect(entries["objects/drive/report.txt"]).toBe("report bytes");
    expect(entries["objects/slides/deck-1/versions/2"]).toBe("deck bytes from storage");
    expect(auditRecords).toContainEqual(
      expect.objectContaining({
        verb: "tenant.exported",
        metadata: expect.objectContaining({
          bytesIncluded: true,
          byteSize: rawPayload(response).byteLength,
          objectByteDelivery: "archive",
          streaming: true,
        }) as unknown,
      }),
    );
    await app.close();
  });

  it("serves bounded, open-ended, and suffix byte ranges for tenant export archives", async () => {
    const app = fastify();
    await registerTenantExportRoutes(app, {
      orgs: new InMemoryOrgStore([orgRecord()]),
      actorFromRequest: () => actor(),
      exportPlanner: () => tenantExportManifest(),
    });
    const expectedArchive = await buildTenantExportArchive(tenantExportManifest());
    const expectedArchiveSize = String(expectedArchive.byteSize);
    const openEndedStart = 100;
    const openEndedEnd = expectedArchive.byteSize - 1;
    const suffixStart = expectedArchive.byteSize - 64;
    const suffixEnd = expectedArchive.byteSize - 1;

    const bounded = await app.inject({
      method: "GET",
      url: "/api/admin/tenants/acme/export",
      headers: { range: "bytes=0-99" },
    });
    const openEnded = await app.inject({
      method: "GET",
      url: "/api/admin/tenants/acme/export",
      headers: { range: "bytes=100-" },
    });
    const suffix = await app.inject({
      method: "GET",
      url: "/api/admin/tenants/acme/export",
      headers: { range: "bytes=-64" },
    });

    expect(bounded.statusCode).toBe(206);
    expect(bounded.headers["accept-ranges"]).toBe("bytes");
    expect(bounded.headers["content-length"]).toBe("100");
    expect(bounded.headers["content-range"]).toBe(`bytes 0-99/${expectedArchiveSize}`);
    expect(rawPayload(bounded)).toEqual(expectedArchive.bytes.subarray(0, 100));

    expect(openEnded.statusCode).toBe(206);
    expect(openEnded.headers["content-length"]).toBe(
      String(expectedArchive.byteSize - openEndedStart),
    );
    expect(openEnded.headers["content-range"]).toBe(
      `bytes ${String(openEndedStart)}-${String(openEndedEnd)}/${expectedArchiveSize}`,
    );
    expect(rawPayload(openEnded)).toEqual(expectedArchive.bytes.subarray(openEndedStart));

    expect(suffix.statusCode).toBe(206);
    expect(suffix.headers["content-length"]).toBe("64");
    expect(suffix.headers["content-range"]).toBe(
      `bytes ${String(suffixStart)}-${String(suffixEnd)}/${expectedArchiveSize}`,
    );
    expect(rawPayload(suffix)).toEqual(expectedArchive.bytes.subarray(suffixStart));
    await app.close();
  });

  it("rejects malformed and unsatisfiable tenant export byte ranges without auditing success", async () => {
    const auditRecords: unknown[] = [];
    const app = fastify();
    await registerTenantExportRoutes(app, {
      orgs: new InMemoryOrgStore([orgRecord()]),
      actorFromRequest: () => actor(),
      exportPlanner: () => tenantExportManifest(),
      auditSink: auditSink(auditRecords),
    });
    const expectedArchive = await buildTenantExportArchive(tenantExportManifest());
    const expectedArchiveSize = String(expectedArchive.byteSize);

    const unsatisfiable = await app.inject({
      method: "GET",
      url: "/api/admin/tenants/acme/export",
      headers: { range: `bytes=${expectedArchiveSize}-` },
    });
    const multiRange = await app.inject({
      method: "GET",
      url: "/api/admin/tenants/acme/export",
      headers: { range: "bytes=0-1,2-3" },
    });

    expect(unsatisfiable.statusCode).toBe(416);
    expect(unsatisfiable.headers["accept-ranges"]).toBe("bytes");
    expect(unsatisfiable.headers["content-range"]).toBe(`bytes */${expectedArchiveSize}`);
    expect(unsatisfiable.json()).toMatchObject({
      code: "range_not_satisfiable",
    });
    expect(multiRange.statusCode).toBe(416);
    expect(multiRange.headers["content-range"]).toBe(`bytes */${expectedArchiveSize}`);
    expect(auditRecords).toEqual([]);
    await app.close();
  });

  it("returns a tenant export tar archive with a presigned self-fetch object manifest", async () => {
    const storage = new MemoryStorageClient([
      { key: "drive/report.txt", body: Buffer.from("report bytes", "utf8") },
      { key: "slides/deck-1/versions/2", body: Buffer.from("deck bytes", "utf8") },
    ]);
    const auditRecords: unknown[] = [];
    const app = fastify();
    await registerTenantExportRoutes(app, {
      orgs: new InMemoryOrgStore([orgRecord()]),
      actorFromRequest: () => actor(),
      exportPlanner: () => tenantExportManifest(),
      storageResolver: storageResolverFor(storage),
      auditSink: auditSink(auditRecords),
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/tenants/acme/export?includeObjectBytes=true&objectByteDelivery=self-fetch&presignedUrlExpiresSeconds=120",
    });
    const entries = parseTarEntries(rawPayload(response));
    const manifest = JSON.parse(entries["objects/self-fetch-manifest.json"] ?? "{}") as {
      readonly delivery: string;
      readonly expiresSeconds: number;
      readonly objects: readonly { readonly url: string }[];
    };

    expect(response.statusCode).toBe(200);
    expect(entries["objects/drive/report.txt"]).toBeUndefined();
    expect(manifest).toMatchObject({
      delivery: "self-fetch",
      expiresSeconds: 120,
    });
    expect(manifest.objects.map((object) => object.url)).toEqual([
      "https://storage.example/drive%2Freport.txt?expires=120",
      "https://storage.example/slides%2Fdeck-1%2Fversions%2F2?expires=120",
    ]);
    expect(auditRecords).toContainEqual(
      expect.objectContaining({
        verb: "tenant.exported",
        metadata: expect.objectContaining({
          bytesIncluded: false,
          objectByteDelivery: "self-fetch",
          filename: "helix-export-acme-20260524T100000Z.tar",
        }) as unknown,
      }),
    );
    await app.close();
  });

  it("materializes a tenant export archive artifact and audits the presigned URL handoff", async () => {
    const storage = new MemoryStorageClient([
      { key: "drive/report.txt", body: Buffer.from("report bytes", "utf8") },
      { key: "slides/deck-1/versions/2", body: Buffer.from("deck bytes", "utf8") },
    ]);
    const auditRecords: unknown[] = [];
    const app = fastify();
    await registerTenantExportRoutes(app, {
      orgs: new InMemoryOrgStore([orgRecord()]),
      actorFromRequest: () => actor(),
      exportPlanner: () => tenantExportManifest(),
      storageResolver: storageResolverFor(storage),
      auditSink: auditSink(auditRecords),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/tenants/acme/export/artifact",
      payload: { includeObjectBytes: true, presignedUrlExpiresSeconds: 1200 },
      headers: { "user-agent": "test-agent" },
    });
    const body: {
      readonly manifest: TenantExportManifest;
      readonly artifact: {
        readonly filename: string;
        readonly byteSize: number;
        readonly storageKey: string;
        readonly downloadUrl: string;
        readonly expiresSeconds: number;
      };
    } = response.json();
    const stored = storage.objects.get(body.artifact.storageKey);
    const entries = parseTarEntries(await collectBytesFromStorageObject(stored));

    expect(response.statusCode).toBe(201);
    expect(body.manifest).toEqual(tenantExportManifest());
    expect(body.artifact).toMatchObject({
      filename: "helix-export-acme-20260524T100000Z.tar",
      storageKey: "tenant-exports/acme/helix-export-acme-20260524T100000Z.tar",
      downloadUrl:
        "https://storage.example/tenant-exports%2Facme%2Fhelix-export-acme-20260524T100000Z.tar?expires=1200",
      expiresSeconds: 1200,
    });
    expect(body.artifact.byteSize).toBeGreaterThan(0);
    expect(entries["objects/drive/report.txt"]).toBe("report bytes");
    expect(entries["objects/slides/deck-1/versions/2"]).toBe("deck bytes");
    expect(auditRecords).toContainEqual(
      expect.objectContaining({
        verb: "tenant.export.artifact.created",
        metadata: expect.objectContaining({
          bytesIncluded: true,
          objectByteDelivery: "archive",
          storageKey: body.artifact.storageKey,
          presignedUrlExpiresSeconds: 1200,
        }) as unknown,
      }),
    );
    await app.close();
  });

  it("returns a clear service error when archive artifacts cannot be presigned", async () => {
    const auditRecords: unknown[] = [];
    const app = fastify();
    await registerTenantExportRoutes(app, {
      orgs: new InMemoryOrgStore([orgRecord()]),
      actorFromRequest: () => actor(),
      exportPlanner: () => tenantExportManifest(),
      storageResolver: storageResolverFor(new NoPresignStorageClient()),
      auditSink: auditSink(auditRecords),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/tenants/acme/export/artifact",
      payload: { includeObjectBytes: false },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: "Tenant export storage does not support presigned archive fetch.",
      code: "tenant_export_delivery_unavailable",
    });
    expect(auditRecords).toEqual([]);
    await app.close();
  });

  it("queues, lists, and reads durable tenant export jobs with presigned completed artifacts", async () => {
    const storage = new MemoryStorageClient([]);
    const auditRecords: unknown[] = [];
    const exportJobs = new InMemoryTenantExportJobStore([
      exportJobRecord({
        id: jobId(9),
        status: "succeeded",
        storageKey: "tenant-exports/jobs/org/job/archive.tar",
        filename: "helix-export-acme-20260524T100000Z.tar",
        contentType: "application/x-tar",
        byteSize: 2048,
        completedAt: new Date("2026-05-24T10:05:00.000Z"),
        createdAt: new Date("2026-05-24T10:00:00.000Z"),
      }),
    ]);
    const planner = vi.fn(() => tenantExportManifest());
    const app = fastify();
    await registerTenantExportRoutes(app, {
      orgs: new InMemoryOrgStore([orgRecord()]),
      actorFromRequest: () => actor(),
      exportPlanner: planner,
      exportJobs,
      storageResolver: storageResolverFor(storage),
      auditSink: auditSink(auditRecords),
    });

    const created = await app.inject({
      method: "POST",
      url: "/api/admin/tenants/acme/export/jobs",
      payload: { includeObjectBytes: true, presignedUrlExpiresSeconds: 1200 },
      headers: { "user-agent": "test-agent" },
    });
    const listed = await app.inject({
      method: "GET",
      url: "/api/admin/tenants/acme/export/jobs?limit=10&status=queued",
    });
    const completed = await app.inject({
      method: "GET",
      url: `/api/admin/tenants/acme/export/jobs/${jobId(9)}`,
    });

    expect(created.statusCode).toBe(202);
    expect(created.json()).toMatchObject({
      exportJob: {
        status: "queued",
        includeObjectBytes: true,
        presignedUrlExpiresSeconds: 1200,
        requestedByActorId: actorId,
        artifact: null,
      },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      exportJobs: [expect.objectContaining({ status: "queued" })],
      nextCursor: null,
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({
      exportJob: {
        id: jobId(9),
        status: "succeeded",
        artifact: {
          filename: "helix-export-acme-20260524T100000Z.tar",
          contentType: "application/x-tar",
          byteSize: 2048,
          storageKey: "tenant-exports/jobs/org/job/archive.tar",
          downloadUrl:
            "https://storage.example/tenant-exports%2Fjobs%2Forg%2Fjob%2Farchive.tar?expires=3600",
          expiresSeconds: 3600,
        },
      },
    });
    expect(planner).not.toHaveBeenCalled();
    expect(auditRecords).toContainEqual(
      expect.objectContaining({
        verb: "tenant.export.job.queued",
        objectType: "tenant_export_job",
        metadata: expect.objectContaining({
          includeObjectBytes: true,
          presignedUrlExpiresSeconds: 1200,
        }) as unknown,
      }),
    );
    await app.close();
  });

  it("enforces export job quota before queueing durable export jobs", async () => {
    const exportJobs = new InMemoryTenantExportJobStore([]);
    const app = fastify();
    await registerTenantExportRoutes(app, {
      orgs: new InMemoryOrgStore([orgRecord()]),
      actorFromRequest: () => actor(),
      exportPlanner: () => tenantExportManifest(),
      exportJobs,
      exportJobLimiter: new InMemoryTenantHourlyQuotaLimiter(),
      exportJobLimit: () => 0,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/tenants/acme/export/jobs",
      payload: { includeObjectBytes: true },
    });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({
      code: "quota_exceeded",
      quota: "export_jobs_per_hour",
    });
    expect(exportJobs.jobs).toEqual([]);
    await app.close();
  });

  it("rejects cross-tenant and non-admin export requests", async () => {
    const crossTenant = fastify();
    await registerTenantExportRoutes(crossTenant, {
      orgs: new InMemoryOrgStore([orgRecord({ id: otherOrgId })]),
      actorFromRequest: () => actor(),
      exportPlanner: () => tenantExportManifest(),
    });
    const forbiddenCrossTenant = await crossTenant.inject({
      method: "GET",
      url: "/api/admin/tenants/acme/export/manifest",
    });
    await crossTenant.close();

    const nonAdmin = fastify();
    await registerTenantExportRoutes(nonAdmin, {
      orgs: new InMemoryOrgStore([orgRecord()]),
      actorFromRequest: () => actor({ scopes: [] }),
      exportPlanner: () => tenantExportManifest(),
    });
    const forbiddenScope = await nonAdmin.inject({
      method: "GET",
      url: "/api/admin/tenants/acme/export/manifest",
    });

    expect(forbiddenCrossTenant.statusCode).toBe(403);
    expect(forbiddenScope.statusCode).toBe(403);
    await nonAdmin.close();
  });

  it("enforces export job quota before planning or reading storage", async () => {
    const publish = vi.fn(async () => undefined);
    const planner = vi.fn(() => tenantExportManifest());
    const storage = new MemoryStorageClient([]);
    const app = fastify();
    await registerTenantExportRoutes(app, {
      orgs: new InMemoryOrgStore([orgRecord()]),
      actorFromRequest: () => actor(),
      exportPlanner: planner,
      storageResolver: storageResolverFor(storage),
      exportJobLimiter: new InMemoryTenantHourlyQuotaLimiter(),
      exportJobLimit: () => 0,
      events: { publish },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/tenants/acme/export?includeObjectBytes=true",
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBeDefined();
    expect(response.json()).toMatchObject({
      code: "quota_exceeded",
      quota: "export_jobs_per_hour",
      limit: 0,
    });
    expect(planner).not.toHaveBeenCalled();
    expect(storage.gets).toEqual([]);
    expect(publish).toHaveBeenCalledWith(
      "quota.export_jobs.exceeded",
      expect.objectContaining({
        orgId,
        surface: "tenant.export.archive",
        metadata: { slug: "acme" },
      }),
      undefined,
    );
    await app.close();
  });
});

describe("TenantExportMaterializationWorker", () => {
  it("claims queued jobs, materializes archive artifacts, and marks success", async () => {
    const storage = new MemoryStorageClient([
      { key: "drive/report.txt", body: Buffer.from("report bytes", "utf8") },
      { key: "slides/deck-1/versions/2", body: Buffer.from("deck bytes", "utf8") },
    ]);
    const store = new InMemoryTenantExportJobStore([
      exportJobRecord({ id: jobId(1), status: "queued", includeObjectBytes: true }),
    ]);
    const metrics = new RecordingTenantExportMetrics();
    const worker = new TenantExportMaterializationWorker({
      store,
      metrics,
      orgs: new InMemoryOrgStore([orgRecord()]),
      exportPlanner: () => tenantExportManifest(),
      storageResolver: storageResolverFor(storage),
      now: () => new Date("2026-05-24T11:00:00.000Z"),
    });

    await expect(worker.runOnce()).resolves.toEqual({ claimed: 1, succeeded: 1, failed: 0 });

    const completed = store.jobs[0];
    expect(completed).toMatchObject({
      id: jobId(1),
      status: "succeeded",
      storageKey: `tenant-exports/jobs/${orgId}/${jobId(1)}/archive.tar`,
      filename: "helix-export-acme-20260524T100000Z.tar",
      contentType: "application/x-tar",
    });
    const stored = storage.objects.get(completed?.storageKey ?? "");
    const entries = parseTarEntries(await collectBytesFromStorageObject(stored));
    expect(entries["objects/drive/report.txt"]).toBe("report bytes");
    expect(entries["objects/slides/deck-1/versions/2"]).toBe("deck bytes");
    expect(metrics.jobs).toEqual([{ status: "succeeded", objectBytes: "included" }]);
    expect(metrics.snapshots).toEqual([
      {
        activeJobs: [],
        stalledJobs: { count: 0, oldestAgeSeconds: 0 },
      },
    ]);
  });

  it("marks export jobs failed when materialization cannot resolve storage", async () => {
    const store = new InMemoryTenantExportJobStore([
      exportJobRecord({ id: jobId(1), status: "queued", includeObjectBytes: true }),
    ]);
    const metrics = new RecordingTenantExportMetrics();
    const worker = new TenantExportMaterializationWorker({
      store,
      metrics,
      orgs: new InMemoryOrgStore([orgRecord()]),
      exportPlanner: () => tenantExportManifest(),
      storageResolver: () => undefined,
    });

    await expect(worker.runOnce()).resolves.toEqual({ claimed: 1, succeeded: 0, failed: 1 });

    expect(store.jobs[0]).toMatchObject({
      id: jobId(1),
      status: "failed",
      lastError: "Tenant storage resolver did not resolve storage for tenant export.",
    });
    expect(metrics.jobs).toEqual([{ status: "failed", objectBytes: "included" }]);
    expect(metrics.snapshots).toEqual([
      {
        activeJobs: [{ status: "failed", count: 1 }],
        stalledJobs: { count: 0, oldestAgeSeconds: 0 },
      },
    ]);
  });

  it("does not fail completed export work when metrics snapshot refresh fails", async () => {
    const storage = new MemoryStorageClient([]);
    const store = new InMemoryTenantExportJobStore(
      [exportJobRecord({ id: jobId(1), status: "queued", includeObjectBytes: false })],
      new Error("export metrics snapshot unavailable"),
    );
    const metrics = new RecordingTenantExportMetrics();
    const observedErrors: unknown[] = [];
    const worker = new TenantExportMaterializationWorker({
      store,
      metrics,
      orgs: new InMemoryOrgStore([orgRecord()]),
      exportPlanner: () => tenantExportManifest(),
      storageResolver: storageResolverFor(storage),
      onError: (error) => observedErrors.push(error),
    });

    await expect(worker.runOnce()).resolves.toEqual({ claimed: 1, succeeded: 1, failed: 0 });

    expect(metrics.jobs).toEqual([{ status: "succeeded", objectBytes: "metadata_only" }]);
    expect(metrics.snapshots).toEqual([]);
    expect(observedErrors).toHaveLength(1);
    expect(observedErrors[0]).toBeInstanceOf(Error);
  });
});

function tenantExportManifest(
  input: {
    readonly rowDataChunkFiles?: readonly TenantExportPostgresDataChunkFile[] | undefined;
  } = {},
): TenantExportManifest {
  return buildTenantExportManifest({
    org: orgRecord(),
    generatedAt: new Date("2026-05-24T10:00:00.000Z"),
    objects: [
      { storageKey: "drive/report.txt", byteSize: 12, sha256: "abc" },
      { storageKey: "slides/deck-1/versions/2", byteSize: 23, sha256: "def" },
    ],
    rowCounts: [{ table: "activity", rowCount: 4 }],
    auditSummary: {
      rowCount: 2,
      firstEntryAt: "2026-05-24T09:00:00.000Z",
      lastEntryAt: "2026-05-24T09:30:00.000Z",
    },
    ...(input.rowDataChunkFiles === undefined
      ? {}
      : { rowDataChunkFiles: input.rowDataChunkFiles }),
  });
}

async function tenantExportAdminDomainChunkFiles(): Promise<
  readonly TenantExportPostgresDataChunkFile[]
> {
  const recording = createRecordingSql(adminDomainChunkSqlResults());
  return buildTenantExportPostgresDataChunkFiles(recording.sql, orgId);
}

function adminDomainChunkSqlResults(): readonly unknown[][] {
  return [
    [
      {
        id: "44444444-4444-4444-8444-444444444444",
        org_id: orgId,
        domain: "example.com",
        is_primary: true,
        verification_status: "verified",
        verified_at: new Date("2026-05-24T09:30:00.000Z"),
        created_by: actorId,
        created_at: new Date("2026-05-24T09:00:00.000Z"),
        updated_at: new Date("2026-05-24T09:30:00.000Z"),
      },
    ],
    [
      {
        id: "55555555-5555-4555-8555-555555555555",
        org_id: orgId,
        domain_id: "44444444-4444-4444-8444-444444444444",
        record_type: "TXT",
        host: "_helix.example.com",
        expected_value: "helix-verification=abc",
        observed_value: "helix-verification=abc",
        status: "verified",
        last_checked_at: new Date("2026-05-24T09:25:00.000Z"),
        created_at: new Date("2026-05-24T09:00:00.000Z"),
        updated_at: new Date("2026-05-24T09:25:00.000Z"),
      },
    ],
  ];
}

function orgRecord(overrides: Partial<OrgRecord> = {}): OrgRecord {
  return {
    id: orgId,
    slug: "acme",
    displayName: "Acme",
    status: "active",
    tier: "business",
    planId: "business",
    region: "us-east-1",
    byoConfig: { storage: { kind: "helix-default" } },
    featureFlags: { byo_storage: true },
    quotas: { export_jobs_per_hour: 1 },
    branding: { display_name_override: "Acme" },
    suspendedAt: null,
    softDeletedAt: null,
    hardDeletedAt: null,
    ...overrides,
  };
}

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    id: actorId,
    orgId,
    type: "user",
    scopes: ["admin.tenants.export"],
    ...overrides,
  };
}

function exportJobRecord(overrides: Partial<TenantExportJobRecord> = {}): TenantExportJobRecord {
  return {
    id: jobId(1),
    orgId,
    status: "queued",
    includeObjectBytes: true,
    presignedUrlExpiresSeconds: 3600,
    requestedByActorId: actorId,
    storageKey: null,
    filename: null,
    contentType: null,
    byteSize: null,
    lastError: null,
    attemptCount: 0,
    startedAt: null,
    completedAt: null,
    createdAt: new Date("2026-05-24T10:00:00.000Z"),
    updatedAt: new Date("2026-05-24T10:00:00.000Z"),
    ...overrides,
  };
}

function exportJobRow(
  overrides: Partial<{
    readonly id: string;
    readonly org_id: string;
    readonly status: string;
    readonly include_object_bytes: boolean;
    readonly presigned_url_expires_seconds: number;
    readonly requested_by_actor_id: string | null;
    readonly storage_key: string | null;
    readonly filename: string | null;
    readonly content_type: string | null;
    readonly byte_size: number | string | null;
    readonly last_error: string | null;
    readonly attempt_count: number;
    readonly started_at: Date | null;
    readonly completed_at: Date | null;
    readonly created_at: Date;
    readonly updated_at: Date;
  }> = {},
) {
  return {
    id: jobId(1),
    org_id: orgId,
    status: "queued",
    include_object_bytes: true,
    presigned_url_expires_seconds: 3600,
    requested_by_actor_id: actorId,
    storage_key: null,
    filename: null,
    content_type: null,
    byte_size: null,
    last_error: null,
    attempt_count: 0,
    started_at: null,
    completed_at: null,
    created_at: new Date("2026-05-24T10:00:00.000Z"),
    updated_at: new Date("2026-05-24T10:00:00.000Z"),
    ...overrides,
  };
}

function jobId(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

class InMemoryOrgStore implements Pick<OrgStore, "findById" | "findBySlug"> {
  constructor(private readonly orgs: readonly OrgRecord[]) {}

  async findById(id: string): Promise<OrgRecord | null> {
    return this.orgs.find((org) => org.id === id) ?? null;
  }

  async findBySlug(slug: string): Promise<OrgRecord | null> {
    return this.orgs.find((org) => org.slug === slug) ?? null;
  }
}

class InMemoryTenantExportJobStore implements TenantExportJobStore {
  readonly jobs: TenantExportJobRecord[];

  constructor(
    jobs: readonly TenantExportJobRecord[],
    private readonly snapshot: Error | TenantExportJobObservabilitySnapshot = {
      activeJobs: [],
      stalledJobs: { count: 0, oldestAgeSeconds: 0 },
    },
  ) {
    this.jobs = [...jobs];
  }

  async create(
    input: Parameters<TenantExportJobStore["create"]>[0],
  ): Promise<TenantExportJobRecord> {
    const job = exportJobRecord({
      id: jobId(this.jobs.length + 1),
      orgId: input.orgId,
      includeObjectBytes: input.includeObjectBytes ?? true,
      presignedUrlExpiresSeconds: input.presignedUrlExpiresSeconds ?? 86_400,
      requestedByActorId: input.requestedByActorId ?? null,
      status: "queued",
    });
    this.jobs.unshift(job);
    return job;
  }

  async findByIdForOrg(
    input: Parameters<TenantExportJobStore["findByIdForOrg"]>[0],
  ): Promise<TenantExportJobRecord | null> {
    return this.jobs.find((job) => job.id === input.id && job.orgId === input.orgId) ?? null;
  }

  async listForOrg(
    input: Parameters<TenantExportJobStore["listForOrg"]>[0],
  ): Promise<readonly TenantExportJobRecord[]> {
    return this.jobs
      .filter((job) => job.orgId === input.orgId)
      .filter((job) => input.status === undefined || job.status === input.status)
      .slice(0, input.limit ?? 50);
  }

  async claimPending(): Promise<readonly TenantExportJobRecord[]> {
    const pending = this.jobs.filter((job) => job.status === "queued" || job.status === "failed");
    for (const job of pending) {
      this.replaceJob(job.id, {
        ...job,
        status: "running",
        attemptCount: job.attemptCount + 1,
        lastError: null,
        startedAt: job.startedAt ?? new Date("2026-05-24T10:01:00.000Z"),
        updatedAt: new Date("2026-05-24T10:01:00.000Z"),
      });
    }
    return pending.map((job) => ({
      ...job,
      status: "running",
      attemptCount: job.attemptCount + 1,
    }));
  }

  async markCompleted(
    input: Parameters<TenantExportJobStore["markCompleted"]>[0],
  ): Promise<TenantExportJobRecord> {
    const current = this.jobs.find((job) => job.id === input.id);
    if (current === undefined) {
      throw new Error("job not found");
    }
    const updated: TenantExportJobRecord = {
      ...current,
      status: "succeeded",
      storageKey: input.artifact.storageKey,
      filename: input.artifact.filename,
      contentType: input.artifact.contentType,
      byteSize: input.artifact.byteSize,
      lastError: null,
      completedAt: new Date("2026-05-24T10:02:00.000Z"),
      updatedAt: new Date("2026-05-24T10:02:00.000Z"),
    };
    this.replaceJob(input.id, updated);
    return updated;
  }

  async markFailed(
    input: Parameters<TenantExportJobStore["markFailed"]>[0],
  ): Promise<TenantExportJobRecord> {
    const current = this.jobs.find((job) => job.id === input.id);
    if (current === undefined) {
      throw new Error("job not found");
    }
    const updated: TenantExportJobRecord = {
      ...current,
      status: "failed",
      lastError: input.error,
      completedAt: new Date("2026-05-24T10:02:00.000Z"),
      updatedAt: new Date("2026-05-24T10:02:00.000Z"),
    };
    this.replaceJob(input.id, updated);
    return updated;
  }

  async getObservabilitySnapshot(): Promise<TenantExportJobObservabilitySnapshot> {
    if (this.snapshot instanceof Error) {
      throw this.snapshot;
    }
    const activeStatuses = new Set(this.snapshot.activeJobs.map((entry) => entry.status));
    const activeJobs = [
      ...this.snapshot.activeJobs,
      ...(["queued", "running", "failed"] as const)
        .filter((status) => !activeStatuses.has(status))
        .map((status) => ({
          status,
          count: this.jobs.filter((job) => job.status === status).length,
        }))
        .filter((entry) => entry.count > 0),
    ];
    return {
      activeJobs,
      stalledJobs: this.snapshot.stalledJobs,
    };
  }

  private replaceJob(id: string, job: TenantExportJobRecord): void {
    const index = this.jobs.findIndex((candidate) => candidate.id === id);
    if (index >= 0) {
      this.jobs[index] = job;
    }
  }
}

class RecordingTenantExportMetrics implements TenantExportMetrics {
  readonly jobs: Parameters<TenantExportMetrics["recordTenantExportJob"]>[0][] = [];
  readonly snapshots: TenantExportJobObservabilitySnapshot[] = [];

  recordTenantExportJob(input: Parameters<TenantExportMetrics["recordTenantExportJob"]>[0]): void {
    this.jobs.push(input);
  }

  setTenantExportJobObservability(snapshot: TenantExportJobObservabilitySnapshot): void {
    this.snapshots.push(snapshot);
  }
}

class MemoryStorageClient implements TenantStorageClient {
  readonly gets: string[] = [];
  readonly presignedGets: { readonly key: string; readonly expiresSeconds: number | undefined }[] =
    [];
  readonly objects: Map<string, StorageObject>;

  constructor(objects: readonly StorageObject[]) {
    this.objects = new Map(objects.map((object) => [object.key, object]));
  }

  async put(object: StorageObject): Promise<void> {
    this.objects.set(object.key, object);
  }

  async get(key: string): Promise<StorageObject | null> {
    this.gets.push(key);
    return this.objects.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async presignGetUrl(
    key: string,
    options?: { readonly expiresSeconds?: number | undefined },
  ): Promise<string> {
    this.presignedGets.push({ key, expiresSeconds: options?.expiresSeconds });
    return `https://storage.example/${encodeURIComponent(key)}?expires=${String(
      options?.expiresSeconds ?? "",
    )}`;
  }
}

class NoPresignStorageClient implements TenantStorageClient {
  async put(): Promise<void> {
    return undefined;
  }

  async get(): Promise<StorageObject | null> {
    return null;
  }

  async delete(): Promise<void> {
    return undefined;
  }
}

function storageResolverFor(storage: TenantStorageClient): TenantStorageResolver {
  return () => ({
    client: storage,
    managedBy: "helix-default",
    prefix: `tenants/${orgId}/`,
  });
}

function auditSink(records: unknown[]) {
  return {
    async append(record: unknown): Promise<{ readonly id: string; readonly thisHash: string }> {
      records.push(record);
      return { id: "audit-1", thisHash: "hash-1" };
    },
  };
}

function createRecordingSql(results: readonly unknown[][]): {
  readonly sql: postgres.Sql;
  readonly calls: readonly { readonly text: string; readonly values: readonly unknown[] }[];
} {
  const calls: { readonly text: string; readonly values: readonly unknown[] }[] = [];
  let index = 0;
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("?"), values });
    const result = results[index] ?? [];
    index += 1;
    return Promise.resolve(result);
  }) as unknown as postgres.Sql;
  return { sql, calls };
}

async function* asyncBytes(value: string): AsyncIterable<Uint8Array> {
  yield Buffer.from(value, "utf8");
}

async function collectBytes(chunks: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const collected: Uint8Array[] = [];
  for await (const chunk of chunks) {
    collected.push(chunk);
  }
  return Buffer.concat(collected);
}

async function collectBytesFromStorageObject(object: StorageObject | undefined): Promise<Buffer> {
  if (object === undefined) {
    throw new Error("Expected storage object to exist.");
  }
  if (object.body instanceof Uint8Array) {
    return Buffer.from(object.body);
  }
  return collectBytes(object.body);
}

function rawPayload(response: { readonly rawPayload?: Buffer; readonly payload: string }): Buffer {
  return response.rawPayload ?? Buffer.from(response.payload, "binary");
}

function parseTarEntries(buffer: Buffer): Record<string, string> {
  const entries: Record<string, string> = {};
  for (let offset = 0; offset + 512 <= buffer.byteLength; ) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/u, "");
    const sizeOctal = header.subarray(124, 136).toString("ascii").replace(/\0.*$/u, "").trim();
    const size = Number.parseInt(sizeOctal, 8);
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    entries[name] = buffer.subarray(bodyStart, bodyEnd).toString("utf8");
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function parseJsonl(value: string): readonly unknown[] {
  if (value.trim().length === 0) {
    return [];
  }
  return value
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);
}
