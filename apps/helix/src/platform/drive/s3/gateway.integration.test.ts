import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { StorageClient } from "@helix/sdk-types";
import fastify, { type FastifyInstance } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TenantEnvelopeCipher } from "../../secrets/envelope.js";
import { contractStorage } from "../../../test-support/s3-storage.js";
import { registerDriveRoutes } from "../routes.js";
import { cleanupTestTenants } from "../../../test-support/cleanup-tenants.js";
import { skipUnlessLiveDatabase } from "../../../test-support/live-suite.js";
import { PostgresDriveStore } from "../store.js";
import { PostgresDriveS3AccessKeyStore } from "./access-keys.js";
import {
  DRIVE_S3_DISABLED_MESSAGE,
  registerDriveS3Gateway,
  type DriveS3AuditSink,
} from "./gateway.js";
import { DriveS3MultipartCleanupWorker } from "./multipart-cleanup.js";
import { PostgresDriveS3MultipartStore } from "./multipart-store.js";

const SKIP = skipUnlessLiveDatabase("Drive S3 gateway end-to-end (aws-sdk client-s3)");
const ORG_A = "5a3e0000-0000-4000-8000-00000000000a";
const ORG_B = "5a3e0000-0000-4000-8000-00000000000b";
const ACTOR_A = "5a3e0000-0000-4000-8000-0000000000a1";
const ACTOR_B = "5a3e0000-0000-4000-8000-0000000000b1";
const EICAR_MARKER = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR";

/** Writes the same hash-chained `activity` rows as the platform audit store. */
function activityAudit(sql: postgres.Sql): DriveS3AuditSink {
  return {
    async append(record) {
      await sql`
        insert into activity (org_id, actor_id, verb, object_type, object_id, trace_id, payload, prev_hash, this_hash, created_at)
        values (${record.orgId}, ${record.actorId}, ${record.verb}, ${record.objectType},
          ${record.objectId ?? null}, ${record.trace?.traceId ?? null},
          ${sql.json(JSON.parse(JSON.stringify(record.metadata ?? {})) as postgres.JSONValue)}, null, '', now())
      `;
    },
  };
}

async function errorOf(promise: Promise<unknown>): Promise<S3ServiceException> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof S3ServiceException) return error;
    throw error;
  }
  throw new Error("expected an S3 error");
}

describe.skipIf(SKIP)("Drive S3 gateway end-to-end", () => {
  const sql = postgres(process.env.DATABASE_URL ?? "", { max: 4, prepare: false });
  const cipher = new TenantEnvelopeCipher("s3-gateway-integration-master-secret-32+");
  const accessKeys = new PostgresDriveS3AccessKeyStore(sql, cipher);
  let app: FastifyInstance;
  let endpoint: string;
  let enabled = true;
  let clientA: S3Client;
  let clientB: S3Client;
  let keyA: { accessKeyId: string; secretAccessKey: string };
  let readOnlyKey: { accessKeyId: string; secretAccessKey: string };
  let driveStore: PostgresDriveStore;
  let stagingStorage: StorageClient;
  let multipartStore: PostgresDriveS3MultipartStore;
  let scannerDown = false;
  const collaboratorId = randomUUID();
  const collaborator = {
    id: collaboratorId,
    orgId: ORG_A,
    type: "user" as const,
    scopes: ["drive.read", "drive.write", "drive.delete"] as const,
  };

  function client(credentials: { accessKeyId: string; secretAccessKey: string }): S3Client {
    return new S3Client({
      endpoint,
      region: "us-east-1",
      forcePathStyle: true,
      credentials,
      maxAttempts: 1,
    });
  }

  beforeAll(async () => {
    await cleanupTestTenants(sql, [ORG_A, ORG_B]);
    await sql`
      insert into orgs (id, slug, display_name)
      values (${ORG_A}, 's3-gateway-a', 'S3 A'), (${ORG_B}, 's3-gateway-b', 'S3 B')
    `;
    await sql`
      insert into actors (id, org_id, type, display_name, email, scopes)
      values
        (${ACTOR_A}, ${ORG_A}, 'user', 'Ada', 'ada@s3-gateway-a.test',
          ${sql.array(["drive.read", "drive.write", "drive.delete"])}),
        (${ACTOR_B}, ${ORG_B}, 'user', 'Bo', 'bo@s3-gateway-b.test',
          ${sql.array(["drive.read", "drive.write", "drive.delete"])})
    `;
    const { storage } = await contractStorage();
    stagingStorage = storage;
    multipartStore = new PostgresDriveS3MultipartStore(sql);
    driveStore = new PostgresDriveStore(sql, storage, {
      requireVirusScanner: false,
      virusScanner: {
        kind: "clamav",
        async scan(bytes) {
          if (scannerDown) throw new Error("clamd is unreachable");
          const text = Buffer.from(bytes as Uint8Array).toString("latin1");
          return text.includes(EICAR_MARKER)
            ? { clean: false, signature: "Eicar-Test-Signature" }
            : { clean: true };
        },
      },
    });
    app = fastify();
    await registerDriveRoutes(app, {
      store: driveStore,
      requireTls: false,
      appPasswords: {
        authenticateAppPassword: async ({ username, password }) =>
          username === collaboratorId && password === "test-only" ? collaborator : null,
      },
    });
    await registerDriveS3Gateway(app, {
      store: driveStore,
      accessKeys,
      multipart: multipartStore,
      resolveStorage: async () => storage,
      audit: activityAudit(sql),
      isEnabled: () => enabled,
      resolveOrgSlug: async (orgId) => (orgId === ORG_A ? "s3-gateway-a" : "s3-gateway-b"),
      limits: { maxObjectBytes: 16 * 1024 * 1024, maxOpenMultipartUploads: 3 },
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    endpoint = `http://127.0.0.1:${String(address.port)}/s3`;
    const createdA = await accessKeys.create({
      orgId: ORG_A,
      actorId: ACTOR_A,
      label: "laptop",
      scopes: ["drive.read", "drive.write", "drive.delete"],
    });
    keyA = {
      accessKeyId: createdA.accessKey.accessKeyId,
      secretAccessKey: createdA.secretAccessKey,
    };
    const createdReadOnly = await accessKeys.create({
      orgId: ORG_A,
      actorId: ACTOR_A,
      label: "backup reader",
      scopes: ["drive.read"],
    });
    readOnlyKey = {
      accessKeyId: createdReadOnly.accessKey.accessKeyId,
      secretAccessKey: createdReadOnly.secretAccessKey,
    };
    const createdB = await accessKeys.create({
      orgId: ORG_B,
      actorId: ACTOR_B,
      label: "other org",
      scopes: ["drive.read", "drive.write", "drive.delete"],
    });
    clientA = client(keyA);
    clientB = client({
      accessKeyId: createdB.accessKey.accessKeyId,
      secretAccessKey: createdB.secretAccessKey,
    });
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants(sql, [ORG_A, ORG_B]);
    await sql.end();
  });

  it("stores the secret as a tenant envelope, never in plaintext", async () => {
    const rows = await sql<{ secret_envelope: string }[]>`
      select secret_envelope from drive_s3_access_keys where access_key_id = ${keyA.accessKeyId}
    `;
    expect(rows[0]?.secret_envelope).toMatch(/^helix\$1\$/u);
    expect(rows[0]?.secret_envelope).not.toContain(keyA.secretAccessKey);
  });

  it("lists the Drive buckets and answers HeadBucket", async () => {
    const buckets = await clientA.send(new ListBucketsCommand({}));
    expect(buckets.Buckets?.map((bucket) => bucket.Name)).toEqual(["my-drive", "shared-with-me"]);
    await expect(
      clientA.send(new HeadBucketCommand({ Bucket: "my-drive" })),
    ).resolves.toBeDefined();
    expect((await errorOf(clientA.send(new HeadBucketCommand({ Bucket: "nope" })))).name).toBe(
      "NotFound",
    );
  });

  it("puts into implicit folders, gets with Range, heads, and lists with a delimiter", async () => {
    const put = await clientA.send(
      new PutObjectCommand({
        Bucket: "my-drive",
        Key: "reports/2026/q3.txt",
        Body: "quarterly numbers: 42",
        ContentType: "text/plain",
        Metadata: { mtime: "1760000000" },
      }),
    );
    expect(put.ETag).toBe(`"${createHash("md5").update("quarterly numbers: 42").digest("hex")}"`);

    const ranged = await clientA.send(
      new GetObjectCommand({ Bucket: "my-drive", Key: "reports/2026/q3.txt", Range: "bytes=0-9" }),
    );
    expect(await ranged.Body?.transformToString()).toBe("quarterly ");
    expect(ranged.ContentRange).toBe("bytes 0-9/21");

    const head = await clientA.send(
      new HeadObjectCommand({ Bucket: "my-drive", Key: "reports/2026/q3.txt" }),
    );
    expect(head.ContentLength).toBe(21);
    expect(head.ETag).toBe(put.ETag);
    expect(head.Metadata).toEqual({ mtime: "1760000000" });

    await clientA.send(
      new PutObjectCommand({ Bucket: "my-drive", Key: "reports/summary.md", Body: "# summary" }),
    );
    const listed = await clientA.send(
      new ListObjectsV2Command({ Bucket: "my-drive", Prefix: "reports/", Delimiter: "/" }),
    );
    expect(listed.CommonPrefixes?.map((prefix) => prefix.Prefix)).toEqual(["reports/2026/"]);
    expect(listed.Contents?.map((object) => object.Key)).toEqual(["reports/summary.md"]);

    const recursive = await clientA.send(
      new ListObjectsV2Command({ Bucket: "my-drive", Prefix: "reports/", MaxKeys: 1 }),
    );
    expect(recursive.Contents?.map((object) => object.Key)).toEqual(["reports/2026/q3.txt"]);
    expect(recursive.IsTruncated).toBe(true);
    const next = await clientA.send(
      new ListObjectsV2Command({
        Bucket: "my-drive",
        Prefix: "reports/",
        ContinuationToken: recursive.NextContinuationToken,
      }),
    );
    expect(next.Contents?.map((object) => object.Key)).toEqual(["reports/summary.md"]);

    // The S3 folders are real Drive folders, visible through the Drive store.
    const root = await driveStore.list({ orgId: ORG_A, actorId: ACTOR_A, folderId: null });
    expect(root.entries.map((entry) => `${entry.type}:${entry.name}`)).toContain("folder:reports");
  });

  it("overwrites as a new Drive version and copies within the actor's access", async () => {
    await clientA.send(
      new PutObjectCommand({ Bucket: "my-drive", Key: "notes.txt", Body: "first" }),
    );
    await clientA.send(
      new PutObjectCommand({ Bucket: "my-drive", Key: "notes.txt", Body: "second" }),
    );
    const copied = await clientA.send(
      new CopyObjectCommand({
        Bucket: "my-drive",
        Key: "archive/notes-copy.txt",
        CopySource: "my-drive/notes.txt",
      }),
    );
    expect(copied.CopyObjectResult?.ETag).toMatch(/^"[0-9a-f]{32}"$/u);
    const body = await clientA.send(
      new GetObjectCommand({ Bucket: "my-drive", Key: "archive/notes-copy.txt" }),
    );
    expect(await body.Body?.transformToString()).toBe("second");
    const versions = await sql<{ count: number }[]>`
      select count(*)::int as count from drive_versions v
      join objects o on o.id = v.object_id
      where o.org_id = ${ORG_A} and o.metadata->>'name' = 'notes.txt'
    `;
    expect(versions[0]?.count).toBe(2);
  });

  it("deletes with Drive trash semantics, singly and in batches", async () => {
    await clientA.send(new PutObjectCommand({ Bucket: "my-drive", Key: "tmp/a.txt", Body: "a" }));
    await clientA.send(new PutObjectCommand({ Bucket: "my-drive", Key: "tmp/b.txt", Body: "b" }));
    await clientA.send(new PutObjectCommand({ Bucket: "my-drive", Key: "tmp/c.txt", Body: "c" }));
    await clientA.send(new DeleteObjectCommand({ Bucket: "my-drive", Key: "tmp/a.txt" }));
    const batch = await clientA.send(
      new DeleteObjectsCommand({
        Bucket: "my-drive",
        Delete: { Objects: [{ Key: "tmp/b.txt" }, { Key: "tmp/missing.txt" }] },
      }),
    );
    expect(batch.Deleted?.map((entry) => entry.Key).sort()).toEqual([
      "tmp/b.txt",
      "tmp/missing.txt",
    ]);
    const listed = await clientA.send(
      new ListObjectsV2Command({ Bucket: "my-drive", Prefix: "tmp/" }),
    );
    expect(listed.Contents?.map((object) => object.Key)).toEqual(["tmp/c.txt"]);
    const trashed = await sql<{ name: string }[]>`
      select metadata->>'name' as name from objects
      where org_id = ${ORG_A} and deleted_at is not null order by 1
    `;
    expect(trashed.map((row) => row.name)).toEqual(expect.arrayContaining(["a.txt", "b.txt"]));
  });

  it("completes a multipart upload with the S3 multipart ETag", async () => {
    const created = await clientA.send(
      new CreateMultipartUploadCommand({
        Bucket: "my-drive",
        Key: "video/big.bin",
        ContentType: "application/octet-stream",
      }),
    );
    const uploadId = created.UploadId ?? "";
    const first = Buffer.alloc(5 * 1024 * 1024, 7);
    const second = Buffer.from("tail");
    const part1 = await clientA.send(
      new UploadPartCommand({
        Bucket: "my-drive",
        Key: "video/big.bin",
        UploadId: uploadId,
        PartNumber: 1,
        Body: first,
      }),
    );
    const part2 = await clientA.send(
      new UploadPartCommand({
        Bucket: "my-drive",
        Key: "video/big.bin",
        UploadId: uploadId,
        PartNumber: 2,
        Body: second,
      }),
    );
    const parts = await clientA.send(
      new ListPartsCommand({ Bucket: "my-drive", Key: "video/big.bin", UploadId: uploadId }),
    );
    expect(parts.Parts?.map((part) => part.PartNumber)).toEqual([1, 2]);
    const completed = await clientA.send(
      new CompleteMultipartUploadCommand({
        Bucket: "my-drive",
        Key: "video/big.bin",
        UploadId: uploadId,
        MultipartUpload: {
          Parts: [
            { PartNumber: 1, ETag: part1.ETag ?? "" },
            { PartNumber: 2, ETag: part2.ETag ?? "" },
          ],
        },
      }),
    );
    expect(completed.ETag).toMatch(/^"[0-9a-f]{32}-2"$/u);
    const head = await clientA.send(
      new HeadObjectCommand({ Bucket: "my-drive", Key: "video/big.bin" }),
    );
    expect(head.ContentLength).toBe(first.byteLength + second.byteLength);
    expect(head.ETag).toBe(completed.ETag);
    const staged = await sql`select 1 from drive_s3_multipart_uploads where id = ${uploadId}`;
    expect(staged).toHaveLength(0);

    const aborted = await clientA.send(
      new CreateMultipartUploadCommand({ Bucket: "my-drive", Key: "video/aborted.bin" }),
    );
    await clientA.send(
      new AbortMultipartUploadCommand({
        Bucket: "my-drive",
        Key: "video/aborted.bin",
        UploadId: aborted.UploadId,
      }),
    );
    const missing = await errorOf(
      clientA.send(
        new ListPartsCommand({
          Bucket: "my-drive",
          Key: "video/aborted.bin",
          UploadId: aborted.UploadId,
        }),
      ),
    );
    expect(missing.name).toBe("NoSuchUpload");
  });

  it("serves presigned GET URLs and rejects tampered ones", async () => {
    await clientA.send(
      new PutObjectCommand({ Bucket: "my-drive", Key: "shared/link.txt", Body: "presigned!" }),
    );
    const url = await getSignedUrl(
      clientA,
      new GetObjectCommand({ Bucket: "my-drive", Key: "shared/link.txt" }),
      { expiresIn: 300 },
    );
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("presigned!");
    const tampered = await fetch(url.replace("link.txt", "other.txt"));
    expect(tampered.status).toBe(403);
    expect(await tampered.text()).toContain("<Code>SignatureDoesNotMatch</Code>");
  });

  it("rejects a wrong secret with SignatureDoesNotMatch and unknown keys", async () => {
    const wrong = client({ accessKeyId: keyA.accessKeyId, secretAccessKey: "not-the-secret" });
    expect((await errorOf(wrong.send(new ListBucketsCommand({})))).name).toBe(
      "SignatureDoesNotMatch",
    );
    const unknown = client({
      accessKeyId: "HLXAAAAAAAAAAAAAAAAA",
      secretAccessKey: keyA.secretAccessKey,
    });
    expect((await errorOf(unknown.send(new ListBucketsCommand({})))).name).toBe(
      "InvalidAccessKeyId",
    );
  });

  it("isolates tenants: another org's bucket is AccessDenied and its keys are invisible", async () => {
    const denied = await errorOf(
      clientB.send(new GetObjectCommand({ Bucket: "s3-gateway-a--my-drive", Key: "notes.txt" })),
    );
    expect(denied.name).toBe("AccessDenied");
    const missing = await errorOf(
      clientB.send(new GetObjectCommand({ Bucket: "my-drive", Key: "notes.txt" })),
    );
    expect(missing.name).toBe("NoSuchKey");
    const own = await clientA.send(
      new GetObjectCommand({ Bucket: "s3-gateway-a--my-drive", Key: "notes.txt" }),
    );
    expect(await own.Body?.transformToString()).toBe("second");
  });

  it("enforces key scopes", async () => {
    const reader = client(readOnlyKey);
    await expect(reader.send(new ListBucketsCommand({}))).resolves.toBeDefined();
    const denied = await errorOf(
      reader.send(new PutObjectCommand({ Bucket: "my-drive", Key: "nope.txt", Body: "x" })),
    );
    expect(denied.name).toBe("AccessDenied");
    expect(denied.message).toContain("drive.write");
  });

  it("honors same-tenant sharing, editor permissions and revocation across S3 and WebDAV", async () => {
    await sql`insert into actors (id, org_id, type, display_name, email, scopes)
      values (${collaboratorId}, ${ORG_A}, 'user', 'Collaborator', 'collaborator@s3-gateway-a.test',
        ${sql.array([...collaborator.scopes])})`;
    const credentials = await accessKeys.create({
      orgId: ORG_A,
      actorId: collaboratorId,
      label: "collaborator",
      scopes: collaborator.scopes,
    });
    const other = client({
      accessKeyId: credentials.accessKey.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    });
    const key = "ACL proof/private.txt";
    await clientA.send(
      new PutObjectCommand({ Bucket: "my-drive", Key: key, Body: "private content" }),
    );
    const get = () => other.send(new GetObjectCommand({ Bucket: "shared-with-me", Key: key }));
    const dav = (method: "GET" | "PUT", payload?: string) =>
      app.inject({
        method,
        url: "/dav/files/ACL%20proof/private.txt",
        headers: {
          authorization: `Basic ${Buffer.from(`${collaboratorId}:test-only`).toString("base64")}`,
          "content-type": "text/plain",
        },
        ...(payload === undefined ? {} : { payload }),
      });
    expect((await errorOf(get())).name).toBe("NoSuchKey");
    expect((await dav("GET")).statusCode).toBe(404);
    const folder = (await driveStore.list({ orgId: ORG_A, actorId: ACTOR_A })).entries.find(
      (entry) => entry.name === "ACL proof",
    );
    if (folder === undefined) throw new Error("Missing ACL fixture folder");
    const share = (role: "reader" | "editor") =>
      driveStore.share({
        orgId: ORG_A,
        actorId: ACTOR_A,
        objectId: folder.id,
        targetActorIds: [collaboratorId],
        role,
      });
    await share("reader");
    expect(await (await get()).Body?.transformToString()).toBe("private content");
    expect((await dav("GET")).body).toBe("private content");
    expect((await dav("PUT", "unauthorized")).statusCode).toBe(403);
    expect(
      (
        await errorOf(
          other.send(
            new PutObjectCommand({ Bucket: "shared-with-me", Key: key, Body: "unauthorized" }),
          ),
        )
      ).name,
    ).toBe("AccessDenied");
    await share("editor");
    await other.send(new PutObjectCommand({ Bucket: "shared-with-me", Key: key, Body: "S3 edit" }));
    expect((await dav("GET")).body).toBe("S3 edit");
    expect((await dav("PUT", "DAV edit")).statusCode).toBe(204);
    expect(await (await get()).Body?.transformToString()).toBe("DAV edit");
    const signed = await getSignedUrl(
      other,
      new GetObjectCommand({ Bucket: "shared-with-me", Key: key }),
      { expiresIn: 60 },
    );
    expect((await fetch(signed)).status).toBe(200);
    await driveStore.removeAccess({
      orgId: ORG_A,
      actorId: ACTOR_A,
      objectId: folder.id,
      targetActorId: collaboratorId,
    });
    expect((await errorOf(get())).name).toBe("NoSuchKey");
    expect((await fetch(signed)).status).toBe(404);
    expect((await dav("GET")).statusCode).toBe(404);
    expect(
      await (
        await clientA.send(new GetObjectCommand({ Bucket: "my-drive", Key: key }))
      ).Body?.transformToString(),
    ).toBe("DAV edit");
    other.destroy();
  });

  it("scans uploads and refuses to serve quarantined files", async () => {
    const rejected = await errorOf(
      clientA.send(
        new PutObjectCommand({ Bucket: "my-drive", Key: "malware.com", Body: EICAR_MARKER }),
      ),
    );
    expect(rejected.name).toBe("ObjectQuarantined");
    const get = await errorOf(
      clientA.send(new GetObjectCommand({ Bucket: "my-drive", Key: "malware.com" })),
    );
    expect(get.name).toBe("ObjectQuarantined");
    expect(get.message).toContain("malware scan");
  });

  it("refuses writes to the read-only shared-with-me root", async () => {
    const denied = await errorOf(
      clientA.send(new PutObjectCommand({ Bucket: "shared-with-me", Key: "x.txt", Body: "x" })),
    );
    expect(denied.name).toBe("AccessDenied");
  });

  it("answers unsupported operations with NotImplemented XML", async () => {
    const response = await fetch(`${endpoint}/my-drive?acl`);
    expect(response.status).toBe(501);
    expect(await response.text()).toContain("<Code>NotImplemented</Code>");
  });

  it("reports a disabled gateway as AccessDenied with the reason", async () => {
    enabled = false;
    try {
      const denied = await errorOf(clientA.send(new ListBucketsCommand({})));
      expect(denied.name).toBe("AccessDenied");
      expect(denied.message).toBe(DRIVE_S3_DISABLED_MESSAGE);
    } finally {
      enabled = true;
    }
  });

  it("revoked keys stop working", async () => {
    const extra = await accessKeys.create({
      orgId: ORG_A,
      actorId: ACTOR_A,
      label: "temporary",
      scopes: ["drive.read"],
    });
    const temporary = client({
      accessKeyId: extra.accessKey.accessKeyId,
      secretAccessKey: extra.secretAccessKey,
    });
    await expect(temporary.send(new ListBucketsCommand({}))).resolves.toBeDefined();
    await accessKeys.revoke({ orgId: ORG_A, id: extra.accessKey.id, actorId: ACTOR_A });
    expect((await errorOf(temporary.send(new ListBucketsCommand({})))).name).toBe(
      "InvalidAccessKeyId",
    );
  });

  it("rejects a presigned PUT carrying unsigned x-amz headers and ignores unsigned content headers", async () => {
    await clientA.send(
      new PutObjectCommand({ Bucket: "my-drive", Key: "private/source.txt", Body: "private" }),
    );
    const url = await getSignedUrl(
      clientA,
      new PutObjectCommand({ Bucket: "my-drive", Key: "drop/target.txt" }),
      { expiresIn: 300 },
    );
    const smuggled = await fetch(url, {
      method: "PUT",
      headers: { "x-amz-copy-source": "my-drive/private/source.txt" },
      body: "",
    });
    expect(smuggled.status).toBe(403);
    expect(await smuggled.text()).toContain("x-amz-copy-source");
    const injected = await fetch(url, {
      method: "PUT",
      headers: { "x-amz-meta-owner": "mallory" },
      body: "x",
    });
    expect(injected.status).toBe(403);
    const upload = await fetch(url, {
      method: "PUT",
      headers: { "content-type": "text/html" },
      body: "<p>hello</p>",
    });
    expect(upload.status).toBe(200);
    const head = await clientA.send(
      new HeadObjectCommand({ Bucket: "my-drive", Key: "drop/target.txt" }),
    );
    expect(head.ContentType).toBe("application/octet-stream");
  });

  it("caps staged multipart bytes and open uploads, and the worker purges expired ones", async () => {
    const created = await clientA.send(
      new CreateMultipartUploadCommand({ Bucket: "my-drive", Key: "caps/big.bin" }),
    );
    const uploadId = created.UploadId ?? "";
    const part = Buffer.alloc(6 * 1024 * 1024, 1);
    const upload = (partNumber: number) =>
      clientA.send(
        new UploadPartCommand({
          Bucket: "my-drive",
          Key: "caps/big.bin",
          UploadId: uploadId,
          PartNumber: partNumber,
          Body: part,
        }),
      );
    await upload(1);
    await upload(2);
    await upload(2); // replacing a part does not count it twice
    expect((await errorOf(upload(3))).name).toBe("EntityTooLarge");
    const parts = await clientA.send(
      new ListPartsCommand({ Bucket: "my-drive", Key: "caps/big.bin", UploadId: uploadId }),
    );
    expect(parts.Parts?.map((entry) => entry.PartNumber)).toEqual([1, 2]);

    const extra = [];
    for (const key of ["caps/b.bin", "caps/c.bin"]) {
      extra.push(
        (await clientA.send(new CreateMultipartUploadCommand({ Bucket: "my-drive", Key: key })))
          .UploadId,
      );
    }
    const capped = await errorOf(
      clientA.send(new CreateMultipartUploadCommand({ Bucket: "my-drive", Key: "caps/d.bin" })),
    );
    expect(capped.name).toBe("SlowDown");

    const staged = await sql<{ storage_key: string }[]>`
      select storage_key from drive_s3_multipart_parts where upload_id = ${uploadId}
    `;
    await sql`
      update drive_s3_multipart_uploads set expires_at = now() - interval '1 minute'
      where org_id = ${ORG_A}
    `;
    const worker = new DriveS3MultipartCleanupWorker({
      sql,
      multipart: multipartStore,
      resolveStorage: async () => stagingStorage,
      intervalMs: 60_000,
      batchSize: 100,
    });
    expect(await worker.runOnce()).toBeGreaterThanOrEqual(3);
    const remaining = await sql`select 1 from drive_s3_multipart_uploads where org_id = ${ORG_A}`;
    expect(remaining).toHaveLength(0);
    for (const row of staged) {
      await expect(stagingStorage.get(row.storage_key)).resolves.toBeNull();
    }
    expect(extra).toHaveLength(2);
  });

  it("fails with a retryable 503 instead of dropping bytes when scanning is unavailable", async () => {
    scannerDown = true;
    try {
      const put = await errorOf(
        clientA.send(
          new PutObjectCommand({ Bucket: "my-drive", Key: "scan/outage.txt", Body: "keep me" }),
        ),
      );
      expect(put.$metadata.httpStatusCode).toBe(503);
      expect(put.name).toBe("ServiceUnavailable");
      const created = await clientA.send(
        new CreateMultipartUploadCommand({ Bucket: "my-drive", Key: "scan/parts.bin" }),
      );
      const uploadId = created.UploadId ?? "";
      const part = await clientA.send(
        new UploadPartCommand({
          Bucket: "my-drive",
          Key: "scan/parts.bin",
          UploadId: uploadId,
          PartNumber: 1,
          Body: "only part",
        }),
      );
      const complete = () =>
        clientA.send(
          new CompleteMultipartUploadCommand({
            Bucket: "my-drive",
            Key: "scan/parts.bin",
            UploadId: uploadId,
            MultipartUpload: { Parts: [{ PartNumber: 1, ETag: part.ETag ?? "" }] },
          }),
        );
      expect((await errorOf(complete())).$metadata.httpStatusCode).toBe(503);
      scannerDown = false;
      await expect(complete()).resolves.toMatchObject({ ETag: expect.stringMatching(/-1"$/u) });
      const body = await clientA.send(
        new GetObjectCommand({ Bucket: "my-drive", Key: "scan/parts.bin" }),
      );
      expect(await body.Body?.transformToString()).toBe("only part");
    } finally {
      scannerDown = false;
    }
    const missing = await errorOf(
      clientA.send(new GetObjectCommand({ Bucket: "my-drive", Key: "scan/outage.txt" })),
    );
    expect(missing.name).toBe("NoSuchKey");
    await clientA.send(
      new PutObjectCommand({ Bucket: "my-drive", Key: "scan/outage.txt", Body: "keep me" }),
    );
  });

  it("records key use only after a valid signature, and CopyObject needs drive.read", async () => {
    const created = await accessKeys.create({
      orgId: ORG_A,
      actorId: ACTOR_A,
      label: "writer only",
      scopes: ["drive.write"],
    });
    const lastUsed = async () =>
      (
        await sql<{ last_used_at: Date | null }[]>`
          select last_used_at from drive_s3_access_keys where id = ${created.accessKey.id}
        `
      )[0]?.last_used_at ?? null;
    const forged = client({
      accessKeyId: created.accessKey.accessKeyId,
      secretAccessKey: "forged-secret",
    });
    await errorOf(forged.send(new ListBucketsCommand({})));
    expect(await lastUsed()).toBeNull();
    const writer = client({
      accessKeyId: created.accessKey.accessKeyId,
      secretAccessKey: created.secretAccessKey,
    });
    const denied = await errorOf(
      writer.send(
        new CopyObjectCommand({
          Bucket: "my-drive",
          Key: "copies/stolen.txt",
          CopySource: "my-drive/notes.txt",
        }),
      ),
    );
    expect(denied.name).toBe("AccessDenied");
    expect(denied.message).toContain("drive.read");
    expect(await lastUsed()).not.toBeNull();
  });

  it("audits every operation", async () => {
    const rows = await sql<{ verb: string }[]>`
      select distinct verb from activity where org_id = ${ORG_A} and verb like 'drive.s3.%'
    `;
    expect(rows.map((row) => row.verb)).toEqual(
      expect.arrayContaining([
        "drive.s3.put_object",
        "drive.s3.get_object",
        "drive.s3.list_objects",
        "drive.s3.delete_object",
        "drive.s3.complete_multipart_upload",
        "drive.s3.copy_object",
        "drive.s3.put_object.denied",
      ]),
    );
  });
});
