import { describe, expect, it } from "vitest";
import { createS3CompatibleStorage } from "./index.js";
import type { S3CompatibleStorageConfig, S3CompatibleStorageError } from "./index.js";

const now = () => new Date("2026-05-20T12:34:56.000Z");

interface FetchStub {
  readonly fetch: typeof fetch;
  readonly calls: FetchCall[];
}

type FetchCall = readonly [Parameters<typeof fetch>[0], Parameters<typeof fetch>[1]];
type FetchResponseFactory = (
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
) => Promise<Response> | Response;

function createFetchStub(
  factory: FetchResponseFactory = () => new Response(null, { status: 200 }),
): FetchStub {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push([input, init]);
    return factory(input, init);
  };
  return { fetch: fetchImpl, calls };
}

function xmlResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "application/xml" } });
}

function storage(
  fetchImpl: typeof fetch = createFetchStub().fetch,
  config: Partial<S3CompatibleStorageConfig> = {},
) {
  return createS3CompatibleStorage({
    endpoint: "http://rustfs.local:9000",
    region: "us-east-1",
    bucket: "helix-objects",
    credentials: {
      accessKeyId: "test-access",
      secretAccessKey: "test-secret",
      sessionToken: "test-token",
    },
    fetch: fetchImpl,
    now,
    ...config,
  });
}

function firstUrlCall(stub: FetchStub): readonly [URL, RequestInit] {
  return urlCall(stub, 0);
}

function urlCall(stub: FetchStub, index: number): readonly [URL, RequestInit] {
  const call = stub.calls[index];
  if (call === undefined) {
    throw new Error("Expected fetch to be called");
  }
  const [input, init] = call;
  if (!(input instanceof URL) || init === undefined) {
    throw new Error("Expected fetch to be called with a URL and request init");
  }
  return [input, init];
}

function requestHeaders(init: RequestInit): Record<string, string> {
  if (init.headers === undefined || Array.isArray(init.headers))
    throw new Error("Expected headers");
  if (init.headers instanceof Headers) {
    const headers: Record<string, string> = {};
    init.headers.forEach((value, name) => {
      headers[name] = value;
    });
    return headers;
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(init.headers)) {
    if (typeof value !== "string") {
      throw new Error(`Expected string request header for ${name}`);
    }
    headers[name] = value;
  }
  return headers;
}

function signedHeaders(init: RequestInit): string[] {
  return (
    /SignedHeaders=([^, ]+)/u.exec(requestHeaders(init).authorization ?? "")?.[1]?.split(";") ?? []
  );
}

describe("S3-compatible storage", () => {
  it("checks bucket health without mutating storage", async () => {
    const fetchStub = createFetchStub();

    await storage(fetchStub.fetch).checkHealth();

    expect(firstUrlCall(fetchStub)[1].method).toBe("HEAD");
    expect(firstUrlCall(fetchStub)[0].pathname).toBe("/helix-objects/");
  });

  it("fails closed unless TLS, SSE-KMS, versioning, and object lock match policy", async () => {
    expect(() =>
      storage(undefined, {
        securityPolicy: {
          requireTls: true,
          requireVersioning: true,
          objectLock: { mode: "COMPLIANCE", retentionDays: 30 },
        },
      }),
    ).toThrow("endpoint must use HTTPS");

    const fetchStub = createFetchStub((input) => {
      const url = input as URL;
      if (url.searchParams.has("encryption")) {
        return xmlResponse(
          `<ServerSideEncryptionConfiguration><Rule><ApplyServerSideEncryptionByDefault><SSEAlgorithm>aws:kms</SSEAlgorithm><KMSMasterKeyID>kms-key</KMSMasterKeyID></ApplyServerSideEncryptionByDefault></Rule></ServerSideEncryptionConfiguration>`,
        );
      }
      if (url.searchParams.has("versioning")) {
        return xmlResponse(`<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>`);
      }
      if (url.searchParams.has("object-lock")) {
        return xmlResponse(
          `<ObjectLockConfiguration><ObjectLockEnabled>Enabled</ObjectLockEnabled><Rule><DefaultRetention><Mode>COMPLIANCE</Mode><Days>30</Days></DefaultRetention></Rule></ObjectLockConfiguration>`,
        );
      }
      return new Response(null, { status: 200 });
    });
    const secured = storage(fetchStub.fetch, {
      endpoint: "https://storage.example.com",
      serverSideEncryption: "aws:kms",
      serverSideEncryptionAwsKmsKeyId: "kms-key",
      securityPolicy: {
        requireTls: true,
        requireVersioning: true,
        objectLock: { mode: "COMPLIANCE", retentionDays: 30 },
      },
    });

    await expect(secured.checkHealth()).resolves.toBeUndefined();
    expect(fetchStub.calls.map(([input]) => [...(input as URL).searchParams.keys()])).toEqual([
      [],
      ["encryption"],
      ["versioning"],
      ["object-lock"],
    ]);
  });

  it("reports a degraded bucket when retained-object policy is weaker than configured", async () => {
    const fetchStub = createFetchStub((input) => {
      const url = input as URL;
      if (url.searchParams.has("encryption")) {
        return xmlResponse(
          `<ServerSideEncryptionConfiguration><Rule><ApplyServerSideEncryptionByDefault><SSEAlgorithm>aws:kms</SSEAlgorithm><KMSMasterKeyID>kms-key</KMSMasterKeyID></ApplyServerSideEncryptionByDefault></Rule></ServerSideEncryptionConfiguration>`,
        );
      }
      if (url.searchParams.has("versioning")) {
        return xmlResponse(`<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>`);
      }
      if (url.searchParams.has("object-lock")) {
        return xmlResponse(
          `<ObjectLockConfiguration><ObjectLockEnabled>Enabled</ObjectLockEnabled><Rule><DefaultRetention><Mode>GOVERNANCE</Mode><Days>7</Days></DefaultRetention></Rule></ObjectLockConfiguration>`,
        );
      }
      return new Response(null, { status: 200 });
    });
    const secured = storage(fetchStub.fetch, {
      endpoint: "https://storage.example.com",
      serverSideEncryption: "aws:kms",
      serverSideEncryptionAwsKmsKeyId: "kms-key",
      securityPolicy: {
        requireTls: true,
        requireVersioning: true,
        objectLock: { mode: "COMPLIANCE", retentionDays: 30 },
      },
    });

    await expect(secured.checkHealth()).rejects.toThrow("object-lock retention");
  });

  it("creates the configured bucket with a signed path-style request", async () => {
    const fetchStub = createFetchStub();

    await storage(fetchStub.fetch).ensureBucket();

    expect(fetchStub.calls).toHaveLength(1);
    const [url, init] = firstUrlCall(fetchStub);
    expect(url.pathname).toBe("/helix-objects/");
    expect(init.method).toBe("PUT");
    const headers = requestHeaders(init);
    expect(headers.authorization).toContain(
      "AWS4-HMAC-SHA256 Credential=test-access/20260520/us-east-1/s3/aws4_request",
    );
    expect(headers).toMatchObject({
      host: "rustfs.local:9000",
      "x-amz-content-sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "x-amz-date": "20260520T123456Z",
      "x-amz-security-token": "test-token",
    });
  });

  it("treats already-owned buckets as ready", async () => {
    const fetchStub = createFetchStub(() => {
      return new Response("<Error><Code>BucketAlreadyOwnedByYou</Code></Error>", {
        status: 409,
        statusText: "Conflict",
      });
    });

    await expect(storage(fetchStub.fetch).ensureBucket()).resolves.toBeUndefined();
  });

  it("puts objects through a signed path-style request", async () => {
    const fetchStub = createFetchStub();

    await storage(fetchStub.fetch).put({
      key: "org-1/file name.txt",
      body: new TextEncoder().encode("hello"),
      contentType: "text/plain",
      metadata: { Plugin: "demo" },
    });

    expect(fetchStub.calls).toHaveLength(1);
    const [url, init] = firstUrlCall(fetchStub);
    expect(url.pathname).toBe("/helix-objects/org-1/file%20name.txt");
    expect(init.method).toBe("PUT");
    expect(init.body).toBeInstanceOf(Blob);
    expect(new Uint8Array(await (init.body as Blob).arrayBuffer())).toEqual(
      new TextEncoder().encode("hello"),
    );
    const headers = requestHeaders(init);
    expect(headers.authorization).toContain(
      "AWS4-HMAC-SHA256 Credential=test-access/20260520/us-east-1/s3/aws4_request",
    );
    expect(headers).toMatchObject({
      "content-type": "text/plain",
      host: "rustfs.local:9000",
      "x-amz-checksum-sha256": "LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=",
      "x-amz-content-sha256": "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      "x-amz-date": "20260520T123456Z",
      "x-amz-meta-plugin": "demo",
      "x-amz-security-token": "test-token",
    });
  });

  it("gets objects and maps S3 metadata into the SDK storage shape", async () => {
    const fetchStub = createFetchStub(() => {
      return new Response("payload", {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-amz-meta-owner": "agent-1",
        },
      });
    });

    const object = await storage(fetchStub.fetch).get("result.json");

    expect(object).toEqual({
      key: "result.json",
      body: new TextEncoder().encode("payload"),
      contentType: "application/json",
      metadata: { owner: "agent-1" },
    });
    expect(firstUrlCall(fetchStub)[1].method).toBe("GET");
  });

  it("heads and streams only a requested large-object range", async () => {
    const fetchStub = createFetchStub((_input, init) =>
      init?.method === "HEAD"
        ? new Response(null, {
            status: 200,
            headers: { "content-length": String(20 * 1024 ** 3), etag: '"large-etag"' },
          })
        : new Response("range-bytes", { status: 206 }),
    );
    const client = storage(fetchStub.fetch);

    await expect(client.head("large.bin")).resolves.toMatchObject({
      byteSize: 20 * 1024 ** 3,
      etag: '"large-etag"',
    });
    const ranged = await client.getRange("large.bin", 10 * 1024 ** 3, 10 * 1024 ** 3 + 10);
    const chunks: Uint8Array[] = [];
    if (ranged?.body instanceof Uint8Array) chunks.push(ranged.body);
    else if (ranged !== null) for await (const chunk of ranged.body) chunks.push(chunk);

    expect(Buffer.concat(chunks).toString()).toBe("range-bytes");
    expect(requestHeaders(fetchStub.calls[1]?.[1] ?? {}).range).toBe(
      "bytes=10737418240-10737418250",
    );
  });

  it("uses server-side copy without downloading bytes", async () => {
    const fetchStub = createFetchStub(
      () =>
        new Response("<CopyObjectResult><ETag>&quot;copied&quot;</ETag></CopyObjectResult>", {
          status: 200,
        }),
    );
    await storage(fetchStub.fetch, {
      serverSideEncryption: "aws:kms",
      serverSideEncryptionAwsKmsKeyId: "rotated-kms-key",
    }).copy("staged/file.bin", "blobs/hash");
    const [, init] = firstUrlCall(fetchStub);
    expect(init.method).toBe("PUT");
    expect(init.body).toBeUndefined();
    expect(requestHeaders(init)["x-amz-copy-source"]).toBe("/helix-objects/staged/file.bin");
    expect(requestHeaders(init)["x-amz-server-side-encryption-aws-kms-key-id"]).toBe(
      "rotated-kms-key",
    );
  });

  it("sends configurable SSE-S3 headers on signed PUT requests", async () => {
    const fetchStub = createFetchStub();

    await storage(fetchStub.fetch, { serverSideEncryption: "AES256" }).put({
      key: "encrypted.txt",
      body: new TextEncoder().encode("encrypted"),
      contentType: "text/plain",
    });

    const headers = requestHeaders(firstUrlCall(fetchStub)[1]);
    expect(headers["x-amz-server-side-encryption"]).toBe("AES256");
    expect(signedHeaders(firstUrlCall(fetchStub)[1])).toContain("x-amz-server-side-encryption");
  });

  it("sends configurable SSE-KMS headers on signed PUT requests", async () => {
    const fetchStub = createFetchStub();

    await storage(fetchStub.fetch, {
      serverSideEncryption: "aws:kms",
      serverSideEncryptionAwsKmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/test",
    }).put({
      key: "encrypted-kms.txt",
      body: new TextEncoder().encode("encrypted"),
      contentType: "text/plain",
    });

    const headers = requestHeaders(firstUrlCall(fetchStub)[1]);
    expect(headers["x-amz-server-side-encryption"]).toBe("aws:kms");
    expect(headers["x-amz-server-side-encryption-aws-kms-key-id"]).toBe(
      "arn:aws:kms:us-east-1:123456789012:key/test",
    );
    expect(signedHeaders(firstUrlCall(fetchStub)[1])).toEqual(
      expect.arrayContaining([
        "x-amz-server-side-encryption",
        "x-amz-server-side-encryption-aws-kms-key-id",
      ]),
    );
  });

  it("sends real S3 Object Lock retention headers for immutable uploads", async () => {
    const fetchStub = createFetchStub();

    await storage(fetchStub.fetch).putObjectLocked(
      { key: "audit/locked.json", body: new TextEncoder().encode("audit") },
      { mode: "COMPLIANCE", retainUntil: "2033-05-20T12:34:56.000Z" },
    );

    expect(requestHeaders(firstUrlCall(fetchStub)[1])).toMatchObject({
      "x-amz-object-lock-mode": "COMPLIANCE",
      "x-amz-object-lock-retain-until-date": "2033-05-20T12:34:56Z",
    });
    expect(signedHeaders(firstUrlCall(fetchStub)[1])).toEqual(
      expect.arrayContaining(["x-amz-object-lock-mode", "x-amz-object-lock-retain-until-date"]),
    );
  });

  it("returns null for missing objects", async () => {
    const fetchStub = createFetchStub(() => new Response(null, { status: 404 }));

    await expect(storage(fetchStub.fetch).get("missing")).resolves.toBeNull();
  });

  it("paginates object keys under a prefix", async () => {
    let page = 0;
    const fetchStub = createFetchStub(() => {
      page += 1;
      return new Response(
        page === 1
          ? "<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>next</NextContinuationToken><Contents><Key>audit/1.json</Key></Contents><Contents><Key></Key></Contents></ListBucketResult>"
          : "<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>audit/2.json</Key></Contents></ListBucketResult>",
        { status: 200 },
      );
    });

    const keys: string[] = [];
    for await (const key of storage(fetchStub.fetch).listKeys("audit/")) keys.push(key);

    expect(keys).toEqual(["audit/1.json", "audit/2.json"]);
    expect(fetchStub.calls).toHaveLength(2);
    expect(firstUrlCall(fetchStub)[0].searchParams.get("prefix")).toBe("audit/");
    expect(urlCall(fetchStub, 1)[0].searchParams.get("continuation-token")).toBe("next");
  });

  it("rejects a truncated object listing without a continuation token", async () => {
    const fetchStub = createFetchStub(
      () => new Response("<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>"),
    );

    const collect = async () => {
      for await (const key of storage(fetchStub.fetch).listKeys("audit/")) void key;
    };
    await expect(collect()).rejects.toMatchObject({
      name: "S3CompatibleStorageError",
      status: 502,
    });
  });

  it("deletes objects through a signed request", async () => {
    const fetchStub = createFetchStub(() => new Response(null, { status: 204 }));

    await storage(fetchStub.fetch).delete("old-key");

    const [url, init] = firstUrlCall(fetchStub);
    expect(url.pathname).toBe("/helix-objects/old-key");
    expect(init.method).toBe("DELETE");
    expect(signedHeaders(init)).toEqual(
      expect.arrayContaining(["host", "x-amz-content-sha256", "x-amz-security-token"]),
    );
  });

  it("creates deterministic presigned URLs without making a network call", async () => {
    const fetchStub = createFetchStub();

    const url = new URL(
      await storage(fetchStub.fetch).presignPutUrl("uploads/report.csv", {
        expiresSeconds: 60,
        contentType: "text/csv",
        metadata: { source: "test" },
      }),
    );

    expect(fetchStub.calls).toHaveLength(0);
    expect(url.origin).toBe("http://rustfs.local:9000");
    expect(url.pathname).toBe("/helix-objects/uploads/report.csv");
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Credential")).toBe(
      "test-access/20260520/us-east-1/s3/aws4_request",
    );
    expect(url.searchParams.get("X-Amz-Date")).toBe("20260520T123456Z");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("60");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-type;host;x-amz-meta-source");
    expect(url.searchParams.get("X-Amz-Security-Token")).toBe("test-token");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("signs configurable SSE-S3 headers into presigned PUT URLs", async () => {
    const fetchStub = createFetchStub();

    const url = new URL(
      await storage(fetchStub.fetch, { serverSideEncryption: "AES256" }).presignPutUrl(
        "uploads/encrypted.csv",
        {
          expiresSeconds: 60,
          contentType: "text/csv",
        },
      ),
    );

    expect(fetchStub.calls).toHaveLength(0);
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe(
      "content-type;host;x-amz-server-side-encryption",
    );
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns required signed headers for SSE-S3 presigned PUT requests", async () => {
    const fetchStub = createFetchStub();

    const request = await storage(fetchStub.fetch, {
      serverSideEncryption: "AES256",
    }).presignPutRequest("uploads/encrypted.csv", {
      expiresSeconds: 60,
      contentType: "text/csv",
      metadata: { source: "test" },
    });

    expect(fetchStub.calls).toHaveLength(0);
    expect(new URL(request.url).searchParams.get("X-Amz-SignedHeaders")).toBe(
      "content-type;host;x-amz-meta-source;x-amz-server-side-encryption",
    );
    expect(request.headers).toEqual({
      "content-type": "text/csv",
      "x-amz-meta-source": "test",
      "x-amz-server-side-encryption": "AES256",
    });
  });

  it("signs configurable SSE-KMS headers into presigned PUT URLs", async () => {
    const fetchStub = createFetchStub();

    const url = new URL(
      await storage(fetchStub.fetch, {
        serverSideEncryption: "aws:kms",
        serverSideEncryptionAwsKmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/test",
      }).presignPutUrl("uploads/encrypted-kms.csv", {
        expiresSeconds: 60,
        contentType: "text/csv",
      }),
    );

    expect(fetchStub.calls).toHaveLength(0);
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe(
      "content-type;host;x-amz-server-side-encryption;x-amz-server-side-encryption-aws-kms-key-id",
    );
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns required signed headers for SSE-KMS presigned PUT requests", async () => {
    const fetchStub = createFetchStub();

    const request = await storage(fetchStub.fetch, {
      serverSideEncryption: "aws:kms",
      serverSideEncryptionAwsKmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/test",
    }).presignPutRequest("uploads/encrypted-kms.csv", {
      expiresSeconds: 60,
      contentType: "text/csv",
    });

    expect(fetchStub.calls).toHaveLength(0);
    expect(new URL(request.url).searchParams.get("X-Amz-SignedHeaders")).toBe(
      "content-type;host;x-amz-server-side-encryption;x-amz-server-side-encryption-aws-kms-key-id",
    );
    expect(request.headers).toEqual({
      "content-type": "text/csv",
      "x-amz-server-side-encryption": "aws:kms",
      "x-amz-server-side-encryption-aws-kms-key-id": "arn:aws:kms:us-east-1:123456789012:key/test",
    });
  });

  it("throws a typed error for failed object operations", async () => {
    const fetchStub = createFetchStub(
      () =>
        new Response("remote-body-secret", {
          status: 403,
          statusText: "remote-status-secret",
        }),
    );

    const failure = await storage(fetchStub.fetch)
      .delete("blocked")
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      name: "S3CompatibleStorageError",
      status: 403,
    } satisfies Partial<S3CompatibleStorageError>);
    expect(String(failure)).not.toMatch(/remote-(?:body|status)-secret/u);
  });

  it("createMultipartUpload POSTs ?uploads and parses UploadId", async () => {
    const fetchStub = createFetchStub(
      () =>
        new Response(
          '<?xml version="1.0"?><InitiateMultipartUploadResult><UploadId>abc-123</UploadId></InitiateMultipartUploadResult>',
          { status: 200 },
        ),
    );
    const result = await storage(fetchStub.fetch).createMultipartUpload("drive/o/x.bin", {
      contentType: "application/octet-stream",
    });
    expect(result).toEqual({ uploadId: "abc-123" });
    const [url, init] = firstUrlCall(fetchStub);
    expect(init.method).toBe("POST");
    expect(url.searchParams.has("uploads")).toBe(true);
  });

  it("presignUploadPart signs partNumber and uploadId", async () => {
    const fetchStub = createFetchStub();
    const url = await storage(fetchStub.fetch).presignUploadPart("drive/o/x.bin", "up-1", 2);
    expect(fetchStub.calls).toHaveLength(0);
    const parsed = new URL(url);
    expect(parsed.searchParams.get("partNumber")).toBe("2");
    expect(parsed.searchParams.get("uploadId")).toBe("up-1");
    expect(parsed.searchParams.get("X-Amz-Signature")).toBeTruthy();
  });

  it("completeMultipartUpload POSTs CompleteMultipartUpload XML", async () => {
    const fetchStub = createFetchStub(
      () =>
        new Response(
          "<CompleteMultipartUploadResult><Bucket>helix-objects</Bucket><Key>drive/o/x.bin</Key><ETag>&quot;done&quot;</ETag></CompleteMultipartUploadResult>",
          { status: 200 },
        ),
    );
    await storage(fetchStub.fetch).completeMultipartUpload("drive/o/x.bin", "up-1", [
      { partNumber: 1, etag: '"etag1"' },
      { partNumber: 2, etag: '"etag2"' },
    ]);
    const [url, init] = firstUrlCall(fetchStub);
    expect(init.method).toBe("POST");
    expect(url.searchParams.get("uploadId")).toBe("up-1");
    const body =
      typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body as Uint8Array);
    expect(body).toContain("<CompleteMultipartUpload ");
    expect(body).toContain("<PartNumber>1</PartNumber>");
    expect(body).toContain("<ETag>&quot;etag1&quot;</ETag>");
  });

  it("retries transient S3 failures within the configured attempt budget", async () => {
    let attempts = 0;
    const fetchStub = createFetchStub(() => {
      attempts += 1;
      return attempts < 3
        ? new Response("<Error><Code>ServiceUnavailable</Code></Error>", { status: 503 })
        : new Response(null, { status: 204 });
    });

    await storage(fetchStub.fetch, { maxAttempts: 3 }).delete("retry-me");

    expect(fetchStub.calls).toHaveLength(3);
  });

  it("aborts requests at the configured operation deadline", async () => {
    const fetchStub = createFetchStub((_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const abort = () => {
          reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
        };
        if (signal?.aborted === true) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    });

    await expect(
      storage(fetchStub.fetch, { maxAttempts: 3, requestTimeoutMs: 20 }).delete("too-slow"),
    ).rejects.toMatchObject({ name: "S3CompatibleStorageError", status: 502 });
    expect(fetchStub.calls).toHaveLength(1);
  });

  it("rejects an S3 error embedded in an HTTP-200 multipart completion", async () => {
    const fetchStub = createFetchStub(
      () =>
        new Response(
          "<Error><Code>InternalError</Code><Message>completion failed</Message></Error>",
          {
            status: 200,
          },
        ),
    );

    await expect(
      storage(fetchStub.fetch, { maxAttempts: 1 }).completeMultipartUpload(
        "drive/o/x.bin",
        "up-1",
        [{ partNumber: 1, etag: '"etag1"' }],
      ),
    ).rejects.toMatchObject({
      name: "S3CompatibleStorageError",
      status: 503,
      causeName: "InternalError",
    });
  });
});
